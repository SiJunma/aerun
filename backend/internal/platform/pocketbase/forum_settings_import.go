// Package pocketbase
//
// Settings import (Sprint 7 writer, standalone level).
//
// The legacy `settings/global` document carried the forum's real branding,
// feature flags and limits. By owner decision they were never imported into
// the database — they were reported as PB_SETTINGS_* env vars instead.
// But the server reads every one of them from the `forum_settings` singleton
// row (loadForumSettings), which the migration seeded with DEFAULTS only.
// So the forum rendered "Aerun", an empty welcome banner, default limits —
// nothing from the snapshot.
//
// This writer closes the gap: it reads settings/global from the staging
// ledger and upserts the values into forum_settings (id "forumsettings01").
// It is idempotent: a second run over the same export reports no change.
//
package pocketbase

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// SettingsUpsert is the desired state of the forum_settings singleton row.
// Every field is optional: an empty value means "leave as-is".
type SettingsUpsert struct {
	// Branding (bilingual JSON)
	ForumName      map[string]string
	WelcomeMessage map[string]string
	// Text
	LogoURL         string
	BgLight         string
	BgDark          string
	BgNeutral       string
	BgOpacityLight  float64
	BgOpacityDark   float64
	BgOpacityNeutral float64
	// Feature flags
	RegistrationEnabled   bool
	RequireApproval       bool
	WhitelistMode         bool
	MaintenanceMode       bool
	EnableReputation      bool
	ReputationStyle       string
	EnableCharacters      bool
	EnableDice            bool
	AllowGifAvatars       bool
	AllowGifInPosts       bool
	AllowUserCustomDesign bool
	DefaultDesignID       string
	// Limits
	// MaxCharsPerPost is 0 when the legacy export explicitly set "unlimited";
	// MaxCharsPerPostSet distinguishes that from "not present in source".
	MaxCharsPerPost      int
	MaxCharsPerPostSet   bool
	MaxPostsPerTopic     int
	PostsPerPage         int
	TopicsPerPage        int
	MaxCharactersPerUser int
}

// SettingsImportReport states what the import changed.
type SettingsImportReport struct {
	Created   bool
	Updated   bool
	Unchanged bool
	Changed   bool
}

// ImportSettings upserts the forum_settings singleton row.
// A missing row is created; an existing row is updated only when a field
// differs from the stored value. Fields left at their Go zero value are
// not written (they are treated as "not specified").
func ImportSettings(app core.App, u *SettingsUpsert) (SettingsImportReport, error) {
	report := SettingsImportReport{}
	if u == nil {
		return report, fmt.Errorf("settings upsert is nil")
	}

	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return report, fmt.Errorf("forum_settings collection unavailable: %w", err)
	}

	err = app.RunInTransaction(func(txApp core.App) error {
		rec, err := txApp.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil || rec == nil {
			rec = core.NewRecord(col)
			rec.Set("id", forumSettingsID)
			rec.Set("key", "singleton")
			report.Created = true
		}

		changed := applySettingsUpsert(rec, u)
		if !changed && !report.Created {
			report.Unchanged = true
			return nil
		}
		if err := txApp.Save(rec); err != nil {
			return fmt.Errorf("save forum settings: %w", err)
		}
		if report.Created {
			return nil
		}
		report.Updated = true
		return nil
	})
	if err != nil {
		return report, err
	}
	report.Changed = report.Created || report.Updated
	return report, nil
}

// applySettingsUpsert writes every non-zero field onto the record and
// reports whether anything actually differs from what is stored.
func applySettingsUpsert(rec *core.Record, u *SettingsUpsert) bool {
	changed := false

	setBilingual := func(field string, m map[string]string) bool {
		if m == nil {
			return false
		}
		raw := make(map[string]any, len(m))
		for k, v := range m {
			raw[k] = v
		}
		stored := rec.Get(field)
		var storedMap map[string]any
		switch v := stored.(type) {
		case map[string]any:
			storedMap = v
		case types.JSONRaw:
			var decoded map[string]any
			if err := json.Unmarshal([]byte(v), &decoded); err == nil {
				storedMap = decoded
			}
		case []byte:
			var decoded map[string]any
			if err := json.Unmarshal(v, &decoded); err == nil {
				storedMap = decoded
			}
		case string:
			if trimmed := strings.TrimSpace(v); trimmed != "" && trimmed[0] == '{' {
				var decoded map[string]any
				if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
					storedMap = decoded
				}
			}
		}
		if mapsEqual(storedMap, raw) {
			return false
		}
		rec.Set(field, raw)
		return true
	}

	if setBilingual("forum_name", u.ForumName) {
		changed = true
	}
	if setBilingual("welcome_message", u.WelcomeMessage) {
		changed = true
	}

	setText := func(field, value string) bool {
		if value == "" {
			return false
		}
		if rec.GetString(field) == value {
			return false
		}
		rec.Set(field, value)
		return true
	}

	if setText("logo_url", u.LogoURL) {
		changed = true
	}
	if setText("bg_light", u.BgLight) {
		changed = true
	}
	if setText("bg_dark", u.BgDark) {
		changed = true
	}
	if setText("bg_neutral", u.BgNeutral) {
		changed = true
	}
	if setText("reputation_style", u.ReputationStyle) {
		changed = true
	}
	if setText("default_design_id", u.DefaultDesignID) {
		changed = true
	}

	setNumber := func(field string, value float64) bool {
		if value == 0 {
			return false
		}
		if rec.GetFloat(field) == value {
			return false
		}
		rec.Set(field, value)
		return true
	}

	if setNumber("bg_opacity_light", u.BgOpacityLight) {
		changed = true
	}
	if setNumber("bg_opacity_dark", u.BgOpacityDark) {
		changed = true
	}
	if setNumber("bg_opacity_neutral", u.BgOpacityNeutral) {
		changed = true
	}
	if u.MaxCharsPerPostSet {
		if rec.GetInt("max_chars_per_post") != u.MaxCharsPerPost {
			rec.Set("max_chars_per_post", u.MaxCharsPerPost)
			changed = true
		}
	}
	if u.MaxPostsPerTopic != 0 {
		if rec.GetInt("max_posts_per_topic") != u.MaxPostsPerTopic {
			rec.Set("max_posts_per_topic", u.MaxPostsPerTopic)
			changed = true
		}
	}
	if u.PostsPerPage != 0 {
		if rec.GetInt("posts_per_page") != u.PostsPerPage {
			rec.Set("posts_per_page", u.PostsPerPage)
			changed = true
		}
	}
	if u.TopicsPerPage != 0 {
		if rec.GetInt("topics_per_page") != u.TopicsPerPage {
			rec.Set("topics_per_page", u.TopicsPerPage)
			changed = true
		}
	}
	if u.MaxCharactersPerUser != 0 {
		if rec.GetInt("max_characters_per_user") != u.MaxCharactersPerUser {
			rec.Set("max_characters_per_user", u.MaxCharactersPerUser)
			changed = true
		}
	}

	setBool := func(field string, value bool) bool {
		if rec.GetBool(field) == value {
			return false
		}
		rec.Set(field, value)
		return true
	}

	for _, f := range []struct {
		field string
		value bool
	}{
		{"registration_enabled", u.RegistrationEnabled},
		{"require_approval", u.RequireApproval},
		{"whitelist_mode", u.WhitelistMode},
		{"maintenance_mode", u.MaintenanceMode},
		{"enable_reputation", u.EnableReputation},
		{"enable_characters", u.EnableCharacters},
		{"enable_dice", u.EnableDice},
		{"allow_gif_avatars", u.AllowGifAvatars},
		{"allow_gif_in_posts", u.AllowGifInPosts},
		{"allow_user_custom_design", u.AllowUserCustomDesign},
	} {
		if setBool(f.field, f.value) {
			changed = true
		}
	}

	return changed
}

// mapsEqual compares two map[string]any for shallow equality.
func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, va := range a {
		vb, ok := b[k]
		if !ok {
			return false
		}
		if fmt.Sprintf("%v", va) != fmt.Sprintf("%v", vb) {
			return false
		}
	}
	return true
}

// SettingsFromLedger builds a SettingsUpsert from the legacy settings/global
// document in a staging ledger plan. It returns nil when the document is
// absent or holds no recognizable fields.
func SettingsFromLedger(globalSettings map[string]map[string]any) *SettingsUpsert {
	fields, ok := globalSettings["global"]
	if !ok || len(fields) == 0 {
		return nil
	}

	u := &SettingsUpsert{}

	setString := func(key string, target *string) {
		if v, ok := fields[key].(string); ok && v != "" {
			*target = v
		}
	}
	setBool := func(key string, target *bool) {
		if v, ok := fields[key].(bool); ok {
			*target = v
		}
	}
	setInt := func(key string, target *int) {
		if v, ok := fields[key]; ok {
			switch n := v.(type) {
			case float64:
				*target = int(n)
			case int:
				*target = n
			case int64:
				*target = int(n)
			}
		}
	}
	setFloat := func(key string, target *float64) {
		if v, ok := fields[key]; ok {
			switch n := v.(type) {
			case float64:
				if n != 0 {
					*target = n
				}
			case int:
				if n != 0 {
					*target = float64(n)
				}
			case int64:
				if n != 0 {
					*target = float64(n)
				}
			}
		}
	}
	setBilingual := func(key string, target *map[string]string) {
		if v, ok := fields[key]; ok {
			m, ok := v.(map[string]any)
			if !ok {
				return
			}
			out := make(map[string]string, len(m))
			for k, leaf := range m {
				if s, ok := leaf.(string); ok && strings.TrimSpace(s) != "" {
					out[k] = strings.TrimSpace(s)
				}
			}
			if len(out) > 0 {
				*target = out
			}
		}
	}

	setString("logoUrl", &u.LogoURL)
	setString("bgLight", &u.BgLight)
	setString("bgDark", &u.BgDark)
	setString("bgNeutral", &u.BgNeutral)
	setString("reputationStyle", &u.ReputationStyle)
	setString("defaultDesignId", &u.DefaultDesignID)

	setBool("registrationEnabled", &u.RegistrationEnabled)
	setBool("requireApproval", &u.RequireApproval)
	setBool("whitelistMode", &u.WhitelistMode)
	setBool("maintenanceMode", &u.MaintenanceMode)
	setBool("enableReputation", &u.EnableReputation)
	setBool("enableCharacters", &u.EnableCharacters)
	setBool("enableDice", &u.EnableDice)
	setBool("allowGifAvatars", &u.AllowGifAvatars)
	setBool("allowGifInPosts", &u.AllowGifInPosts)
	setBool("allowUserCustomDesign", &u.AllowUserCustomDesign)

	setInt("maxCharsPerPost", &u.MaxCharsPerPost)
	if _, ok := fields["maxCharsPerPost"]; ok {
		u.MaxCharsPerPostSet = true
	}
	setInt("maxPostsPerTopic", &u.MaxPostsPerTopic)
	setInt("postsPerPage", &u.PostsPerPage)
	setInt("topicsPerPage", &u.TopicsPerPage)
	setInt("maxCharactersPerUser", &u.MaxCharactersPerUser)

	setFloat("bgOpacityLight", &u.BgOpacityLight)
	setFloat("bgOpacityDark", &u.BgOpacityDark)
	setFloat("bgOpacityNeutral", &u.BgOpacityNeutral)

	setBilingual("forumName", &u.ForumName)
	setBilingual("welcomeMessage", &u.WelcomeMessage)

	if u.isEmpty() {
		return nil
	}
	return u
}

// isEmpty reports whether the upsert carries no writable fields.
func (u *SettingsUpsert) isEmpty() bool {
	return u.ForumName == nil &&
		u.WelcomeMessage == nil &&
		u.LogoURL == "" &&
		u.BgLight == "" &&
		u.BgDark == "" &&
		u.BgNeutral == "" &&
		u.BgOpacityLight == 0 &&
		u.BgOpacityDark == 0 &&
		u.BgOpacityNeutral == 0 &&
		!u.RegistrationEnabled &&
		!u.RequireApproval &&
		!u.WhitelistMode &&
		!u.MaintenanceMode &&
		!u.EnableReputation &&
		u.ReputationStyle == "" &&
		!u.EnableCharacters &&
		!u.EnableDice &&
		!u.AllowGifAvatars &&
		!u.AllowGifInPosts &&
		!u.AllowUserCustomDesign &&
		u.DefaultDesignID == "" &&
		u.MaxCharsPerPost == 0 && !u.MaxCharsPerPostSet &&
		u.MaxPostsPerTopic == 0 &&
		u.PostsPerPage == 0 &&
		u.TopicsPerPage == 0 &&
		u.MaxCharactersPerUser == 0
}

// SortedKeys returns the field names that would be written, sorted, for
// reporting purposes.
func (u *SettingsUpsert) SortedKeys() []string {
	keys := make([]string, 0, 32)
	if u.ForumName != nil {
		keys = append(keys, "forum_name")
	}
	if u.WelcomeMessage != nil {
		keys = append(keys, "welcome_message")
	}
	if u.LogoURL != "" {
		keys = append(keys, "logo_url")
	}
	if u.BgLight != "" {
		keys = append(keys, "bg_light")
	}
	if u.BgDark != "" {
		keys = append(keys, "bg_dark")
	}
	if u.BgNeutral != "" {
		keys = append(keys, "bg_neutral")
	}
	if u.BgOpacityLight != 0 {
		keys = append(keys, "bg_opacity_light")
	}
	if u.BgOpacityDark != 0 {
		keys = append(keys, "bg_opacity_dark")
	}
	if u.BgOpacityNeutral != 0 {
		keys = append(keys, "bg_opacity_neutral")
	}
	if u.RegistrationEnabled {
		keys = append(keys, "registration_enabled")
	}
	if u.RequireApproval {
		keys = append(keys, "require_approval")
	}
	if u.WhitelistMode {
		keys = append(keys, "whitelist_mode")
	}
	if u.MaintenanceMode {
		keys = append(keys, "maintenance_mode")
	}
	if u.EnableReputation {
		keys = append(keys, "enable_reputation")
	}
	if u.ReputationStyle != "" {
		keys = append(keys, "reputation_style")
	}
	if u.EnableCharacters {
		keys = append(keys, "enable_characters")
	}
	if u.EnableDice {
		keys = append(keys, "enable_dice")
	}
	if u.AllowGifAvatars {
		keys = append(keys, "allow_gif_avatars")
	}
	if u.AllowGifInPosts {
		keys = append(keys, "allow_gif_in_posts")
	}
	if u.AllowUserCustomDesign {
		keys = append(keys, "allow_user_custom_design")
	}
	if u.DefaultDesignID != "" {
		keys = append(keys, "default_design_id")
	}
	if u.MaxCharsPerPostSet {
		keys = append(keys, "max_chars_per_post")
	}
	if u.MaxPostsPerTopic != 0 {
		keys = append(keys, "max_posts_per_topic")
	}
	if u.PostsPerPage != 0 {
		keys = append(keys, "posts_per_page")
	}
	if u.TopicsPerPage != 0 {
		keys = append(keys, "topics_per_page")
	}
	if u.MaxCharactersPerUser != 0 {
		keys = append(keys, "max_characters_per_user")
	}
	sort.Strings(keys)
	return keys
}