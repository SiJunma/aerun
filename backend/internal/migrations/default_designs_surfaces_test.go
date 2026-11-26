package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestDefaultDesignsSurfacesSchema verifies the 1781000010–1781000012
// contract on a fresh database: default_designs exists server-only with the
// three seeded cards, designs carries the surface fields and no longer has
// welcome_message, and forum_settings carries header_html /
// custom_footer_html with the bg_* fields gone.
func TestDefaultDesignsSurfacesSchema(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	defaults, err := app.FindCollectionByNameOrId("default_designs")
	if err != nil {
		t.Fatalf("default_designs collection missing: %v", err)
	}
	for _, name := range []string{
		"key", "name", "description", "css", "js", "forum_title", "favicon", "favicon_url",
		"show_in_list", "header_html", "custom_footer_html",
		"bg_default", "bg_tablet", "bg_mobile", "bg_default_url", "bg_tablet_url", "bg_mobile_url", "bg_opacity",
		"placeholder_deleted", "placeholder_guest", "placeholder_deleted_url", "placeholder_guest_url",
		"overwrite_header", "overwrite_footer", "overwrite_title", "overwrite_favicon",
		"overwrite_css", "overwrite_js", "overwrite_placeholder_deleted", "overwrite_placeholder_guest",
		"created_at", "updated_at",
	} {
		if defaults.Fields.GetByName(name) == nil {
			t.Errorf("default_designs.%s is missing", name)
		}
	}
	for _, name := range []string{"is_active", "base_theme"} {
		if defaults.Fields.GetByName(name) != nil {
			t.Errorf("default_designs.%s must not exist: a default design is the base and has no activation", name)
		}
	}
	for _, rule := range []*string{defaults.ListRule, defaults.ViewRule, defaults.CreateRule, defaults.UpdateRule, defaults.DeleteRule} {
		if rule != nil {
			t.Error("default_designs must be server-only (nil browser rules)")
		}
	}

	records, err := app.FindAllRecords("default_designs")
	if err != nil {
		t.Fatalf("read default_designs: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("expected 3 seeded default designs, got %d", len(records))
	}
	wantNames := map[string]string{"dark": "Тёмная", "light": "Светлая", "neutral": "Нейтральная"}
	for _, rec := range records {
		key := rec.GetString("key")
		want, ok := wantNames[key]
		if !ok {
			t.Errorf("unexpected seeded default design key %q", key)
			continue
		}
		if got := rec.GetString("name"); got != want {
			t.Errorf("default design %q name = %q, want %q", key, got, want)
		}
		if !rec.GetBool("show_in_list") {
			t.Errorf("default design %q must start visible in the list", key)
		}
		for _, toggle := range []string{
			"overwrite_header", "overwrite_footer", "overwrite_title", "overwrite_favicon",
			"overwrite_css", "overwrite_js", "overwrite_placeholder_deleted", "overwrite_placeholder_guest",
		} {
			if rec.GetBool(toggle) {
				t.Errorf("default design %q: %s must start off (inherit surface 1)", key, toggle)
			}
		}
	}

	designs, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		t.Fatalf("designs collection missing: %v", err)
	}
	if designs.Fields.GetByName("welcome_message") != nil {
		t.Error("designs.welcome_message must be gone (renamed to header_html)")
	}
	if designs.Fields.GetByName("header_html") == nil {
		t.Error("designs.header_html is missing")
	}

	settings, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		t.Fatalf("forum_settings collection missing: %v", err)
	}
	for _, name := range []string{"header_html", "custom_footer_html"} {
		if settings.Fields.GetByName(name) == nil {
			t.Errorf("forum_settings.%s is missing", name)
		}
	}
	for _, name := range []string{
		"welcome_message", "bg_light", "bg_dark", "bg_neutral",
		"bg_opacity_light", "bg_opacity_dark", "bg_opacity_neutral",
	} {
		if settings.Fields.GetByName(name) != nil {
			t.Errorf("forum_settings.%s must be gone", name)
		}
	}
	if field := settings.Fields.GetByName("forum_name"); field == nil {
		t.Error("forum_settings.forum_name is missing")
	} else if _, ok := field.(*core.TextField); !ok {
		t.Errorf("forum_settings.forum_name must be a plain TextField, got %T", field)
	}
}

// TestDesignsSurfacesRenameCopiesValue re-creates the pre-rename state (a
// design with a stored welcome_message) and runs the migration, proving the
// value survives the rename as header_html instead of being dropped with
// the old column.
func TestDesignsSurfacesRenameCopiesValue(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		t.Fatal(err)
	}
	col.Fields.Add(&core.JSONField{Name: "welcome_message", MaxSize: 262144})
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("name", "Rename Probe")
	rec.Set("welcome_message", "<p>Привет, форум!</p>")
	if err := app.Save(rec); err != nil {
		t.Fatalf("seed legacy design: %v", err)
	}

	if err := applyDesignsSurfaces(app); err != nil {
		t.Fatalf("applyDesignsSurfaces failed: %v", err)
	}

	reloaded, err := app.FindRecordById("designs", rec.Id)
	if err != nil {
		t.Fatalf("reload design: %v", err)
	}
	if got := decodeJSONFieldValue(reloaded.Get("header_html")); got != "<p>Привет, форум!</p>" {
		t.Fatalf("header_html = %v, want the copied welcome_message", got)
	}
	after, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		t.Fatal(err)
	}
	if after.Fields.GetByName("welcome_message") != nil {
		t.Error("welcome_message must be removed after the rename")
	}

	// Second run: no-op, must not wipe the copied header.
	if err := applyDesignsSurfaces(app); err != nil {
		t.Fatalf("second applyDesignsSurfaces failed: %v", err)
	}
	again, err := app.FindRecordById("designs", rec.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeJSONFieldValue(again.Get("header_html")); got != "<p>Привет, форум!</p>" {
		t.Fatalf("second run changed header_html to %v", got)
	}
}

// TestForumSettingsSurfacesConvertsBilingual re-creates the pre-move state
// (bilingual forum_name / welcome_message plus bg_* fields) and runs the
// migration, proving the ru variants survive as plain strings and the bg
// fields are removed.
func TestForumSettingsSurfacesConvertsBilingual(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	// Re-create the legacy schema on top of the migrated one.
	if field := col.Fields.GetByName("forum_name"); field != nil {
		col.Fields.RemoveById(field.GetId())
	}
	col.Fields.Add(&core.JSONField{Name: "forum_name"})
	col.Fields.Add(&core.JSONField{Name: "welcome_message"})
	col.Fields.Add(&core.TextField{Name: "bg_light", Max: 2048})
	col.Fields.Add(&core.NumberField{Name: "bg_opacity_dark", Min: float64Ptr(0), Max: float64Ptr(1)})
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}
	row, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || row == nil {
		t.Fatalf("forum_settings row missing: %v", err)
	}
	row.Set("forum_name", map[string]any{"en": "World of Aerun", "ru": "Мир Аэрун"})
	row.Set("welcome_message", map[string]any{"en": "Hello", "ru": "Привет"})
	row.Set("bg_light", "https://example.invalid/bg.jpg")
	row.Set("bg_opacity_dark", 0.3)
	if err := app.Save(row); err != nil {
		t.Fatalf("seed legacy settings: %v", err)
	}

	if err := applyForumSettingsSurfaces(app); err != nil {
		t.Fatalf("applyForumSettingsSurfaces failed: %v", err)
	}

	reloaded, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatalf("reload settings: %v", err)
	}
	if got := reloaded.GetString("forum_name"); got != "Мир Аэрун" {
		t.Fatalf("forum_name = %q, want the ru variant", got)
	}
	if got := decodeJSONFieldValue(reloaded.Get("header_html")); got != "Привет" {
		t.Fatalf("header_html = %v, want the ru welcome_message", got)
	}
	after, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"welcome_message", "bg_light", "bg_opacity_dark"} {
		if after.Fields.GetByName(name) != nil {
			t.Errorf("forum_settings.%s must be removed", name)
		}
	}

	// Second run: the converted values must survive untouched.
	reloaded.Set("header_html", "Отредактированный хедер")
	if err := app.Save(reloaded); err != nil {
		t.Fatal(err)
	}
	if err := applyForumSettingsSurfaces(app); err != nil {
		t.Fatalf("second applyForumSettingsSurfaces failed: %v", err)
	}
	again, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeJSONFieldValue(again.Get("header_html")); got != "Отредактированный хедер" {
		t.Fatalf("second run changed header_html to %v", got)
	}
	if got := again.GetString("forum_name"); got != "Мир Аэрун" {
		t.Fatalf("second run changed forum_name to %q", got)
	}
}
