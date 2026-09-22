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

// Sprint 2 command (plan §4 Sprint 2 task 5): PUT /api/aerun/me/settings —
// owner-only access to the users.settings JSON column. Browser mutation of
// the users collection is locked (Create/Update rules are nil), so this
// server command is the only way an account can change its settings. Banned
// accounts are denied; active and pending accounts may edit their own
// settings (pending keeps the legacy self-service presentation rights).
const (
	// Mirrors the users.settings JSONField MaxSize (262144 bytes).
	settingsMaxBytes = 256 * 1024
	// Rejects absurd nesting that only exists to waste CPU on the UI side.
	settingsMaxDepth = 8
)

// updateSettingsHandler replaces the caller's settings object wholesale.
// Replace-not-merge keeps the command deterministic: a client that sends a
// partial object gets a partial state it can reason about, instead of
// unknowingly merging into values it never saw.
func updateSettingsHandler(e *core.RequestEvent) error {
	record := e.Auth
	if record == nil {
		return router.NewUnauthorizedError("authentication is required for this action", nil)
	}
	if record.Collection().Name != usersCollectionName {
		return router.NewForbiddenError("this endpoint serves forum accounts only", nil)
	}
	acc := AccessFrom(e)
	if acc.Status == auth.StatusBanned {
		return router.NewForbiddenError("banned accounts cannot change their settings", nil)
	}

	raw, err := readBodyLimited(e, settingsMaxBytes)
	if err != nil {
		return err
	}

	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return e.BadRequestError("settings must be a single JSON object", nil)
	}
	if parsed == nil {
		// JSON null is accepted and normalised to an empty object, so the
		// column never stores null and /me never has to special-case it.
		parsed = map[string]any{}
	}
	if err := checkJSONDepth(parsed, settingsMaxDepth); err != nil {
		return e.BadRequestError(fmt.Sprintf("settings nesting must not exceed %d levels", settingsMaxDepth), nil)
	}
	serialized, err := json.Marshal(parsed)
	if err != nil {
		return e.BadRequestError("settings must be serialisable JSON", nil)
	}

	record.Set("settings", types.JSONRaw(serialized))
	if err := e.App.Save(record); err != nil {
		return e.BadRequestError("settings could not be saved", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"settings":   parsed,
		"request_id": requestIDFrom(e),
	})
}

// checkJSONDepth enforces the maximum nesting depth of the settings object
// (the object itself is level 1).
func checkJSONDepth(value any, max int) error {
	return checkJSONDepthValue(value, 1, max)
}

func checkJSONDepthValue(value any, depth, max int) error {
	if depth > max {
		return fmt.Errorf("nesting deeper than %d levels", max)
	}
	switch typed := value.(type) {
	case map[string]any:
		for _, child := range typed {
			if err := checkJSONDepthValue(child, depth+1, max); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := checkJSONDepthValue(child, depth+1, max); err != nil {
				return err
			}
		}
	}
	return nil
}
