package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000011_forum_settings_surfaces.go moves the forum_settings singleton to
// the surfaces model (PLAN_DESIGNS_TAB_SURFACES.md §7.2):
//
//   - welcome_message {en, ru} -> header_html, a single HTML string (the ru
//     variant, plan §9 question 10); forum_name {en, ru} -> forum_name, a
//     plain single-variant string (ru as well);
//   - new custom_footer_html JSONField, a single HTML string;
//   - removed: bg_light / bg_dark / bg_neutral and bg_opacity_light /
//     bg_opacity_dark / bg_opacity_neutral. Backgrounds now live on design
//     cards; the old values are lost consciously (plan §1 point 8) — the
//     images themselves were external URLs, nothing stored is deleted.
//
// Old migrations are untouched: 1768800000 still creates welcome_message and
// the bg_* fields, this migration converts and removes them.
func init() {
	m.Register(applyForumSettingsSurfaces, revertForumSettingsSurfaces)
}

var forumSettingsSurfaceRemovedFields = []core.Field{
	&core.TextField{Name: "bg_light", Max: 2048},
	&core.TextField{Name: "bg_dark", Max: 2048},
	&core.TextField{Name: "bg_neutral", Max: 2048},
	&core.NumberField{Name: "bg_opacity_light", Min: float64Ptr(0), Max: float64Ptr(1)},
	&core.NumberField{Name: "bg_opacity_dark", Min: float64Ptr(0), Max: float64Ptr(1)},
	&core.NumberField{Name: "bg_opacity_neutral", Min: float64Ptr(0), Max: float64Ptr(1)},
}

func applyForumSettingsSurfaces(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return fmt.Errorf("forum_settings: %w", err)
	}

	ensureField(col, &core.JSONField{Name: "header_html", MaxSize: 262144})
	ensureField(col, &core.JSONField{Name: "custom_footer_html", MaxSize: 262144})
	if err := app.Save(col); err != nil {
		return fmt.Errorf("forum_settings surface fields: %w", err)
	}

	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		// No singleton row: still remove the dead fields below so the schema
		// converges even on a database that never seeded the row.
	} else {
		// Read the legacy values BEFORE the schema change: removing a field
		// drops its column, and changing forum_name's type replaces it.
		hadWelcome := col.Fields.GetByName("welcome_message") != nil
		legacyHeader := ""
		if hadWelcome {
			legacyHeader = bilingualLeaf(record.Get("welcome_message"))
		}
		legacyName := ""
		if col.Fields.GetByName("forum_name") != nil {
			legacyName = bilingualLeaf(record.Get("forum_name"))
		}

		// forum_name changes type (JSONField -> TextField): drop the old field
		// and add the new one with the same name, then restore the value.
		if field := col.Fields.GetByName("forum_name"); field != nil {
			col.Fields.RemoveById(field.GetId())
		}
		col.Fields.Add(&core.TextField{Name: "forum_name", Max: 512})
		for _, field := range forumSettingsSurfaceRemovedFields {
			col.Fields.RemoveByName(field.GetName())
		}
		if field := col.Fields.GetByName("welcome_message"); field != nil {
			col.Fields.RemoveById(field.GetId())
		}
		if err := app.Save(col); err != nil {
			return fmt.Errorf("forum_settings remove legacy fields: %w", err)
		}

		// Re-fetch the row: the copy loaded above still carries values for
		// the dropped columns, and saving it would try to write columns
		// that no longer exist.
		record, err = app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil || record == nil {
			return fmt.Errorf("forum_settings reload after schema change: %w", err)
		}
		record.Set("forum_name", legacyName)
		// Only write header_html when the legacy field actually existed: a
		// second run must not wipe a header the admin set after the move.
		if hadWelcome {
			record.Set("header_html", legacyHeader)
		}
		if err := app.Save(record); err != nil {
			return fmt.Errorf("forum_settings convert branding: %w", err)
		}
		return nil
	}

	// No row: schema-only convergence.
	if field := col.Fields.GetByName("forum_name"); field != nil {
		col.Fields.RemoveById(field.GetId())
	}
	col.Fields.Add(&core.TextField{Name: "forum_name", Max: 512})
	for _, field := range forumSettingsSurfaceRemovedFields {
		col.Fields.RemoveByName(field.GetName())
	}
	if field := col.Fields.GetByName("welcome_message"); field != nil {
		col.Fields.RemoveById(field.GetId())
	}
	return app.Save(col)
}

func revertForumSettingsSurfaces(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil || col == nil {
		return nil
	}

	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		// Schema-only revert.
		if field := col.Fields.GetByName("forum_name"); field != nil {
			col.Fields.RemoveById(field.GetId())
		}
		col.Fields.Add(&core.JSONField{Name: "forum_name"})
		col.Fields.Add(&core.JSONField{Name: "welcome_message"})
		for _, field := range forumSettingsSurfaceRemovedFields {
			ensureField(col, field)
		}
		col.Fields.RemoveByName("header_html")
		col.Fields.RemoveByName("custom_footer_html")
		return app.Save(col)
	}

	// Read the converted values before the schema change.
	name := record.GetString("forum_name")
	header := ""
	if v := decodeJSONFieldValue(record.Get("header_html")); v != nil {
		if s, ok := v.(string); ok {
			header = s
		}
	}

	if field := col.Fields.GetByName("forum_name"); field != nil {
		col.Fields.RemoveById(field.GetId())
	}
	col.Fields.Add(&core.JSONField{Name: "forum_name"})
	col.Fields.Add(&core.JSONField{Name: "welcome_message"})
	for _, field := range forumSettingsSurfaceRemovedFields {
		ensureField(col, field)
	}
	col.Fields.RemoveByName("header_html")
	col.Fields.RemoveByName("custom_footer_html")
	if err := app.Save(col); err != nil {
		return err
	}

	// Re-fetch: the copy above still carries the dropped header_html value.
	record, err = app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return fmt.Errorf("forum_settings reload after schema change: %w", err)
	}
	record.Set("forum_name", map[string]any{"en": name, "ru": name})
	record.Set("welcome_message", map[string]any{"en": "", "ru": header})
	return app.Save(record)
}
