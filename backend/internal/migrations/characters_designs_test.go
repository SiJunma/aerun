package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

// TestCharactersAndDesignsCollections verifies the 1766600000 contract: both
// collections exist after the migrations, are server-only (all browser rules
// nil) and preserve historical timestamps through plain datetime fields.
func TestCharactersAndDesignsCollections(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	characters, err := app.FindCollectionByNameOrId("characters")
	if err != nil {
		t.Fatalf("characters collection missing: %v", err)
	}
	for _, name := range []string{"owner_id", "name", "status_line", "signature", "avatar_url", "created_at", "updated_at"} {
		if characters.Fields.GetByName(name) == nil {
			t.Errorf("characters.%s is missing", name)
		}
	}
	if characters.Fields.GetByName("created") != nil {
		t.Error("characters must not use autodate fields: historical dates must stay rewritable")
	}
	for _, rule := range []*string{characters.ListRule, characters.ViewRule, characters.CreateRule, characters.UpdateRule, characters.DeleteRule} {
		if rule != nil {
			t.Error("characters must be server-only (nil browser rules)")
		}
	}

	designs, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		t.Fatalf("designs collection missing: %v", err)
	}
	for _, name := range []string{"name", "css", "js", "forum_title", "favicon_url", "base_theme", "is_active", "header_html", "custom_footer_html", "bg_default", "bg_tablet", "bg_mobile", "bg_default_url", "bg_tablet_url", "bg_mobile_url", "bg_opacity", "overwrite_header", "overwrite_footer", "overwrite_title", "overwrite_favicon", "overwrite_css", "overwrite_js", "overwrite_placeholder_deleted", "overwrite_placeholder_guest", "placeholder_deleted", "placeholder_guest", "placeholder_deleted_url", "placeholder_guest_url", "created_at", "updated_at"} {
		if designs.Fields.GetByName(name) == nil {
			t.Errorf("designs.%s is missing", name)
		}
	}
	for _, rule := range []*string{designs.ListRule, designs.ViewRule, designs.CreateRule, designs.UpdateRule, designs.DeleteRule} {
		if rule != nil {
			t.Error("designs must be server-only (nil browser rules)")
		}
	}
}
