package pocketbase

// Global forum settings: the server-side home for everything the admin panel used
// to keep in each visitor's localStorage.
//
// The migration that created the columns documents the damage in full; this file
// is the read and write path that makes them real. Three properties matter:
//
//   - Public read. Branding, the feature switches and the access flags are read
//     by guests (the title bar, the welcome banner, the registration form), so
//     the read route carries no permission. Nothing here is secret: it is the
//     forum's own name and its own toggles.
//   - Admin write, whitelisted. The handler maps a fixed set of client keys onto
//     fields. A client cannot write `key` (the singleton marker), an id, or any
//     column this file does not name — the map is the allowlist, so adding a
//     field later cannot accidentally expose it.
//   - One read path. loadGlobalSettings is the only function that touches these
//     columns, so the admin panel, the API response, the mail templates and the
//     access guards cannot disagree about what the forum is currently set to.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/config"
)

// readPlainString decodes a plain-string settings field, tolerating the
// pre-surfaces shape: a JSONField that still holds a {en, ru} object (an
// un-migrated row) reads as its ru leaf, and a JSON string reads as itself.
//
// PocketBase surfaces a saved JSONField as types.JSONRaw, not as a string —
// so a row written through the admin panel and then read back arrives as
// raw JSON bytes. Without that case every stored name reads back empty,
// which is exactly how a rename that saved fine produced an empty forumName
// in the response snapshot.
func readPlainString(app core.App, field string) string {
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return ""
	}
	raw := record.Get(field)
	switch v := raw.(type) {
	case nil:
		return ""
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return ""
		}
		if trimmed[0] == '{' {
			return bilingualLeafString(trimmed)
		}
		if trimmed[0] == '"' {
			var decoded string
			if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
				return strings.TrimSpace(decoded)
			}
		}
		return trimmed
	case types.JSONRaw:
		return decodePlainStringBytes(v)
	case []byte:
		return decodePlainStringBytes(v)
	case map[string]any:
		return bilingualLeafStringMap(v)
	default:
		return ""
	}
}

// decodePlainStringBytes parses a stored JSON value into a plain string: a
// JSON string reads as itself, a {en, ru} object reads as its ru leaf.
func decodePlainStringBytes(payload []byte) string {
	if len(payload) == 0 {
		return ""
	}
	var decoded string
	if err := json.Unmarshal(payload, &decoded); err == nil {
		return strings.TrimSpace(decoded)
	}
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err == nil {
		return bilingualLeafStringMap(obj)
	}
	return ""
}

// bilingualLeafStringMap picks the ru leaf of a bilingual map, then en.
func bilingualLeafStringMap(decoded map[string]any) string {
	for _, key := range []string{"ru", "en"} {
		if s, ok := decoded[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// bilingualLeafString is bilingualLeafStringMap for a raw JSON object string.
func bilingualLeafString(raw string) string {
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	return bilingualLeafStringMap(decoded)
}

// forumName returns the forum's name: the plain single-variant string the
// surfaces rework stores (migration 1781000011 converted the old {en, ru}
// map by taking ru). The lang parameter is kept for the existing call sites
// and ignored — there is no per-language name any more.
//
// A blank name is never returned: it would render as an empty title bar and an
// empty mail signature, and both look like a broken deploy rather than an
// unconfigured forum.
func forumName(app core.App, lang string) string {
	_ = lang
	if name := strings.TrimSpace(readPlainString(app, "forum_name")); name != "" {
		return name
	}
	return "Aerun"
}

// globalSettingsSnapshot is what the public read returns. It is the camelCase
// shape the client already expects from `getGlobalSettings`, so the frontend
// change is a transport swap rather than a reshape.
func globalSettingsSnapshot(app core.App) map[string]any {
	settings := loadForumSettings(app)
	return map[string]any{
		"forumName":             forumName(app, ""),
		"headerHtml":            readPlainString(app, "header_html"),
		"customFooterHtml":      readPlainString(app, "custom_footer_html"),
		"registrationEnabled":   !settings.MaintenanceMode && settings.RegistrationEnabled,
		"maintenanceMode":       settings.MaintenanceMode,
		"requireApproval":       settings.RequireApproval,
		"whitelistMode":         settings.WhitelistMode,
		"maxCharsPerPost":       settings.MaxCharsPerPost,
		"postsPerPage":          settings.PostsPerPage,
		"topicsPerPage":         settings.TopicsPerPage,
		"maxPostsPerTopic":      settings.MaxPostsPerTopic,
		"maxCharactersPerUser":  settings.MaxCharactersPerUser,
		"enableReputation":      settings.EnableReputation,
		"reputationStyle":       settings.ReputationStyle,
		"enableCharacters":      settings.EnableCharacters,
		"enableDice":            settings.EnableDice,
		"allowGifAvatars":       settings.AllowGifAvatars,
		"allowGifInPosts":       settings.AllowGifInPosts,
		"allowUserCustomDesign": settings.AllowUserCustomDesign,
		"defaultDesignId":       settings.DefaultDesignID,
		"faviconUrl":            settings.FaviconURL,
		"deletedAvatar":         settings.DeletedAvatarURL,
		"guestAvatar":           settings.GuestAvatarURL,
	}
}

// getGlobalSettingsHandler serves the snapshot to every visitor.
//
// It carries no permission and must stay that way: the title bar and the
// welcome banner read it before anyone is signed in, and hiding it would only
// push the client back to a localStorage copy that no admin edit can reach.
func getGlobalSettingsHandler(e *core.RequestEvent) error {
	return e.JSON(http.StatusOK, map[string]any{
		"settings":   globalSettingsSnapshot(e.App),
		"request_id": requestIDFrom(e),
	})
}

// writeGlobalSettingsHandler applies an admin's edit.
//
// The client key allowlist below IS the write surface. Anything not named is
// ignored, so a client cannot reach `key`, the fixed singleton id, or a column
// added by a later migration that nobody has thought about exposing. Replace-
// per-key (rather than merge) matches settings_update.go's reasoning: a partial
// body leaves the untouched keys exactly as they were, and the returned snapshot
// is what the server actually stored, so the form cannot drift from the row.
//
// The handler is a factory because a rename has a second effect outside the
// settings row: the mail brand. Every auth template carries {APP_NAME},
// PocketBase resolves it from settings.Meta.AppName at send time, and
// configureSMTP seeds that from forum_name only at startup. Syncing Meta here —
// in the same request as the rename, no restart — is what keeps "rename the
// forum" and "the next verification mail" the same act. cfg is needed only for
// the AERUN_MAIL_SENDER_NAME override: an explicit env value wins over the
// forum name, exactly as in mailSenderName at boot.
func updateGlobalSettingsHandler(cfg config.Config) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return forbiddenError("authentication required")
		}

		body := struct {
			ForumName             *string `json:"forumName"`
			HeaderHtml            *string `json:"headerHtml"`
			CustomFooterHtml      *string `json:"customFooterHtml"`
			RegistrationEnabled   *bool   `json:"registrationEnabled"`
			RequireApproval       *bool   `json:"requireApproval"`
			WhitelistMode         *bool   `json:"whitelistMode"`
			MaintenanceMode       *bool   `json:"maintenanceMode"`
			MaxCharsPerPost       *int    `json:"maxCharsPerPost"`
			PostsPerPage          *int    `json:"postsPerPage"`
			TopicsPerPage         *int    `json:"topicsPerPage"`
			MaxPostsPerTopic      *int    `json:"maxPostsPerTopic"`
			MaxCharactersPerUser  *int    `json:"maxCharactersPerUser"`
			EnableReputation      *bool   `json:"enableReputation"`
			ReputationStyle       *string `json:"reputationStyle"`
			EnableCharacters      *bool   `json:"enableCharacters"`
			EnableDice            *bool   `json:"enableDice"`
			AllowGifAvatars       *bool   `json:"allowGifAvatars"`
			AllowGifInPosts       *bool   `json:"allowGifInPosts"`
			AllowUserCustomDesign *bool   `json:"allowUserCustomDesign"`
			DefaultDesignID       *string `json:"defaultDesignId"`
			FaviconURL            *string `json:"faviconUrl"`
			DeletedAvatarURL      *string `json:"deletedAvatar"`
			GuestAvatarURL        *string `json:"guestAvatar"`
		}{}
		if err := e.BindBody(&body); err != nil {
			return validationError("invalid settings payload")
		}

		if style := body.ReputationStyle; style != nil && *style != "both" && *style != "positive_only" {
			return validationError("reputationStyle must be \"both\" or \"positive_only\"")
		}
		if n := body.MaxCharsPerPost; n != nil && (*n < 0 || *n > 1_000_000) {
			return validationError("maxCharsPerPost must be between 0 and 1000000 (0 = unlimited)")
		}
		// The three pagination keys are rejected out of range here rather than
		// left to the field-level Min/Max: a validation error surfaced by Save
		// would come back as a 500 and read as a server fault instead of the
		// form being told which number is impossible. The bounds are the same
		// auth ceilings the read path clamps to, so the panel can never store a
		// value the forum would then refuse to serve.
		if n := body.PostsPerPage; n != nil && (*n < auth.MinPostsPerPage || *n > auth.HardMaxPostsPerPage) {
			return validationError("postsPerPage must be between 1 and 100")
		}
		if n := body.TopicsPerPage; n != nil && (*n < auth.MinTopicsPerPage || *n > auth.HardMaxTopicsPerPage) {
			return validationError("topicsPerPage must be between 1 and 50")
		}
		if n := body.MaxPostsPerTopic; n != nil && (*n < auth.MinMaxPostsPerTopic || *n > auth.HardMaxPostsPerTopic) {
			return validationError("maxPostsPerTopic must be between 2 and 5000")
		}
		// The mask cap is bounded by the same ceiling the read path clamps to,
		// so a value the panel can never store is also a value the forum can
		// never apply.
		if n := body.MaxCharactersPerUser; n != nil && (*n < auth.MinMaxCharactersPerUser || *n > auth.HardMaxCharactersPerUser) {
			return validationError("maxCharactersPerUser must be between 1 and 100")
		}

		// The keys that arrived, for the audit row. Recorded as names only: the
		// values are the settings themselves, already readable from the snapshot,
		// and the trail's job is to say WHAT was touched and BY WHOM.
		changed := make([]string, 0, 24)

		if err := e.App.RunInTransaction(func(txApp core.App) error {
			record, err := txApp.FindRecordById(forumSettingsCollectionName, forumSettingsID)
			if err != nil || record == nil {
				return internalError("forum settings row is missing", err)
			}

			// Each setter reports presence, and presence is what feeds the audit
			// detail: a key the client did not send must neither reset the column
			// nor appear as if it had been edited.
			set := func(key string, write func()) {
				write()
				changed = append(changed, key)
			}

			if body.ForumName != nil {
				v := strings.TrimSpace(*body.ForumName)
				set("forumName", func() { record.Set("forum_name", v) })
			}
			if body.HeaderHtml != nil {
				v := *body.HeaderHtml
				set("headerHtml", func() { record.Set("header_html", v) })
			}
			if body.CustomFooterHtml != nil {
				v := *body.CustomFooterHtml
				set("customFooterHtml", func() { record.Set("custom_footer_html", v) })
			}
			if body.RegistrationEnabled != nil {
				v := *body.RegistrationEnabled
				set("registrationEnabled", func() { record.Set("registration_enabled", v) })
			}
			if body.RequireApproval != nil {
				v := *body.RequireApproval
				set("requireApproval", func() { record.Set("require_approval", v) })
			}
			if body.WhitelistMode != nil {
				v := *body.WhitelistMode
				set("whitelistMode", func() { record.Set("whitelist_mode", v) })
			}
			if body.MaintenanceMode != nil {
				v := *body.MaintenanceMode
				set("maintenanceMode", func() { record.Set("maintenance_mode", v) })
			}
			if body.MaxCharsPerPost != nil {
				v := *body.MaxCharsPerPost
				set("maxCharsPerPost", func() { record.Set("max_chars_per_post", v) })
			}
			if body.PostsPerPage != nil {
				v := *body.PostsPerPage
				set("postsPerPage", func() { record.Set("posts_per_page", v) })
			}
			if body.TopicsPerPage != nil {
				v := *body.TopicsPerPage
				set("topicsPerPage", func() { record.Set("topics_per_page", v) })
			}
			if body.MaxPostsPerTopic != nil {
				v := *body.MaxPostsPerTopic
				set("maxPostsPerTopic", func() { record.Set("max_posts_per_topic", v) })
			}
			if body.MaxCharactersPerUser != nil {
				v := *body.MaxCharactersPerUser
				set("maxCharactersPerUser", func() { record.Set("max_characters_per_user", v) })
			}
			if body.EnableReputation != nil {
				v := *body.EnableReputation
				set("enableReputation", func() { record.Set("enable_reputation", v) })
			}
			if body.ReputationStyle != nil {
				v := strings.TrimSpace(*body.ReputationStyle)
				set("reputationStyle", func() { record.Set("reputation_style", v) })
			}
			if body.EnableCharacters != nil {
				v := *body.EnableCharacters
				set("enableCharacters", func() { record.Set("enable_characters", v) })
			}
			if body.EnableDice != nil {
				v := *body.EnableDice
				set("enableDice", func() { record.Set("enable_dice", v) })
			}
			if body.AllowGifAvatars != nil {
				v := *body.AllowGifAvatars
				set("allowGifAvatars", func() { record.Set("allow_gif_avatars", v) })
			}
			if body.AllowGifInPosts != nil {
				v := *body.AllowGifInPosts
				set("allowGifInPosts", func() { record.Set("allow_gif_in_posts", v) })
			}
			if body.AllowUserCustomDesign != nil {
				v := *body.AllowUserCustomDesign
				set("allowUserCustomDesign", func() { record.Set("allow_user_custom_design", v) })
			}
			if body.DefaultDesignID != nil {
				v := strings.TrimSpace(*body.DefaultDesignID)
				set("defaultDesignId", func() { record.Set("default_design_id", v) })
			}
			if body.FaviconURL != nil {
				v := strings.TrimSpace(*body.FaviconURL)
				set("faviconUrl", func() { record.Set("favicon_url", v) })
			}
			// The identity placeholder references are normally written by the
			// dedicated upload endpoint (PUT /admin/settings/placeholder/{kind}),
			// which owns the FileField; accepting the URL here lets an admin set
			// or CLEAR a placeholder the same way they set the favicon, without the
			// panel needing a second write path. Empty clears it (fall back to
			// the default); a non-empty string is trusted as an admin-supplied
			// reference, exactly like faviconUrl.
			if body.DeletedAvatarURL != nil {
				v := strings.TrimSpace(*body.DeletedAvatarURL)
				set("deletedAvatar", func() { record.Set("deleted_avatar_url", v) })
			}
			if body.GuestAvatarURL != nil {
				v := strings.TrimSpace(*body.GuestAvatarURL)
				set("guestAvatar", func() { record.Set("guest_avatar_url", v) })
			}

			// The trail records the command, not its values: every key that
			// reached the row is named, so "who turned what off" is one query
			// away, while a wholesale settings dump stays out of the log.
			if len(changed) > 0 {
				_ = recordAuditLog(txApp, "settings_updated", e.Auth.Id, map[string]any{
					"keys": changed,
				})
			}

			return txApp.Save(record)
		}); err != nil {
			return internalError("failed to save forum settings", err)
		}

		// The mail brand follows the rename in the same request. Meta lives
		// outside the transaction deliberately: a failed settings write would
		// roll back the row but not an in-memory Meta edit, leaving the two
		// disagreeing — whereas a failed Meta write still leaves the new name
		// durable in the row, and the next rename or boot converges it.
		if body.ForumName != nil {
			brand := forumName(e.App, "en")
			settings := e.App.Settings()
			settings.Meta.AppName = brand
			settings.Meta.SenderName = mailSenderName(cfg, brand)
			if err := e.App.Save(settings); err != nil {
				return internalError("forum renamed but the mail brand could not be updated", err)
			}
		}

		// Returns the STORED snapshot, not the request body: an admin form that
		// renders its own optimistic value is how a clamp or a rejected field turns
		// into a panel that lies about what the forum is set to.
		return e.JSON(http.StatusOK, map[string]any{
			"settings":   globalSettingsSnapshot(e.App),
			"request_id": requestIDFrom(e),
		})
	}
}
