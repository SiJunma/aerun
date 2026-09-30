package migrations

// 1767600000_deterministic_seed_ids.go gives the MIGRATION-SEEDED rows fixed
// record ids.
//
// The two seeds — the system role registry (1766000000) and the bootstrap
// "General" category (1766100000) — were created with core.NewRecord and no id,
// so PocketBase assigned a random 15-character one. Every other row in the
// database is written by the importer with a derived, reproducible id, so those
// two collections were the only ones where two fresh databases could not be
// compared. The two-database equivalence check proved exactly that: 12 of 14
// collections byte-identical, and every difference in `roles` and `categories`
// being a seeded row under a different random id.
//
// That is not harmless. A reference-data row that is "the same row" should have
// the same identity on every install; otherwise support, runbooks and any future
// scripted repair cannot name it, and a restored backup cannot be proven equal
// to a rebuilt one.
//
// This is a new migration rather than an edit to the two seeds, because an
// applied migration must never be rewritten — the plan says so, and a rewritten
// seed would not re-run on an existing database anyway.
//
// Nothing references these rows by record id:
//
//   - `users.role` and `categories.allowed_roles` hold the role SLUG
//     ("root", "admin", …), not `roles.id`. `categoriesGrantingRole` compares
//     against `role_id`, and `access.go` resolves the slug the same way.
//   - `topics.category_id` DOES hold `categories.id`, so the "General" row is
//     only re-identified when no topic points at it. A database that already
//     uses the bootstrap category keeps its id, because breaking that
//     reference to make a diff prettier would be a far worse trade.

import (
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const seedIDLength = 15

func init() {
	m.Register(func(app core.App) error {
		if err := reseedSystemRoleIDs(app); err != nil {
			return fmt.Errorf("roles: %w", err)
		}
		return reseedGeneralCategoryID(app)
	}, func(app core.App) error {
		// The rows keep their data; only the surrogate id changed, and it is
		// derived from data that still exists. There is nothing to undo beyond
		// letting the next fresh install re-seed, so the down path is a no-op
		// rather than a re-randomisation.
		return nil
	})
}

// seedRecordID derives a stable 15-character id from a namespace and a key.
//
// The digest is a deterministic function, not entropy, so the output is
// reproducible across machines and runs. The alphabet is spelled out because
// every PocketBase record id column is `^[a-z0-9]{15}$`.
func seedRecordID(namespace, key string) string {
	sum := sha256.Sum256([]byte(namespace + ":" + key))
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	out := make([]byte, seedIDLength)
	for i := range out {
		out[i] = alphabet[int(sum[i])%len(alphabet)]
	}
	return string(out)
}

// reseedSystemRoleIDs re-identifies every system role from its slug.
//
// The rename is a direct UPDATE rather than a record Set: PocketBase treats `id`
// as an immutable primary key, so a Set either fails validation or is silently
// ignored, and a seeded row that still has a random id defeats the whole point.
//
// Nothing points at these ids. `users.role` and `categories.allowed_roles` both
// hold the role SLUG, not `roles.id`, so this is a pure rename of a key nothing
// uses.
func reseedSystemRoleIDs(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	recs, err := app.FindAllRecords(col, nil)
	if err != nil {
		return err
	}
	taken := map[string]bool{}
	for _, rec := range recs {
		taken[rec.Id] = true
	}

	for _, rec := range recs {
		if !rec.GetBool("is_system") {
			// Custom roles are imported with a derived id already.
			continue
		}
		roleID := strings.TrimSpace(rec.GetString("role_id"))
		if roleID == "" {
			return fmt.Errorf("system role %s has no role_id", rec.Id)
		}
		want := seedRecordID("seed_role", roleID)
		if want == rec.Id {
			continue
		}
		if taken[want] {
			return fmt.Errorf("derived role id %s is already taken", want)
		}
		if err := renameRecordID(app, "roles", rec.Id, want); err != nil {
			return fmt.Errorf("re-identify role %s: %w", roleID, err)
		}
		taken[rec.Id] = false
		taken[want] = true
	}
	return nil
}

// reseedGeneralCategoryID re-identifies the bootstrap category, but only while
// nothing refers to it.
func reseedGeneralCategoryID(app core.App) error {
	general, err := app.FindFirstRecordByFilter("categories", "slug = 'general'")
	if err != nil || general == nil {
		// No bootstrap row (a database restored from a later snapshot). Nothing
		// to do, and not an error.
		return nil
	}

	// Unlike roles, `topics.category_id` DOES hold `categories.id`, so this one
	// needs a real reference check before the rename.
	referencing, err := app.CountRecords("topics", dbx.HashExp{"category_id": general.Id})
	if err != nil {
		return fmt.Errorf("count topics in the bootstrap category: %w", err)
	}
	if referencing > 0 {
		// Renaming now would orphan every one of those topics. Keeping the
		// random id is the smaller cost by far.
		return nil
	}

	want := seedRecordID("seed_category", "general")
	if want == general.Id {
		return nil
	}
	return renameRecordID(app, "categories", general.Id, want)
}

// renameRecordID moves one row to a new primary key.
//
// The table name is a package constant, never request data, so interpolating it
// adds no injection surface — and SQLite cannot bind an identifier at all.
func renameRecordID(app core.App, table, from, to string) error {
	_, err := app.DB().NewQuery(fmt.Sprintf(
		"UPDATE %s SET id = {:to} WHERE id = {:from}", table,
	)).Bind(dbx.Params{"to": to, "from": from}).Execute()
	return err
}
