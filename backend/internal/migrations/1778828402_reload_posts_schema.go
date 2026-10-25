// 1778828402_reload_posts_schema.go forcibly reloads the posts collection
// schema into PocketBase memory.
//
// WHY. PocketBase caches the collection schema in memory at startup. When a
// migration updates a field (e.g. posts.content Max 5000 -> 65536) via
// app.Save(), the database row changes but the in-memory cache is NOT
// automatically invalidated unless the save actually modifies something.
// If the DB already has Max=65536 (from migration 1766100000), a conditional
// `if textField.Max != 65536 { app.Save() }` never calls Save, and the server
// keeps serving the stale in-memory schema with Max=5000.
//
// This migration unconditionally calls app.Save(posts) so PocketBase re-reads
// the collection definition from the database and refreshes its in-memory
// schema cache.
//
// Idempotent: safe to re-run.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(reloadPostsSchema, revertReloadPostsSchema)
}

func reloadPostsSchema(app core.App) error {
	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil {
		return fmt.Errorf("find posts collection: %w", err)
	}
	// Always save to force PocketBase to reload the collection schema into
	// memory, even if the DB value already matches. This invalidates any
	// stale in-memory schema cache (e.g. Max=5000 from a previous run).
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("reload posts collection schema: %w", err)
	}
	app.Logger().Info("posts collection schema reloaded into memory", "collection", postsCollectionTable)
	return nil
}

func revertReloadPostsSchema(app core.App) error {
	return nil
}
