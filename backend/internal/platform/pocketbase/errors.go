package pocketbase

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// Sprint 3 task 5 — the shared /api/aerun error contract.
//
// Every error leaving the command group carries four machine-readable flags
// plus a stable kind inside the standard PocketBase error envelope:
//
//		{ "data": { "retryable": bool, "conflict": bool, "forbidden": bool,
//		            "validation": bool, "kind": string, "request_id": string },
//		  "message": "...", "status": ... }
//
//	  - validation: the request itself is wrong (fix the payload, do not
//	    blindly retry);
//	  - conflict: the request is well-formed but the current resource state
//	    rejects it (locked topic, idempotency-key reuse, ...);
//	  - forbidden: authentication/authorisation failed (401/403);
//	  - retryable: retrying the identical request later may succeed (5xx,
//	    rate limits).
//
// Command constructors set `kind` explicitly; errorContractMiddleware fills
// any missing flag from the status code, so errors raised deep inside
// PocketBase (bad JSON, missing records, ...) still honour the contract.
const (
	errKindValidation   = "validation"
	errKindConflict     = "conflict"
	errKindForbidden    = "forbidden"
	errKindUnauthorized = "unauthorized"
	errKindNotFound     = "not_found"
	errKindRateLimited  = "rate_limited"
	errKindInternal     = "internal"
	errKindUnknown      = "error"
)

// buildVersion is injected at link time via -ldflags "-X ...buildVersion=...".
// It ships with every server error so an operator can tell at a glance
// whether a failure comes from the running binary code or from a stale
// build / unapplied schema. Defaults to "dev" for local runs.
var buildVersion = "dev"

// newContractError builds an ApiError with an explicit contract kind. The
// four boolean flags are derived from the kind by errorContractMiddleware,
// so constructors only describe *what* went wrong, never how to flag it.
func newContractError(status int, kind, message string, cause any) *router.ApiError {
	apiErr := router.NewApiError(status, message, cause)
	if apiErr.Data == nil {
		apiErr.Data = map[string]any{}
	}
	apiErr.Data["kind"] = kind
	return apiErr
}

func validationError(message string) error {
	return newContractError(http.StatusBadRequest, errKindValidation, message, nil)
}

func conflictError(message string) error {
	return newContractError(http.StatusConflict, errKindConflict, message, nil)
}

func forbiddenError(message string) error {
	return newContractError(http.StatusForbidden, errKindForbidden, message, nil)
}

// note: there is deliberately no unauthorizedError constructor. A 401 on the
// command routes is produced by the router helper at the point of refusal
// (RequirePermission / access_routes), which already sets the envelope the
// contract middleware then fills in; a second constructor here would only give
// two spellings of the same response.
func notFoundError(message string) error {
	return newContractError(http.StatusNotFound, errKindNotFound, message, nil)
}

func internalError(message string, cause any) error {
	return newContractError(http.StatusInternalServerError, errKindInternal, message, cause)
}

// rateLimitedError reports that the caller exhausted its write budget. The
// contract marks rate_limited as retryable, so a client learns the identical
// request may succeed later instead of treating it as a payload problem.
func rateLimitedError(message string) error {
	return newContractError(http.StatusTooManyRequests, errKindRateLimited, message, nil)
}

// accountDeletedError reports that the caller's own account was deleted.
//
// It is a FORBIDDEN with a machine-readable marker, because the client has to
// end the session on the strength of the response itself (owner ruling
// 2026-10-19) rather than wait for the next 401 to tell it what happened.
// A deleted account and an ordinary forbidden look identical on the wire
// without the marker, and the member deserves to be told which one it is.
func accountDeletedError(message string) error {
	apiErr := newContractError(http.StatusForbidden, errKindForbidden, message, nil)
	if apiErr.Data == nil {
		apiErr.Data = map[string]any{}
	}
	apiErr.Data["account_deleted"] = true
	return apiErr
}

// errorContractMiddleware wraps the whole /api/aerun group: it converts the
// error returned by the inner chain into the contract envelope. It is bound
// after the AccessResolver and before the idempotency middleware, so both
// of those (and every handler/permission error below them) are shaped by it.
func errorContractMiddleware(e *core.RequestEvent) error {
	if err := e.Next(); err != nil {
		return applyErrorContract(e, err)
	}
	return nil
}

// applyErrorContract normalises err into a contract ApiError without losing
// any payload the original error already carried (e.g. PocketBase field
// validation details stay in Data alongside the contract flags).
func applyErrorContract(e *core.RequestEvent, err error) error {
	apiErr := router.ToApiError(err)
	if apiErr.Data == nil {
		apiErr.Data = map[string]any{}
	}

	kind, ok := apiErr.Data["kind"].(string)
	if !ok || kind == "" {
		kind = kindForStatus(apiErr.Status)
		apiErr.Data["kind"] = kind
	}
	if _, ok := apiErr.Data["retryable"]; !ok {
		apiErr.Data["retryable"] = kind == errKindInternal || kind == errKindRateLimited
	}
	if _, ok := apiErr.Data["conflict"]; !ok {
		apiErr.Data["conflict"] = kind == errKindConflict
	}
	if _, ok := apiErr.Data["forbidden"]; !ok {
		apiErr.Data["forbidden"] = kind == errKindForbidden || kind == errKindUnauthorized
	}
	if _, ok := apiErr.Data["validation"]; !ok {
		apiErr.Data["validation"] = kind == errKindValidation
	}
	apiErr.Data["request_id"] = requestIDFrom(e)
	apiErr.Data["build"] = buildVersion
	return apiErr
}

// kindForStatus maps a plain HTTP status onto the contract kind for errors
// that were raised without an explicit kind (PocketBase internals, older
// constructors).
func kindForStatus(status int) string {
	switch {
	case status == http.StatusBadRequest,
		status == http.StatusRequestEntityTooLarge,
		status == http.StatusUnprocessableEntity:
		return errKindValidation
	case status == http.StatusUnauthorized:
		return errKindUnauthorized
	case status == http.StatusForbidden:
		return errKindForbidden
	case status == http.StatusNotFound:
		return errKindNotFound
	case status == http.StatusConflict:
		return errKindConflict
	case status == http.StatusTooManyRequests:
		return errKindRateLimited
	case status >= http.StatusInternalServerError:
		return errKindInternal
	default:
		return errKindUnknown
	}
}
