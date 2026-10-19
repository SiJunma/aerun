package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// AccessFrom returns the access context resolved by the AccessResolver
// middleware, or the guest context when the middleware has not run.
func AccessFrom(e *core.RequestEvent) AccessContext {
	if acc, ok := e.Get(accessContextKey).(AccessContext); ok {
		return acc
	}
	return guestAccess()
}

// RequirePermission is a route middleware for the /api/aerun command routes:
// it must be bound after the AccessResolver middleware. Unauthenticated
// callers get 401, authenticated callers without the permission get 403.
func RequirePermission(permission auth.Permission) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		acc := AccessFrom(e)
		if !auth.Has(acc.Permissions, permission) {
			if acc.Role == auth.RoleGuest {
				return router.NewUnauthorizedError("authentication is required for this action", nil)
			}
			return router.NewForbiddenError("you are not allowed to perform this action", nil)
		}
		return e.Next()
	}
}

// requireNotBanned refuses a mutation from an account the staff suspended.
//
// Ownership does not survive a ban. The topic and post handlers read
// `isAuthor || permission`, so the author branch grants the action with NO
// permission consulted at all — an account narrowed to nothing could keep
// rewriting and deleting its own content, which is exactly the material a
// moderator is looking at when they ban somebody. The status is checked here
// instead of at every call site so the rule has one name.
//
// A soft-deleted account is refused by the same gate for the same reason: its
// token may still validate until the next refresh, and the author branch above
// would otherwise let it keep editing its own posts from a session that should
// already be over. NarrowForStatus denies every permission for `deleted`, but
// these handlers never consult permissions in the author branch — the status
// is what they do read.
//
// The message names the action: a bare "forbidden" left the admin wondering
// whether the post was theirs.
func requireNotBanned(acc AccessContext, action string) error {
	if acc.Status == auth.StatusDeleted {
		return forbiddenError("this account has been deleted; it cannot " + action)
	}
	if acc.Status == auth.StatusBanned {
		return forbiddenError("banned accounts cannot " + action)
	}
	return nil
}

// profilePayload builds the public profile DTO for GET /api/aerun/me. It is
// assembled field by field on purpose: email and legacy_firebase_uid can
// never leak into the response because they are not part of the map.
func profilePayload(e *core.RequestEvent, acc AccessContext) map[string]any {
	payload := map[string]any{
		"role":        string(acc.Role),
		"status":      string(acc.Status),
		"permissions": auth.PermissionValues(acc.Permissions),
		"request_id":  requestIDFrom(e),
	}

	record := e.Auth
	if record == nil {
		payload["id"] = ""
		payload["nickname"] = ""
		payload["verified"] = false
		payload["avatar_url"] = ""
		payload["settings"] = map[string]any{}
		return payload
	}

	settings, err := decodeSettings(record)
	if err != nil {
		// A corrupt payload must not break the identity response; the
		// stored value stays untouched and can be repaired by a command.
		e.App.Logger().Warn("users.settings could not be decoded; serving empty settings",
			"error", err, "userId", record.Id)
		settings = map[string]any{}
	}

	payload["id"] = record.Id
	payload["nickname"] = record.GetString("nickname")
	payload["verified"] = record.GetBool("verified")
	payload["avatar_url"] = record.GetString("avatar_url")
	payload["settings"] = settings
	return payload
}

// decodeSettings reads the users.settings value of a record. PocketBase
// stores JSON fields as types.JSONRaw (not as a plain []byte), so the raw
// value is normalised before unmarshalling; a missing or empty value decodes
// to an empty object, never to null.
func decodeSettings(record *core.Record) (map[string]any, error) {
	settings := map[string]any{}

	var raw []byte
	switch value := record.Get("settings").(type) {
	case nil:
		return settings, nil
	case types.JSONRaw:
		raw = value
	case []byte:
		raw = value
	case string:
		raw = []byte(value)
	default:
		return nil, fmt.Errorf("unexpected users.settings value type %T", value)
	}

	if len(raw) == 0 {
		return settings, nil
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, err
	}
	return settings, nil
}

// meHandler answers GET /api/aerun/me with the caller's public profile DTO
// (plus the effective permissions the UI gates features on). Guests receive
// the guest identity; non-forum auth contexts (e.g. superuser tokens) are
// rejected instead of being silently presented as guests.
func meHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	record := e.Auth
	if record != nil && record.Collection().Name != usersCollectionName {
		return router.NewForbiddenError("this endpoint serves forum accounts only", nil)
	}
	return e.JSON(http.StatusOK, profilePayload(e, acc))
}
