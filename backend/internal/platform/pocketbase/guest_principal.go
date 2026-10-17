package pocketbase

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// ---------------------------------------------------------------------------
// Guest principal: a stable, server-issued identity for anonymous visitors.
//
// A guest principal is the building block for guest content ownership without
// an account. It is created through POST /api/aerun/guest/principal, which
// sets an HttpOnly cookie carrying `guest_id:secret`. The server stores only
// capability_hash (sha256 of the secret) and never the plaintext secret, so a
// compromised database cannot impersonate a guest. The cookie is not re-issued
// on every request: once set, subsequent creation attempts are no-ops, which
// pins the principal to the first browser that claimed it and prevents cookie
// fixation attacks.
//
// Rows are unbounded in lifetime (unlike guest_presence, which is pruned): a
// guest principal is the durable anchor for everything a guest writes.
// ---------------------------------------------------------------------------

const (
	// guestPrincipalsCollectionName is the server-only collection that stores
	// anonymous visitor identities (created by 1770000003_guest_principal_schema).
	// Mirrors the migration constant; each package owns its own spelling by
	// repo convention (cf. topicsCollectionName vs topicsCollectionTable).
	guestPrincipalsCollectionName = "guest_principals"

	// guestPrincipalCookieName is the HttpOnly cookie that carries
	// `guest_id:secret`. The secret half is never stored in plaintext on the
	// server.
	guestPrincipalCookieName = "aerun_guest_cap"

	// guestPrincipalCookieTTL is how long the browser keeps the principal
	// cookie. A guest identity outlives a single tab session but is not
	// eternal: after a year of inactivity the browser drops it and a new
	// principal is issued on the next visit.
	guestPrincipalCookieTTL = 365 * 24 * time.Hour

	// guestSecretBytes is the entropy of the per-visitor capability secret.
	guestSecretBytes = 32
)

// guestPrincipalCookieValue marshals a principal into the opaque cookie value
// `guest_id:secret`. The client never sees the hash; it only round-trips the
// cookie value it received at creation time.
func guestPrincipalCookieValue(guestID, secret string) string {
	return guestID + ":" + secret
}

// parseGuestPrincipalCookie splits a cookie value into (guestID, secret).
func parseGuestPrincipalCookie(value string) (guestID, secret string, ok bool) {
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	guestID, secret = parts[0], parts[1]
	if guestID == "" || secret == "" {
		return "", "", false
	}
	return guestID, secret, true
}

// hashCapability returns the sha256 hex digest of a guest capability secret.
// The digest is what gets persisted; the plaintext secret only ever lives in
// the HttpOnly cookie and in the client's memory.
func hashCapability(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// newGuestPrincipal creates a fresh principal record with a server-generated
// guest id and secret, hashes the secret for persistence, and returns both
// the record and the plaintext secret (to be placed in the cookie exactly
// once).
func newGuestPrincipal(app core.App) (*core.Record, string, error) {
	guestID, err := makeGuestPrincipalID()
	if err != nil {
		return nil, "", fmt.Errorf("generate guest id: %w", err)
	}
	secret, err := makeGuestPrincipalSecret()
	if err != nil {
		return nil, "", fmt.Errorf("generate guest secret: %w", err)
	}

	col, err := app.FindCollectionByNameOrId(guestPrincipalsCollectionName)
	if err != nil || col == nil {
		return nil, "", fmt.Errorf("guest_principals collection unavailable: %w", err)
	}

	rec := core.NewRecord(col)
	rec.Set("guest_id", guestID)
	rec.Set("capability_hash", hashCapability(secret))
	rec.Set("last_used_at", nil)
	if err := app.Save(rec); err != nil {
		return nil, "", fmt.Errorf("save guest principal: %w", err)
	}
	return rec, secret, nil
}

// makeGuestPrincipalID generates a client-opaque, URL-safe guest id.
func makeGuestPrincipalID() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString(buf), nil
}

// makeGuestPrincipalSecret generates a high-entropy capability secret.
func makeGuestPrincipalSecret() (string, error) {
	buf := make([]byte, guestSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString(buf), nil
}

// guestPrincipalFromRequest extracts the authenticated guest principal from
// the HttpOnly cookie, verifying the capability hash against the stored row.
// It returns (nil, nil) when no cookie is present — the caller decides
// whether that is an error. A cookie whose hash does not match is treated as
// absent (never as an error), so a tampered cookie simply degrades to guest
// without a principal.
func guestPrincipalFromRequest(e *core.RequestEvent) (*core.Record, error) {
	cookie, err := e.Request.Cookie(guestPrincipalCookieName)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return nil, nil
		}
		return nil, nil
	}

	guestID, secret, ok := parseGuestPrincipalCookie(cookie.Value)
	if !ok {
		return nil, nil
	}

	col, err := e.App.FindCollectionByNameOrId(guestPrincipalsCollectionName)
	if err != nil || col == nil {
		return nil, nil
	}

	rec, err := e.App.FindFirstRecordByFilter(
		guestPrincipalsCollectionName,
		"guest_id = {:guestID}",
		dbx.Params{"guestID": guestID},
	)
	if err != nil || rec == nil {
		return nil, nil
	}

	storedHash := rec.GetString("capability_hash")
	if storedHash == "" || storedHash != hashCapability(secret) {
		return nil, nil
	}

	// Touch last_used_at so retention (if ever introduced) can distinguish
	// active principals from abandoned ones. Best-effort: a failed save must
	// not fail the request.
	if err := e.App.Save(rec); err != nil {
		e.App.Logger().Warn("guest principal last_used_at touch failed", "guest_id", guestID, "error", err)
	}

	return rec, nil
}

// guestPrincipalIDFromRequest returns the verified guest principal id from
// the HttpOnly cookie, or "" when none is present or the cookie is invalid.
func guestPrincipalIDFromRequest(e *core.RequestEvent) string {
	rec, err := guestPrincipalFromRequest(e)
	if err != nil || rec == nil {
		return ""
	}
	return rec.GetString("guest_id")
}

// setGuestPrincipalCookie writes the HttpOnly capability cookie. It is called
// exactly once, at principal creation; the browser round-trips the same value
// on every subsequent request and the server verifies it through
// guestPrincipalFromRequest.
func setGuestPrincipalCookie(e *core.RequestEvent, guestID, secret string) {
	secure := e.Request.TLS != nil
	http.SetCookie(e.Response, &http.Cookie{
		Name:     guestPrincipalCookieName,
		Value:    guestPrincipalCookieValue(guestID, secret),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   int(guestPrincipalCookieTTL.Seconds()),
	})
}

// clearGuestPrincipalCookie removes the capability cookie. Used on explicit
// guest sign-out (future) and in tests.
func clearGuestPrincipalCookie(e *core.RequestEvent) {
	http.SetCookie(e.Response, &http.Cookie{
		Name:     guestPrincipalCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   e.Request.TLS != nil,
		MaxAge:   -1,
	})
}

// createGuestPrincipalHandler creates a guest principal for the calling
// browser and sets the HttpOnly capability cookie. It is idempotent: if a
// valid cookie already exists, the request is a no-op that returns the
// existing principal without issuing a new cookie. This is the "not
// re-issued" guarantee of the ADR — a principal is pinned to the first
// browser that claimed it.
func createGuestPrincipalHandler(e *core.RequestEvent) error {
	// Not re-issued: if the browser already carries a valid principal cookie,
	// return it without touching the database or the cookie.
	if rec, err := guestPrincipalFromRequest(e); err == nil && rec != nil {
		return e.JSON(http.StatusOK, map[string]any{
			"guest_id":   rec.GetString("guest_id"),
			"request_id": requestIDFrom(e),
			"reissued":   false,
		})
	}

	rec, secret, err := newGuestPrincipal(e.App)
	if err != nil {
		return internalError("failed to create guest principal", err)
	}

	setGuestPrincipalCookie(e, rec.GetString("guest_id"), secret)

	return e.JSON(http.StatusCreated, map[string]any{
		"guest_id":   rec.GetString("guest_id"),
		"request_id": requestIDFrom(e),
		"reissued":   true,
	})
}

