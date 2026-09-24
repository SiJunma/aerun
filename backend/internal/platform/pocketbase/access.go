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
}

// guestAccess is the context used when there is nothing to resolve.
func guestAccess() AccessContext {
	return AccessContext{
		Role:        auth.RoleGuest,
		Status:      auth.StatusActive,
		Permissions: auth.DefaultPermissions(auth.RoleGuest),
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
	}
}

// rolePermissions looks the role up in the roles collection. The bool result
// reports whether a usable row was found.
func (r *AccessResolver) rolePermissions(app core.App, role auth.Role) ([]auth.Permission, bool) {
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
		r.logger.Warn("roles collection unavailable; falling back to compiled permission matrix",
			"error", err, "role", string(role))
		return nil, false
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": string(role)})
	if err != nil {
		r.logger.Warn("roles lookup failed; falling back to compiled permission matrix",
			"error", err, "role", string(role))
		return nil, false
	}
	if len(records) != 1 {
		r.logger.Warn("roles lookup is ambiguous or missing; falling back to compiled permission matrix",
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
