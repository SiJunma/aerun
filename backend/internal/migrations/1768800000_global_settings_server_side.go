package migrations

// 1768800000_global_settings_server_side.go moves the admin panel's global
// settings out of the browser and onto the server, next to the limits that
// already live here.
//
// WHY THIS MIGRATION EXISTS. getGlobalSettings read `aerun_global_settings` from
// localStorage and updateGlobalSettings wrote it back there. That was not a
// caching decision, it was the only store: the server had no copy of any of
// these values. Three consequences, in increasing order of seriousness:
//
//   - An admin renamed the forum, enabled characters, changed a background.
//     Nobody else saw any of it. The setting applied to the browser that wrote
//     it and to nothing else, ever.
//   - requireApproval and whitelistMode govern who may post and who may
//     register. A member who never opened the admin panel simply had no such
//     value in their storage, so the gate was whatever their browser defaulted
//     to. An access control a client can omit is not an access control.
//   - maintenanceMode is a switch meant to take the forum down. It could not:
//     every visitor without the admin's localStorage saw a working forum.
//
// 1767800000 already established the fix for the sibling values (post limit,
// page sizes) with exactly this reasoning, and forum_settings.go documents it.
// This migration finishes the job for the rest.
//
// BRANDING IS JSON, NOT TWO COLUMNS. forumName and welcomeMessage are bilingual
// ({en, ru}) on the client and have been since the Firestore export carried
// `forum_Name: {ru: "Мир Аэрун"}`. Two columns would make every read site pick a
// language, and the pick would drift between the title bar, the mail signature
// and the welcome text. A JSON object keeps the choice where it already is —
// in the consumer that knows the reader's language.
//
// NUMBERS ARE CLAMPED AT THE FIELD, and max_chars_per_post gets a ceiling
// because it is enforced server-side on every post write; without a Max an admin
// could set a limit of zero and lock members out of posting, which is a
// different kind of outage than the one maintenance mode exists for.
//
// NOTHING IS SEEDED FROM THE FIRESTORE VALUES HERE. The importer reports branding
// as GlobalSettingBranding for the operator to apply deliberately, and guessing
// at this migration's authoring time — weeks after the import ran — would
// resurrect defaults that silently override what the operator chose.

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyGlobalSettingsServerSide, revertGlobalSettingsServerSide)
}

// reputationStyleValues mirrors the two options the admin panel's select offers.
// Declared here so the collection validation and the read path cannot disagree
// about what is legal.
var reputationStyleValues = []string{"both", "positive_only"}

// defaultForumName is the fallback brand, and it is a DEFAULTS entry rather than
// a hardcoded brand: it seeds one database row that the admin panel can edit,
// and everything that needs a forum name reads that row. The value matches what
// AdminPage has always displayed as its initial state, so a forum that never
// touched the admin panel looks identical after the migration.
var defaultForumName = map[string]any{"en": "Aerun", "ru": "Aerun"}

var defaultWelcomeMessage = map[string]any{
	"en": "",
	"ru": "",
}

// defaultMaxCharsPerPost matches the admin panel's initial maxCharsPerPost.
const defaultMaxCharsPerPost = 15000

func applyGlobalSettingsServerSide(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return err
	}

	added := false
	for _, field := range globalSettingsFields() {
		if col.Fields.GetByName(field.GetName()) == nil {
			col.Fields.Add(field)
			added = true
		}
	}
	if added {
		if err := app.Save(col); err != nil {
			return fmt.Errorf("forum_settings fields: %w", err)
		}
	}

	// Seed the row with the values the admin panel has always displayed, so an
	// untouched forum renders exactly as it did before this migration.
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return nil // An absent row already reads as the defaults on loadForumSettings.
	}
	if seedGlobalSettings(record) {
		if err := app.Save(record); err != nil {
			return fmt.Errorf("seed forum settings: %w", err)
		}
	}
	return nil
}

// globalSettingsFields is every field this migration owns, by database name.
//
// The list doubles as the removal list, so a revert cannot drift from an apply:
// one declaration, used for both directions. It is a function because Field
// values are mutated when they are added to a collection (each binds to its
// owner), so a shared package-level slice reused across an apply/revert cycle
// would carry a stale collection pointer.
func globalSettingsFields() []core.Field {
	return []core.Field{
		// --- Branding --------------------------------------------------
		&core.JSONField{Name: "forum_name"},
		&core.JSONField{Name: "welcome_message"},
		&core.TextField{Name: "logo_url", Max: 2048},
		&core.TextField{Name: "bg_light", Max: 2048},
		&core.TextField{Name: "bg_dark", Max: 2048},
		&core.TextField{Name: "bg_neutral", Max: 2048},
		// Opacity is a CSS alpha in 0..1. The Min/Max pair is the clamp that
		// keeps an admin from rendering an unreadable forum by typing 5 into a
		// slider.
		&core.NumberField{Name: "bg_opacity_light", Min: float64Ptr(0), Max: float64Ptr(1)},
		&core.NumberField{Name: "bg_opacity_dark", Min: float64Ptr(0), Max: float64Ptr(1)},
		&core.NumberField{Name: "bg_opacity_neutral", Min: float64Ptr(0), Max: float64Ptr(1)},

		// --- Access ---------------------------------------------------
		// These four are why this migration is not cosmetic: see the header.
		&core.BoolField{Name: "registration_enabled"},
		&core.BoolField{Name: "require_approval"},
		&core.BoolField{Name: "whitelist_mode"},
		&core.BoolField{Name: "maintenance_mode"},

		// --- Features -------------------------------------------------
		&core.BoolField{Name: "enable_reputation"},
		&core.SelectField{
			Name:      "reputation_style",
			MaxSelect: 1,
			Values:    reputationStyleValues,
		},
		&core.BoolField{Name: "enable_characters"},
		&core.BoolField{Name: "enable_dice"},
		&core.BoolField{Name: "allow_gif_avatars"},
		&core.BoolField{Name: "allow_gif_in_posts"},
		&core.BoolField{Name: "allow_user_custom_design"},
		&core.TextField{Name: "default_design_id", Max: 32},

		// --- Limits ----------------------------------------------------
		// Enforced on every post write, hence a real ceiling. Min is 0: the
		// admin panel's label promises "0 = unlimited" and 0 is the value the
		// legacy Firestore export carried. Required must stay FALSE — a
		// required NumberField rejects 0 as a missing value, which would make
		// the promised unlimited state impossible to save.
		&core.NumberField{
			Name:     "max_chars_per_post",
			Min:      float64Ptr(0),
			Max:      float64Ptr(1_000_000),
			Required: false,
		},
	}
}

// seedGlobalSettings writes only ABSENT values.
//
// A BoolField reads an unset column as false, which is indistinguishable from an
// admin who deliberately turned the feature off. Writing the default
// unconditionally would therefore re-enable a disabled feature on every boot —
// exactly the class of bug 1767700000 documents when it refused to leave a
// constant `false` column behind. So every default is written only when the row
// does not already carry it.
//
// The two bilingual JSON fields are the exception: an absent JSON column reads
// as an empty object, and an empty forum name would render as an empty title
// bar, so those are seeded whenever they are blank.
func seedGlobalSettings(record *core.Record) bool {
	changed := false

	// BoolField initializes to false (not nil) on an existing row when a new
	// column is added — so record.Get returns false, not nil, and a nil-check
	// never fires. All of these columns are brand-new to this migration, so no
	// prior admin value exists to protect: unconditional write is correct.
	seedBool := func(name string, def bool) {
		record.Set(name, def)
		changed = true
	}
	seedText := func(name, def string) {
		if strings.TrimSpace(record.GetString(name)) == "" {
			record.Set(name, def)
			changed = true
		}
	}
	// NumberField columns initialize to float64(0) on an existing row when the
	// field is added to the schema — not nil — so record.Get returns 0.0, not
	// nil, and a nil-check never fires. Using GetFloat and comparing to 0 seeds
	// both the absent column and any row that somehow holds an invalid zero.
	// This is safe: every valid value this function writes is > 0.
	seedNumber := func(name string, def float64) {
		if record.GetFloat(name) == 0 {
			record.Set(name, def)
			changed = true
		}
	}
	seedBilingual := func(name string, def map[string]any) {
		if strings.TrimSpace(record.GetString(name)) == "" {
			record.Set(name, def)
			changed = true
		}
	}

	seedBilingual("forum_name", defaultForumName)
	seedBilingual("welcome_message", defaultWelcomeMessage)

	seedText("logo_url", "")
	seedBool("registration_enabled", true)
	seedBool("require_approval", true)
	seedBool("whitelist_mode", false)
	seedBool("maintenance_mode", false)
	seedBool("enable_reputation", true)
	seedText("reputation_style", "both")
	seedBool("enable_characters", true)
	seedBool("enable_dice", true)
	seedBool("allow_gif_avatars", true)
	seedBool("allow_gif_in_posts", true)
	seedBool("allow_user_custom_design", true)
	seedText("default_design_id", "")

	seedNumber("max_chars_per_post", defaultMaxCharsPerPost)
	seedNumber("bg_opacity_light", 0.5)
	seedNumber("bg_opacity_dark", 0.5)
	seedNumber("bg_opacity_neutral", 0.5)

	return changed
}

func revertGlobalSettingsServerSide(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return err
	}
	for _, field := range globalSettingsFields() {
		col.Fields.RemoveByName(field.GetName())
	}
	return app.Save(col)
}
