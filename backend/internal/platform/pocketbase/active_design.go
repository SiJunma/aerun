package pocketbase

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// The installed/assigned design, resolved for the requesting visitor and
// embedded in the public settings snapshot (GET /api/aerun/settings).
//
// The chrome (background, header/footer, title, favicon, placeholders,
// CSS/JS injection) needs the active card on boot, but the full design lists
// are admin/picker data: fetching both lists on every boot just to learn
// which single card is active wastes two round trips and delays the first
// paint. The snapshot already travels on boot, so the resolved card travels
// with it — the client applies it immediately and fetches the lists lazily,
// only when a target changes after boot (theme switch, guest choice) or a
// preview is requested.
//
// The resolution mirrors the frontend's DesignProvider (resolveTarget /
// resolveWithFallback) exactly, so server and client cannot disagree about
// which card is active:
//
//   - the logged-in member's profile theme (users.settings.theme) when set,
//     else the forum default (forum_settings.default_design_id),
//   - a target that was hidden from the list (built-in) or deactivated
//     (custom design) falls back to the forum default,
//   - the forum default itself stays usable as the fallback even when hidden
//     from the list — it can no longer be (re-)selected, but it still works
//     for everyone who already has it,
//   - when nothing resolves, the built-in dark card is the ultimate fallback.
//
// A card that is neither the member's theme nor the forum default is never
// embedded: the snapshot carries exactly one card, the active one.

// userDesignTarget reads the requesting visitor's chosen design: the theme
// stored in their profile settings. Guests and non-forum auth contexts
// (superusers) have no theme and resolve to "" — the caller then falls back
// to the forum default.
func userDesignTarget(auth *core.Record) string {
	if auth == nil || auth.Collection().Name != usersCollectionName {
		return ""
	}
	settings, err := decodeSettings(auth)
	if err != nil {
		return ""
	}
	theme, _ := settings["theme"].(string)
	return strings.TrimSpace(theme)
}

// resolveDesignTarget resolves one target id to its embedded card payload.
//
// A built-in theme key ('dark' / 'light' / 'neutral') resolves to the
// default-designs card with that key; anything else is a custom design id.
// allowHidden is true only for the forum-default fallback itself: a card
// removed from the list stays usable as the fallback, it just can no longer
// be (re-)selected. The second return reports whether a usable card was
// found — hidden and missing both read as "not found" here, and the caller
// decides the fallback.
func resolveDesignTarget(app core.App, target string, allowHidden bool) (map[string]any, bool) {
	if target == "" {
		return nil, false
	}
	if isBuiltinTheme(target) {
		rec, err := findDefaultDesignByKey(app, target)
		if err != nil || rec == nil {
			return nil, false
		}
		if !allowHidden && !rec.GetBool("show_in_list") {
			return nil, false
		}
		payload := defaultDesignRecordPayload(rec)
		payload["kind"] = "default"
		return payload, true
	}
	rec, err := app.FindRecordById(designsCollectionName, target)
	if err != nil || rec == nil {
		return nil, false
	}
	if !allowHidden && !rec.GetBool("is_active") {
		return nil, false
	}
	payload := designRecordPayload(rec)
	payload["kind"] = "custom"
	return payload, true
}

// resolveActiveDesignCard resolves the requesting visitor's active design
// card for the settings snapshot. It never returns a card for a different
// target than the one resolved: the member's theme, the forum default, or
// the built-in dark card. A nil return means even the dark card is missing
// (the collection is empty) — the client then falls back to the built-in
// theme on its own, as it did before the snapshot carried the card.
func resolveActiveDesignCard(app core.App, auth *core.Record) map[string]any {
	settings := loadForumSettings(app)

	target := userDesignTarget(auth)
	if target == "" {
		target = settings.DefaultDesignID
	}
	if card, ok := resolveDesignTarget(app, target, false); ok {
		return card
	}

	// Hidden/removed/deactivated target: fall back to the forum default,
	// which stays usable as the fallback even when hidden from the list.
	if settings.DefaultDesignID != "" {
		if card, ok := resolveDesignTarget(app, settings.DefaultDesignID, true); ok {
			return card
		}
	}

	// Ultimate fallback: the built-in dark card.
	if card, ok := resolveDesignTarget(app, "dark", true); ok {
		return card
	}
	return nil
}
