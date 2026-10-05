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

// bilingual is the {en, ru} shape the admin panel already uses for branding.
// Kept as a map rather than a struct because the client sends and receives it
// that way and the languages are not a closed set.
type bilingual map[string]any

// forumName returns the forum's name for a language, falling back EN then to the
// literal "Forum" the title bar used before a name was ever set.
//
// A blank name is never returned: it would render as an empty title bar and an
// empty mail signature, and both look like a broken deploy rather than an
// unconfigured forum.
func forumName(app core.App, lang string) string {
	name := readBilingual(app, "forum_name")
	for _, candidate := range []string{lang, "en", "ru"} {
		if v, ok := name[candidate].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return "Forum"
}

// readBilingual decodes a JSON field, tolerating both the object form and the
// legacy plain string the first export carried.
//
// PocketBase surfaces a saved JSONField as types.JSONRaw, not as a map —
// so a row written through the admin panel and then read back arrives as
// raw JSON bytes. Without that case every stored name reads back empty,
// which is exactly how a rename that saved fine produced an empty forumName
// in the response snapshot.
func readBilingual(app core.App, field string) bilingual {
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return bilingual{}
	}
	raw := record.Get(field)
	switch v := raw.(type) {
	case map[string]any:
		return bilingual(v)
	case types.JSONRaw:
		return decodeBilingualBytes(v)
	case []byte:
		return decodeBilingualBytes(v)
	case string:
		// A plain string means the pre-migration shape; treat it as both
		// languages rather than dropping it, so an old row still names itself.
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			if trimmed[0] == '{' {
				return decodeBilingualBytes([]byte(trimmed))
			}
			return bilingual{"en": trimmed, "ru": trimmed}
		}
	}
	return bilingual{}
}

// decodeBilingualBytes parses a stored JSON object into string leaves.
func decodeBilingualBytes(payload []byte) bilingual {
	if len(payload) == 0 {
		return bilingual{}
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return bilingual{}
	}
	return bilingual(normalizeBilingual(decoded))
}

// globalSettingsSnapshot is what the public read returns. It is the camelCase
// shape the client already expects from `getGlobalSettings`, so the frontend
// change is a transport swap rather than a reshape.
func globalSettingsSnapshot(app core.App) map[string]any {
	settings := loadForumSettings(app)
	return map[string]any{
		"forumName":             readBilingual(app, "forum_name"),
		"welcomeMessage":        readBilingual(app, "welcome_message"),
		"registrationEnabled":   !settings.MaintenanceMode && settings.RegistrationEnabled,
		"maintenanceMode":       settings.MaintenanceMode,
		"requireApproval":       settings.RequireApproval,
		"whitelistMode":         settings.WhitelistMode,
		"maxCharsPerPost":       settings.MaxCharsPerPost,
		"postsPerPage":          settings.PostsPerPage,
		"topicsPerPage":         settings.TopicsPerPage,
		"maxPostsPerTopic":      settings.MaxPostsPerTopic,
		"enableReputation":      settings.EnableReputation,
		"reputationStyle":       settings.ReputationStyle,
		"enableCharacters":      settings.EnableCharacters,
		"enableDice":            settings.EnableDice,
		"allowGifAvatars":       settings.AllowGifAvatars,
		"allowGifInPosts":       settings.AllowGifInPosts,
		"allowUserCustomDesign": settings.AllowUserCustomDesign,
		"defaultDesignId":       settings.DefaultDesignID,
		"logoUrl":               settings.LogoURL,
		"bgLight":               settings.BgLight,
		"bgDark":                settings.BgDark,
		"bgNeutral":             settings.BgNeutral,
		"bgOpacityLight":        settings.BgOpacityLight,
		"bgOpacityDark":         settings.BgOpacityDark,
		"bgOpacityNeutral":      settings.BgOpacityNeutral,
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
			ForumName             map[string]any `json:"forumName"`
			WelcomeMessage        map[string]any `json:"welcomeMessage"`
			RegistrationEnabled   *bool          `json:"registrationEnabled"`
			RequireApproval       *bool          `json:"requireApproval"`
			WhitelistMode         *bool          `json:"whitelistMode"`
			MaintenanceMode       *bool          `json:"maintenanceMode"`
			MaxCharsPerPost       *int           `json:"maxCharsPerPost"`
			PostsPerPage          *int           `json:"postsPerPage"`
			TopicsPerPage         *int           `json:"topicsPerPage"`
			MaxPostsPerTopic      *int           `json:"maxPostsPerTopic"`
			EnableReputation      *bool          `json:"enableReputation"`
			ReputationStyle       *string        `json:"reputationStyle"`
			EnableCharacters      *bool          `json:"enableCharacters"`
			EnableDice            *bool          `json:"enableDice"`
			AllowGifAvatars       *bool          `json:"allowGifAvatars"`
			AllowGifInPosts       *bool          `json:"allowGifInPosts"`
			AllowUserCustomDesign *bool          `json:"allowUserCustomDesign"`
			DefaultDesignID       *string        `json:"defaultDesignId"`
			LogoURL               *string        `json:"logoUrl"`
			BgLight               *string        `json:"bgLight"`
			BgDark                *string        `json:"bgDark"`
			BgNeutral             *string        `json:"bgNeutral"`
			BgOpacityLight        *float64       `json:"bgOpacityLight"`
			BgOpacityDark         *float64       `json:"bgOpacityDark"`
			BgOpacityNeutral      *float64       `json:"bgOpacityNeutral"`
		}{}
		if err := e.BindBody(&body); err != nil {
			return validationError("invalid settings payload")
		}

		if style := body.ReputationStyle; style != nil && *style != "both" && *style != "positive_only" {
			return validationError("reputationStyle must be \"both\" or \"positive_only\"")
		}
		if n := body.MaxCharsPerPost; n != nil && (*n < 1 || *n > 1_000_000) {
			return validationError("maxCharsPerPost must be between 1 and 1000000")
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
				set("forumName", func() { record.Set("forum_name", normalizeBilingual(body.ForumName)) })
			}
			if body.WelcomeMessage != nil {
				set("welcomeMessage", func() { record.Set("welcome_message", normalizeBilingual(body.WelcomeMessage)) })
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
			if body.LogoURL != nil {
				v := strings.TrimSpace(*body.LogoURL)
				set("logoUrl", func() { record.Set("logo_url", v) })
			}
			if body.BgLight != nil {
				v := strings.TrimSpace(*body.BgLight)
				set("bgLight", func() { record.Set("bg_light", v) })
			}
			if body.BgDark != nil {
				v := strings.TrimSpace(*body.BgDark)
				set("bgDark", func() { record.Set("bg_dark", v) })
			}
			if body.BgNeutral != nil {
				v := strings.TrimSpace(*body.BgNeutral)
				set("bgNeutral", func() { record.Set("bg_neutral", v) })
			}
			if body.BgOpacityLight != nil {
				v := *body.BgOpacityLight
				set("bgOpacityLight", func() { record.Set("bg_opacity_light", v) })
			}
			if body.BgOpacityDark != nil {
				v := *body.BgOpacityDark
				set("bgOpacityDark", func() { record.Set("bg_opacity_dark", v) })
			}
			if body.BgOpacityNeutral != nil {
				v := *body.BgOpacityNeutral
				set("bgOpacityNeutral", func() { record.Set("bg_opacity_neutral", v) })
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

// normalizeBilingual keeps only string leaves, so an admin cannot store a nested
// object or an array in the forum name and have the title bar render "[object
// Object]".
func normalizeBilingual(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		if s, ok := v.(string); ok {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				out[k] = trimmed
			}
		}
	}
	return out
}
