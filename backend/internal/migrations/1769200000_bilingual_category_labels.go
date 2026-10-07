package migrations

// 1769200000 gives category groups and categories somewhere to keep BOTH
// language versions of their labels.
//
// WHY. The legacy Firestore documents stored `{en, ru}` title/description maps.
// The PocketBase cutover deliberately collapsed them to a single string at every
// layer (TASK-2 §contract, 1767500000): the importer kept Russian and dropped
// English, the command layer accepted one string, and the client duplicated that
// string into both columns of its form. The admin board still has two independent
// inputs per label — Title (EN) and Title (RU) — so an EN edit was accepted,
// thrown away by `pickTitle` (Russian wins), and served back as BOTH languages:
// the toast said "saved" while the English key silently reverted to Russian.
//
// The fix restores the round trip the UI was built for:
//
//   - `title_i18n` / `name_i18n` / `description_i18n` (JSON) hold `{en, ru}`.
//   - The legacy `title` / `name` / `description` text columns are KEPT and keep
//     holding the primary rendering (Russian, English as fallback). Slug
//     derivation, the importer's match checks, audit rows and every other
//     single-string reader stay untouched — a JSON object in `categories.name`
//     would have broken the UNIQUE slug contract by transliterating key names.
//   - Rows written before this migration (or by the importer, which still
//     collapses the maps) have no i18n payload; the read path falls back to the
//     legacy string in both languages, which is exactly what it serves today.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// Label i18n ceilings. Twice the per-language text limit (128 / 1024) plus room
// for the JSON envelope and UTF-8 expansion; the command layer enforces the real
// per-language lengths, the field MaxSize is only the backstop.
const (
	groupTitleI18nMaxSize   = 2048
	categoryNameI18nMaxSize = 2048
	categoryDescI18nMaxSize = 8192
)

func init() {
	m.Register(applyBilingualCategoryLabels, revertBilingualCategoryLabels)
}

func applyBilingualCategoryLabels(app core.App) error {
	groups, err := app.FindCollectionByNameOrId("category_groups")
	if err != nil {
		return fmt.Errorf("category_groups: %w", err)
	}
	ensureField(groups, &core.JSONField{Name: "title_i18n", MaxSize: groupTitleI18nMaxSize})
	if err := app.Save(groups); err != nil {
		return fmt.Errorf("category_groups.title_i18n: %w", err)
	}

	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		return fmt.Errorf("categories: %w", err)
	}
	ensureField(categories, &core.JSONField{Name: "name_i18n", MaxSize: categoryNameI18nMaxSize})
	ensureField(categories, &core.JSONField{Name: "description_i18n", MaxSize: categoryDescI18nMaxSize})
	if err := app.Save(categories); err != nil {
		return fmt.Errorf("categories i18n: %w", err)
	}
	return nil
}

func revertBilingualCategoryLabels(app core.App) error {
	if groups, err := app.FindCollectionByNameOrId("category_groups"); err == nil {
		groups.Fields.RemoveByName("title_i18n")
		if err := app.Save(groups); err != nil {
			return fmt.Errorf("revert category_groups.title_i18n: %w", err)
		}
	}
	if categories, err := app.FindCollectionByNameOrId("categories"); err == nil {
		categories.Fields.RemoveByName("name_i18n")
		categories.Fields.RemoveByName("description_i18n")
		if err := app.Save(categories); err != nil {
			return fmt.Errorf("revert categories i18n: %w", err)
		}
	}
	return nil
}
