package pocketbase

import (
	"regexp"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

// Request correlation: every response carries X-Request-ID (the caller's ID is
// echoed only when it is safe, otherwise a fresh one is generated) and
// handlers can attach the same ID to their structured logs. This is the
// Sprint 1 correlation groundwork for the frontend command contract (see
// BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md, "X-Request-ID for diagnostics").
const (
	requestIDHeader = "X-Request-ID"
	requestIDKey    = "aerunRequestId"
	requestIDMaxLen = 64
)

// requestIDPattern keeps correlation IDs header-safe: no whitespace, control
// or separator characters, so an untrusted caller value can never smuggle
// response splitting or log-forging content through the echo path.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// assignRequestID is a router middleware: it resolves the correlation ID for
// the current request, stores it in the request-scoped event store (read it
// back with requestIDFrom) and sets it as a response header before the
// request continues, so error responses carry it too.
func assignRequestID(e *core.RequestEvent) error {
	id := resolveRequestID(e.Request.Header.Get(requestIDHeader))
	e.Set(requestIDKey, id)
	e.Response.Header().Set(requestIDHeader, id)
	return e.Next()
}

// requestIDFrom returns the correlation ID assigned to this request, or an
// empty string when the middleware has not run.
func requestIDFrom(e *core.RequestEvent) string {
	id, _ := e.Get(requestIDKey).(string)
	return id
}

// resolveRequestID sanitizes an incoming caller-controlled correlation ID or
// generates a fresh crypto-random one. Anything outside the allowed pattern
// is replaced instead of echoed.
func resolveRequestID(incoming string) string {
	id := strings.TrimSpace(incoming)
	if id == "" || len(id) > requestIDMaxLen || !requestIDPattern.MatchString(id) {
		return security.RandomString(16)
	}
	return id
}
