package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
)

// TestGuestPrincipalCreationIsPinned pins the path-2 stable guest identity.
//
// A guest browser calls POST /api/aerun/guest/principal once and receives an
// HttpOnly cookie carrying `guest_id:secret`. The server stores only the
// sha256 hash. A second call with the same cookie is a no-op (reissued=false)
// — the principal is pinned to the first browser that claimed it, and a
// different browser gets a DIFFERENT principal. A tampered cookie verifies
// against nothing and simply degrades to guest-without-a-principal.
func TestGuestPrincipalCreationIsPinned(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	server := newTestServer(t, app)
	defer server.Close()

	post := func(cookie string, keySuffix string) (int, []byte, *http.Response) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, server.URL+"/api/aerun/guest/principal", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "idem-guest-principal-"+keySuffix)
		if cookie != "" {
			req.Header.Set("Cookie", guestPrincipalCookieName+"="+cookie)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, body, res
	}

	// First call: no cookie, a fresh principal is issued with 201.
	status, body, res := post("", "first")
	if status != http.StatusCreated {
		t.Fatalf("first principal create: status=%d body=%s", status, body)
	}
	var first struct {
		GuestID  string `json:"guest_id"`
		Reissued bool   `json:"reissued"`
	}
	if err := json.Unmarshal(body, &first); err != nil || first.GuestID == "" {
		t.Fatalf("first principal response must carry guest_id: %v %s", err, body)
	}
	if !first.Reissued {
		t.Fatal("first creation must report reissued=true")
	}

	setCookies := res.Cookies()
	var capCookie *http.Cookie
	for _, c := range setCookies {
		if c.Name == guestPrincipalCookieName {
			capCookie = c
			break
		}
	}
	if capCookie == nil {
		t.Fatal("creation must set the HttpOnly capability cookie")
	}
	if !capCookie.HttpOnly {
		t.Fatal("capability cookie must be HttpOnly")
	}
	if _, _, ok := parseGuestPrincipalCookie(capCookie.Value); !ok {
		t.Fatalf("cookie value must be guest_id:secret, got %q", capCookie.Value)
	}

	// The server stores only the hash, never the plaintext secret.
	row, err := app.FindFirstRecordByFilter(guestPrincipalsCollectionName, "guest_id = {:id}", dbx.Params{"id": first.GuestID})
	if err != nil || row == nil {
		t.Fatalf("principal row missing: %v", err)
	}
	if got := row.GetString("capability_hash"); got == "" || strings.Contains(capCookie.Value, got) {
		t.Fatalf("capability_hash must be a non-empty digest that never appears in the cookie, got %q", got)
	}

	// Second call with the same cookie: 200 no-op, same principal, no new cookie.
	status, body2, res2 := post(capCookie.Value, "repeat")
	if status != http.StatusOK {
		t.Fatalf("repeat with the same cookie: status=%d body=%s", status, body2)
	}
	var second struct {
		GuestID  string `json:"guest_id"`
		Reissued bool   `json:"reissued"`
	}
	if err := json.Unmarshal(body2, &second); err != nil || second.GuestID != first.GuestID {
		t.Fatalf("repeat must return the SAME principal: %v %s", err, body2)
	}
	if second.Reissued {
		t.Fatal("repeat must report reissued=false")
	}
	for _, c := range res2.Cookies() {
		if c.Name == guestPrincipalCookieName {
			t.Fatal("repeat must NOT set a new cookie")
		}
	}

	// A different browser (no cookie) gets a DIFFERENT principal.
	status, body3, _ := post("", "second-browser")
	if status != http.StatusCreated {
		t.Fatalf("second browser create: status=%d body=%s", status, body3)
	}
	var third struct {
		GuestID string `json:"guest_id"`
	}
	if err := json.Unmarshal(body3, &third); err != nil || third.GuestID == "" || third.GuestID == first.GuestID {
		t.Fatalf("a different browser must get a different principal: %v %s", err, body3)
	}

	// A tampered cookie verifies against nothing and is simply ignored: the
	// request gets a FRESH principal rather than an error or someone else's.
	status, body4, _ := post(first.GuestID+":tampered-secret", "tampered")
	if status != http.StatusCreated {
		t.Fatalf("tampered cookie create: status=%d body=%s", status, body4)
	}
	var fourth struct {
		GuestID string `json:"guest_id"`
	}
	if err := json.Unmarshal(body4, &fourth); err != nil || fourth.GuestID == "" || fourth.GuestID == first.GuestID {
		t.Fatalf("tampered cookie must yield a fresh principal, not the victim's: %v %s", err, body4)
	}
}
