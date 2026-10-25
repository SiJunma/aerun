package pocketbase

import (
	"log/slog"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	usersCollectionName = "users"
	rolesCollectionName = "roles"
	accessContextKey    = "aerunAccess"
)

// AccessContext is the resolved permission view of the current request:
// the forum role, the account status and the effective permission list.
// Unauthenticated requests resolve to the guest identity, which carries the
// global guest baseline (view_forum); category-level narrowing for guests
// arrives later with the category read models.
type AccessContext struct {
	Role        auth.Role
	Status      auth.Status
	Permissions []auth.Permission
	// Verified reports whether the caller's email has been confirmed. Guests
	// carry false; they have no email address to verify.
	//
	// It is a separate axis from Role and Status on purpose: "pending" and
	// "unverified" are different facts even though registration produces both
	// at once, and the write rules treat them differently — see
	// requireVerified.
	Verified bool
}

// CanPostGlobally reports whether this account may post outside a category
// that explicitly grants write access through its per-category override.
// Staff always pass (their mailbox problems must not lock the forum out of
// management). Everyone else needs active status AND a confirmed email.
// A guest context always returns false: guests have no email to verify and
// no global posting right — they may only write where a category names `guest`
// in its override.
func (acc AccessContext) CanPostGlobally() bool {
	if isStaff(acc) {
		return true
	}
	return acc.Status == auth.StatusActive && acc.Verified
}

// guestAccess is the context used when there is nothing to resolve.
func guestAccess() AccessContext {
	return AccessContext{
		Role:        auth.RoleGuest,
		Status:      auth.StatusActive,
		Permissions: auth.DefaultPermissions(auth.RoleGuest),
		Verified:    false,
	}
}

// AccessResolver maps an authenticated users record onto an AccessContext.
//
// Role permissions are read from the roles collection (the runtime authority
// that future role-management commands will edit) with the compiled matrix
// in internal/auth as fallback when the row or collection is unavailable, so
// a broken lookup degrades to deny-by-default instead of failing open.
// Every permission list is narrowed by the account status.
type AccessResolver struct {
	logger *slog.Logger
}

// NewAccessResolver creates a resolver that logs lookup degradation.
func NewAccessResolver(logger *slog.Logger) *AccessResolver {
	if logger == nil {
		logger = slog.Default()
	}
	return &AccessResolver{logger: logger}
}

// Middleware resolves the access context once per request and stores it in
// the request-scoped event store (read it back with AccessFrom). Guests pass
// through unchanged; the route handlers decide which permission is required.
func (r *AccessResolver) Middleware() func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		e.Set(accessContextKey, r.resolve(e))
		return e.Next()
	}
}

// accessForUser builds the AccessContext for an arbitrary users row.
//
// WHY THIS EXISTS. `resolve` reads e.Auth, so it can only ever describe the
// CALLER. Checking whether a permission is respected means asking a question
// about somebody ELSE — "may this recipient be messaged", "is this topic's
// author allowed to delete it" — and answering it with the caller's own
// permissions would silently grant the action whenever the sender happens to
// hold the key.
//
// The construction mirrors resolve() exactly, including the
// collection→guest fallback and the status narrowing, so a permission question
// about another account is answered by the same rules that authenticate it.
// Deliberately does NOT consult roles for a role the caller is not: it reads
// the SAME stored row the resolver would read, with no cache and no shortcut.
func accessForUser(app core.App, record *core.Record) AccessContext {
	if record == nil {
		return guestAccess()
	}
	if record.Collection().Name != usersCollectionName {
		return guestAccess()
	}

	role := auth.Role(record.GetString("role"))
	status := auth.Status(record.GetString("status"))

	base, fromCollection := storedRolePermissions(app, role)
	if !fromCollection {
		base = auth.DefaultPermissions(role)
	}
	return AccessContext{
		Role:        role,
		Status:      status,
		Permissions: auth.NarrowForStatus(base, status),
		Verified:    record.GetBool("verified"),
	}
}

func (r *AccessResolver) resolve(e *core.RequestEvent) AccessContext {
	record := e.Auth
	if record == nil {
		return guestAccess()
	}
	if record.Collection().Name != usersCollectionName {
		// Superusers and other auth collections are not forum identities;
		// they resolve to guest here and handlers can reject them explicitly.
		return guestAccess()
	}

	role := auth.Role(record.GetString("role"))
	status := auth.Status(record.GetString("status"))

	base, fromCollection := r.rolePermissions(e.App, role)
	if !fromCollection {
		base = auth.DefaultPermissions(role)
	}
	return AccessContext{
		Role:        role,
		Status:      status,
		Permissions: auth.NarrowForStatus(base, status),
		Verified:    record.GetBool("verified"),
	}
}

// rolePermissions looks the role up in the roles collection. The bool result
// reports whether a usable row was found.
func (r *AccessResolver) rolePermissions(app core.App, role auth.Role) ([]auth.Permission, bool) {
	return storedRolePermissions(app, role)
}

// storedRolePermissions reads a role's permission set out of the roles
// collection, the runtime authority, falling back to the compiled matrix.
//
// Package-level so that a permission question about ANOTHER account
// (accessForUser) is answered by exactly this lookup and not by a second copy
// of it. A second copy is how the two would drift — one learning that a role
// gained a key and the other not.
func storedRolePermissions(app core.App, role auth.Role) ([]auth.Permission, bool) {
	if role == "" {
		// No role on the record: deny-by-default through the compiled matrix.
		return nil, false
	}
	if role == auth.RoleGuest {
		// Guests are never a stored identity, so they have no row of their
		// own to read: their set is the compiled guest baseline (view_forum).
		return auth.DefaultPermissions(auth.RoleGuest), true
	}
	collection, err := app.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		slog.Default().Warn("roles collection unavailable; falling back to compiled permission matrix",
			"error", err, "role", string(role))
		return nil, false
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": string(role)})
	if err != nil {
		slog.Default().Warn("roles lookup failed; falling back to compiled permission matrix",
			"error", err, "role", string(role))
		return nil, false
	}
	if len(records) != 1 {
		slog.Default().Warn("roles lookup is ambiguous or missing; falling back to compiled permission matrix",
			"matches", len(records), "role", string(role))
		return nil, false
	}
	values := records[0].GetStringSlice("permissions")
	perms := make([]auth.Permission, 0, len(values))
	for _, value := range values {
		perms = append(perms, auth.Permission(value))
	}
	return perms, true
}
