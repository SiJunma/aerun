package pocketbase

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Sprint 3 task 5 — the idempotency middleware (plan invariant 6).
//
// Every mutating /api/aerun request must carry an `Idempotency-Key` header.
// The middleware:
//
//  1. validates the key and hashes (method, path, body) into a request hash;
//  2. replays a previously stored successful response byte-for-byte when the
//     same (actor, key) already completed with the same hash — the response
//     then carries `Idempotency-Replayed: true`;
//  3. rejects a key reuse with a *different* payload as a 409 conflict;
//  4. otherwise stores the claim in the request context so the command can
//     commit its idempotency record in the SAME transaction as the domain
//     write (runCommand) — a concurrent duplicate loses the UNIQUE race, its
//     whole transaction rolls back and it replays the winner's response
//     instead of applying the action twice.
//
// Only successful commands store a record; failed commands roll back with
// no side effects, so a client may safely retry them with the same key.
const (
	idempotencyHeader      = "Idempotency-Key"
	idempotencyReplayHdr   = "Idempotency-Replayed"
	idempotencyClaimKey    = "aerunIdemClaim"
	idempotencyCollection  = "idempotency_keys"
	idempotencyMaxBodyByte = 512 * 1024
)

// idempotencyKeyPattern mirrors the request-id pattern: header-safe ASCII,
// so a key can never smuggle whitespace or separators into stored rows.
var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,255}$`)

// errIdempotentReplay is the sentinel a command transaction returns when its
// idempotency INSERT lost the UNIQUE race; runCommand converts it into a
// replay of the winner's stored response.
var errIdempotentReplay = errors.New("idempotency: concurrent duplicate key")

// forumCommandMu serialises the command transactions of this process. The
// target topology is a single PocketBase/SQLite writer (plan §1: one VPS,
// one authoritative store), and SQLite allows exactly one write transaction
// at a time anyway — the gate turns potential SQLITE_BUSY failures into
// deterministic queueing. The UNIQUE (topic_id, sequence) and (actor, key)
// indexes remain the hard correctness backstop if a second process ever
// writes to the same data dir.
var forumCommandMu sync.Mutex

// idemClaim identifies one logical command attempt.
type idemClaim struct {
	Actor string
	Key   string
	Hash  string
}

// idemEnvelope is the stored shape of idempotency_keys.response_json. Body
// keeps the exact response bytes so replays are byte-identical to the
// original result (plan invariant 6).
type idemEnvelope struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// idemStored is a decoded lookup result.
type idemStored struct {
	Hash   string
	Status int
	Body   json.RawMessage
}

// commandOutcome is what runCommand reports back to the handler: either the
// fresh response (Replayed=false) or a stored one to write verbatim.
type commandOutcome struct {
	Status   int
	Body     json.RawMessage
	Replayed bool
}

// enforceIdempotency is the route middleware described above. It is bound
// per mutation route AFTER RequirePermission, so authentication/authorisation
// failures still win over transport-contract failures.
func enforceIdempotency(e *core.RequestEvent) error {
	switch e.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return e.Next()
	}

	key := strings.TrimSpace(e.Request.Header.Get(idempotencyHeader))
	if key == "" {
		return validationError("Idempotency-Key header is required for mutating requests")
	}
	if !idempotencyKeyPattern.MatchString(key) {
		return validationError("Idempotency-Key header must match [A-Za-z0-9_.:-]{1,255}")
	}

	// Buffer the body once: the hash needs it and every downstream handler
	// must be able to read it again. The size cap mirrors the command-level
	// body limits; per-route limits still apply on top.
	raw, err := readBodyLimited(e, idempotencyMaxBodyByte)
	if err != nil {
		return err
	}
	e.Request.Body = io.NopCloser(bytes.NewReader(raw))

	actor := "guest"
	if e.Auth != nil {
		actor = e.Auth.Id
	}
	claim := idemClaim{Actor: actor, Key: key, Hash: requestHash(e.Request.Method, e.Request.URL.Path, raw)}

	stored, found, err := lookupIdempotency(e.App, claim)
	if err != nil {
		return internalError("idempotency lookup failed", err)
	}
	if found {
		if stored.Hash != claim.Hash {
			return conflictError("Idempotency-Key was reused with a different request payload")
		}
		return writeStoredResponse(e, stored.Status, stored.Body)
	}

	e.Set(idempotencyClaimKey, claim)
	return e.Next()
}

// claimFrom returns the claim the idempotency middleware attached to the
// request. Handlers must not run a command without it.
func claimFrom(e *core.RequestEvent) (idemClaim, error) {
	claim, ok := e.Get(idempotencyClaimKey).(idemClaim)
	if !ok || claim.Key == "" {
		return idemClaim{}, validationError("Idempotency-Key claim is missing; the idempotency middleware must run before the handler")
	}
	return claim, nil
}

// requestHash pins method+path+body: the same key may only ever describe
// this exact command invocation.
func requestHash(method, path string, body []byte) string {
	sum := sha256.Sum256([]byte(method + "\n" + path + "\n" + string(body)))
	return hex.EncodeToString(sum[:])
}

// lookupIdempotency finds the stored record for the claim. A missing row is
// not an error (the common first-attempt path); a corrupt stored envelope
// is reported so a broken row can never silently disable the contract.
func lookupIdempotency(app core.App, claim idemClaim) (idemStored, bool, error) {
	record, err := app.FindFirstRecordByFilter(
		idempotencyCollection,
		"actor = {:actor} && key = {:key}",
		dbx.Params{"actor": claim.Actor, "key": claim.Key},
	)
	if err != nil {
		// FindFirstRecordByFilter reports "no rows" as a plain error and
		// that is the normal first-request case. A real database failure
		// would surface again at the UNIQUE insert inside runCommand, where
		// it aborts the transaction instead of failing open.
		return idemStored{}, false, nil //nolint:nilerr // see comment above
	}
	var envelope idemEnvelope
	if err := json.Unmarshal([]byte(record.GetString("response_json")), &envelope); err != nil {
		return idemStored{}, false, fmt.Errorf("stored idempotency envelope is corrupt: %w", err)
	}
	return idemStored{
		Hash:   record.GetString("request_hash"),
		Status: envelope.Status,
		Body:   envelope.Body,
	}, true, nil
}

// runCommand executes fn inside ONE transaction together with the
// idempotency record for claim (plan invariants 1 and 6):
//
//   - fn returns (httpStatus, responsePayload, error);
//   - on success the payload is marshalled once, stored in the envelope and
//     committed with the domain writes — nothing external is observable
//     before the commit;
//   - losing the UNIQUE(actor, key) race rolls the whole transaction back
//     and replays the winner's stored response;
//   - fn errors roll the transaction back and store nothing, so the caller
//     may retry with the same key.
func runCommand(app core.App, claim idemClaim, fn func(txApp core.App) (int, any, error)) (commandOutcome, error) {
	var out commandOutcome

	if claim.Key == "" || claim.Actor == "" {
		return out, internalError("command executed without an idempotency claim", nil)
	}

	forumCommandMu.Lock()
	defer forumCommandMu.Unlock()

	err := app.RunInTransaction(func(txApp core.App) error {
		status, payload, err := fn(txApp)
		if err != nil {
			return err
		}
		body, err := json.Marshal(payload)
		if err != nil {
			return internalError("command response could not be encoded", err)
		}
		envelope, err := json.Marshal(idemEnvelope{Status: status, Body: body})
		if err != nil {
			return internalError("idempotency envelope could not be encoded", err)
		}

		collection, err := txApp.FindCollectionByNameOrId(idempotencyCollection)
		if err != nil {
			return internalError("idempotency collection is unavailable", err)
		}
		record := core.NewRecord(collection)
		record.Set("actor", claim.Actor)
		record.Set("key", claim.Key)
		record.Set("request_hash", claim.Hash)
		record.Set("response_json", string(envelope))
		record.Set("status", "completed")
		if err := txApp.Save(record); err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") &&
				strings.Contains(err.Error(), idempotencyCollection) {
				return errIdempotentReplay
			}
			return err
		}

		out = commandOutcome{Status: status, Body: body}
		return nil
	})

	if errors.Is(err, errIdempotentReplay) {
		stored, found, lookupErr := lookupIdempotency(app, claim)
		if lookupErr != nil || !found {
			return commandOutcome{}, internalError("concurrent idempotency record disappeared before replay", err)
		}
		if stored.Hash != claim.Hash {
			return commandOutcome{}, conflictError("Idempotency-Key was reused with a different request payload")
		}
		return commandOutcome{Status: stored.Status, Body: stored.Body, Replayed: true}, nil
	}
	if err != nil {
		return commandOutcome{}, err
	}
	return out, nil
}

// writeCommandResult sends a runCommand outcome: fresh responses and
// replays both go out as the exact stored bytes, replays flagged with
// Idempotency-Replayed.
func writeCommandResult(e *core.RequestEvent, out commandOutcome, err error) error {
	if err != nil {
		return err
	}
	if out.Replayed {
		return writeStoredResponse(e, out.Status, out.Body)
	}
	return writeJSON(e, out.Status, out.Body)
}

// writeStoredResponse writes a previously stored response verbatim.
func writeStoredResponse(e *core.RequestEvent, status int, body json.RawMessage) error {
	e.Response.Header().Set(idempotencyReplayHdr, "true")
	return writeJSON(e, status, body)
}

// writeJSON writes pre-marshalled JSON with the exact bytes the command
// committed to its idempotency envelope (json.Marshal on maps is
// deterministic, so first responses and replays match byte for byte).
func writeJSON(e *core.RequestEvent, status int, body json.RawMessage) error {
	e.Response.Header().Set("Content-Type", "application/json")
	e.Response.WriteHeader(status)
	_, err := e.Response.Write(body)
	return err
}
