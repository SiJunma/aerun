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
	for _, name := range []string{"name", "css", "js", "forum_title", "is_active", "welcome_message", "created_at", "updated_at"} {
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
