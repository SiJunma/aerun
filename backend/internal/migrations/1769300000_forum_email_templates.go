package migrations

// 1769300000_forum_email_templates.go adds `email_templates` — a JSON column on
// the forum_settings singleton — as the single, admin-editable home for the
// global email wrapper.
//
// WHY forum_settings AND NOT PocketBase's own template store. The per-type auth
// templates (verification / password reset / email change) live in the users
// collection's authOptions, and PocketBase already renders them inside its own
// generic layout, so an admin editing them there can never change the design
// chrome. The forum's mail identity is a forum setting the same way forum_name,
// the logo and the backgrounds are: it belongs where the admin board already is,
// it survives restarts untouched, and every mail (auth + notification) reads the
// one column through the resolver.
//
// WHY SEED AN EMPTY OBJECT, NOT THE FULL DEFAULT HTML. The rich wrapper is
// authored once, in Go, in mail_templates.go (see loadEmailTemplates), and the
// resolver returns it whenever this column is empty. A migration runs exactly
// once and is immutable: freezing the HTML here would strand every database
// created before the wrapper was refined with a copy no restart can refresh.
// Seeding `{}` keeps the column a valid, editable JSON object while leaving the
// Go constant as the single source of truth the resolver falls back to — the
// same "default in files, the stored value is authoritative and never
// overwritten" contract the SMTP settings use.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// emailTemplatesMaxSize bounds the whole JSON object. It holds the HTML wrapper
// for every mail type (subject + body); 64 KB leaves ample room for the design
// chrome and several types at once without becoming an unbounded blob.
const emailTemplatesMaxSize = 65536

func init() {
	m.Register(applyForumEmailTemplates, revertForumEmailTemplates)
}

func applyForumEmailTemplates(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return fmt.Errorf("forum_settings: %w", err)
	}

	ensureField(col, &core.JSONField{
		Name:    "email_templates",
		MaxSize: emailTemplatesMaxSize,
	})
	if err := app.Save(col); err != nil {
		return fmt.Errorf("forum_settings.email_templates field: %w", err)
	}

	// Seed the existing singleton row to a valid empty object, so the column is
	// immediately editable and every DB — not only freshly created ones — holds
	// JSON rather than null. The resolver supplies the real default wrapper when
	// the map is empty (see loadEmailTemplates); this never overwrites a value an
	// admin has already saved.
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		// Nothing to repair — an absent row already reads as empty.
		return nil
	}
	if !emailTemplatesEmpty(record.GetString("email_templates")) {
		return nil
	}
	record.Set("email_templates", map[string]any{})
	if err := app.Save(record); err != nil {
		return fmt.Errorf("seed forum_settings.email_templates: %w", err)
	}
	return nil
}

// emailTemplatesEmpty reports whether the stored JSON is unset. A JSONField
// added to an existing row reads as "", "null" or "{}" depending on how the
// driver materialised it; all three mean "no templates stored yet".
func emailTemplatesEmpty(raw string) bool {
	switch strings.TrimSpace(raw) {
	case "", "null", "{}":
		return true
	default:
		return false
	}
}

func revertForumEmailTemplates(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}
	if col.Fields.GetByName("email_templates") == nil {
		return nil
	}
	col.Fields.RemoveByName("email_templates")
	return app.Save(col)
}
