package importer

// Tests for the settings/global classification (the owner decision that global
// forum settings stay deployment configuration, while per-user settings live in
// users.settings).
//
// The env-name conversion is pinned here because it was wrong once: the
// arithmetic case change (`r-'a'+'A'`) ADDS the offset instead of subtracting it,
// so `whitelistMode` produced `whitelist_-ode` — an env var name that looks
// plausible in a table and names nothing.

import (
	"strings"
	"testing"
)

func globalSettingsPlan(keys map[string]any) *ImportPlan {
	return &ImportPlan{
		Users:          map[string]map[string]any{},
		Roles:          map[string]map[string]any{},
		Skipped:        map[string]int{},
		GlobalSettings: map[string]map[string]any{"global": keys},
	}
}

func rowFor(t *testing.T, rows []GlobalSettingRow, key string) GlobalSettingRow {
	t.Helper()
	for _, row := range rows {
		if row.Key == key {
			return row
		}
	}
	t.Fatalf("key %q was not classified", key)
	return GlobalSettingRow{}
}

// TestEnvNameForConvertsCamelCase pins the conversion. Every expectation here is
// a name a human would actually type into a deployment manifest.
func TestEnvNameForConvertsCamelCase(t *testing.T) {
	cases := map[string]string{
		"whitelistMode":       "whitelist_Mode",
		"maxUploadSize":       "max_Upload_Size",
		"allowGifInPosts":     "allow_Gif_In_Posts",
		"forumName":           "forum_Name",
		"bgOpacityLight":      "bg_Opacity_Light",
		"maxPostsPerTopic":    "max_Posts_Per_Topic",
		"defaultDesignId":     "default_Design_Id",
		"registrationEnabled": "registration_Enabled",
		"alllowercase":        "alllowercase",
	}
	for in, want := range cases {
		if got := envNameFor(in); got != want {
			t.Errorf("envNameFor(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEnvNameForDoesNotCorruptLetters is the regression test for the arithmetic
// bug: every uppercase letter must survive as itself.
func TestEnvNameForDoesNotCorruptLetters(t *testing.T) {
	for _, r := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
		if got := envNameFor(string(r)); got != "_"+string(r) && got != string(r) {
			t.Errorf("envNameFor(%q) = %q, which is not the letter itself", string(r), got)
		}
	}
	if got := envNameFor("whitelistMode"); strings.Contains(got, "-") {
		t.Errorf("envNameFor produced a dash: %q", got)
	}
}

// TestClassifyGlobalSettingsSeparatesEnforcedBehaviour is the point of the
// report. `whitelistMode=false` sitting in an env-var table must not read as
// "registration is now configurable" — registration is gated by the compiled
// role matrix and users.status, and the row says so.
func TestClassifyGlobalSettingsSeparatesEnforcedBehaviour(t *testing.T) {
	plan := globalSettingsPlan(map[string]any{
		"whitelistMode":   false,
		"requireApproval": false,
		"maxUploadSize":   float64(500),
		"forumName":       map[string]any{"ru": "Мир Аэрун"},
	})

	rows := ClassifyGlobalSettings(plan)

	whitelist := rowFor(t, rows, "whitelistMode")
	if whitelist.Class != GlobalSettingEnforced {
		t.Errorf("whitelistMode class = %q, want %q", whitelist.Class, GlobalSettingEnforced)
	}
	if whitelist.Note == "" {
		t.Error("an enforced row must explain where the behaviour actually lives")
	}
	if whitelist.EnvVar != "PB_SETTINGS_whitelist_Mode" {
		t.Errorf("whitelistMode env var = %q", whitelist.EnvVar)
	}

	upload := rowFor(t, rows, "maxUploadSize")
	if upload.Class != GlobalSettingEnv {
		t.Errorf("maxUploadSize class = %q, want %q", upload.Class, GlobalSettingEnv)
	}
	if upload.Note != "" {
		t.Errorf("a plain env row must carry no note, got %q", upload.Note)
	}

	forum := rowFor(t, rows, "forumName")
	if forum.Class != GlobalSettingBranding {
		t.Errorf("forumName class = %q, want %q", forum.Class, GlobalSettingBranding)
	}
	// The nested object is rendered as its leaves, not a Go map dump.
	if !strings.Contains(forum.Value, "ru=") {
		t.Errorf("forumName value = %q, want the leaf keys", forum.Value)
	}
}

// TestClassifyGlobalSettingsIsSortedAndDeterministic guards the report's
// stability: same input, same bytes, so a diff of two rehearsals is meaningful.
func TestClassifyGlobalSettingsIsSortedAndDeterministic(t *testing.T) {
	plan := globalSettingsPlan(map[string]any{
		"zeta": float64(1), "alpha": float64(2), "mid": float64(3),
	})
	first := ClassifyGlobalSettings(plan)
	second := ClassifyGlobalSettings(globalSettingsPlan(map[string]any{
		"mid": float64(3), "zeta": float64(1), "alpha": float64(2),
	}))
	if len(first) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(first))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("row %d differs: %+v vs %+v", i, first[i], second[i])
		}
	}
	if first[0].Key != "alpha" {
		t.Errorf("rows must be sorted by key, got %q first", first[0].Key)
	}
}

// TestClassifyGlobalSettingsWithNoDocument is the empty case: a snapshot without
// a settings document must not panic or invent rows.
func TestClassifyGlobalSettingsWithNoDocument(t *testing.T) {
	plan := &ImportPlan{GlobalSettings: map[string]map[string]any{}}
	if rows := ClassifyGlobalSettings(plan); len(rows) != 0 {
		t.Fatalf("expected no rows, got %d", len(rows))
	}
}

// TestTruncateValueBoundsLongValues pins that a multi-kilobyte HTML setting
// cannot break the report layout.
func TestTruncateValueBoundsLongValues(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := truncateValue(long)
	if len(got) > maxSettingValueChars+20 {
		t.Errorf("truncated value is still %d chars", len(got))
	}
	if !strings.Contains(got, "500 chars") {
		t.Errorf("truncated value should state the original length, got %q", got)
	}
	if short := truncateValue(42); short != "42" {
		t.Errorf("a short value must pass through, got %q", short)
	}
}
