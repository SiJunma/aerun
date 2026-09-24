package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766100000_forum_command_layer.go creates the Sprint 3 forum schema behind
// the transactional command layer (plan §4 Sprint 3):
//
//   - `categories` — the forum sections. One bootstrap row ("General") is
//     seeded so a fresh install can accept the first topic without waiting
//     for the Sprint 4 category management commands.
//   - `topics` — one row per discussion topic. `posts_count` and the
//     `last_post_*` projection are denormalised for the topic list and are
//     ONLY ever written inside the same transaction as the post mutation
//     that changes them (plan invariant 1). `deleted` is a moderation
//     tombstone: soft-deleted topics disappear from every read path.
//   - `posts` — one row per post. `sequence` is the monotonic per-topic
//     ordinal assigned inside the topic transaction (plan §2.1); the UNIQUE
//     (topic_id, sequence) index is the hard guarantee against duplicates
//     under concurrency. Soft deletes keep their sequence slot (a tombstone
//     row with an emptied `content`), so the sequence space — and therefore
//     the legacy `maxPostsPerTopic` cap — is never reused.
//
// Referential columns are plain id TEXT columns (category_id, author_id,
// topic_id, ...). PocketBase RelationFields were deliberately avoided:
// equality/keyset SQL stays trivial and the Go command layer is the single
// authority that validates and maintains cross-row references (plan
// invariant 2). Browser access is locked on all three collections — reads
// and writes go through /api/aerun command routes until Sprint 4 opens
// visibility-aware read rules.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := createCategories(app); err != nil {
			return err
		}
		if err := createTopics(app); err != nil {
			return err
		}
		return createPosts(app)
	}, func(app core.App) error {
		// Best-effort down path: drop children first so the drop order
		// never leaves dangling tables behind. The up path is what
		// production runs.
		for _, name := range []string{postsCollectionTable, topicsCollectionTable, categoriesCollectionTable} {
			collection, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				continue // already removed
			}
			if err := app.Delete(collection); err != nil {
				return err
			}
		}
		return nil
	})
}

// Collection names shared by the migration, the command layer and tests.
// They live here so the migration stays self-contained; the adapter
// declares its own compile-time copies and the schema tests keep them in
// sync.
const (
	categoriesCollectionTable = "categories"
	topicsCollectionTable     = "topics"
	postsCollectionTable      = "posts"
)

// lockBrowserRules sets every collection rule to nil (superuser-only), the
// same deny-by-default posture used for `roles`: the browser API can neither
// read nor write the forum collections directly while the /api/aerun command
// layer owns all mutations and Sprint 4 has not yet landed visibility-aware
// read rules.
func lockBrowserRules(collection *core.Collection) {
	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
}

func createCategories(app core.App) error {
	collection := core.NewBaseCollection(categoriesCollectionTable)

	collection.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "name", Required: true, Max: 128},
		&core.TextField{Name: "slug", Required: true, Max: 128},
		&core.TextField{Name: "description", Max: 1024},
		&core.NumberField{Name: "sort_order", OnlyInt: true},
	)
	lockBrowserRules(collection)
	collection.AddIndex("idx_categories_slug", true, "slug", "")

	if err := app.Save(collection); err != nil {
		return err
	}

	// Bootstrap row: a fresh install can host its first topic immediately;
	// Sprint 4 adds the management commands for the rest of the board.
	general := core.NewRecord(collection)
	general.Set("name", "General")
	general.Set("slug", "general")
	general.Set("description", "General discussion")
	general.Set("sort_order", 0)
	return app.Save(general)
}

func createTopics(app core.App) error {
	collection := core.NewBaseCollection(topicsCollectionTable)

	collection.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "category_id", Required: true, Max: 15},
		&core.TextField{Name: "author_id", Required: true, Max: 15},
		&core.TextField{Name: "title", Required: true, Max: 256},
		&core.NumberField{Name: "posts_count", OnlyInt: true},
		&core.BoolField{Name: "locked"},
		&core.BoolField{Name: "pinned"},
		&core.BoolField{Name: "deleted"},
		// last_post_* mirrors the latest VISIBLE post; when every post is
		// gone the command layer keeps a non-null timestamp (tombstone
		// fallback) so the keyset cursor over (pinned, last_post_created,
		// id) never meets a NULL and drops rows from the list.
		&core.TextField{Name: "last_post_id", Max: 15},
		&core.DateField{Name: "last_post_created"},
		&core.TextField{Name: "last_post_author_id", Max: 15},
	)
	lockBrowserRules(collection)
	// Keyset (cursor) ordering: pinned DESC, last_post_created DESC, id DESC
	// walks these composite indexes backwards, so the list endpoint stays a
	// single index scan no matter how deep the pagination goes (plan §2.1).
	collection.AddIndex("idx_topics_list", false, "pinned, last_post_created, id", "")
	collection.AddIndex("idx_topics_category_list", false, "category_id, pinned, last_post_created, id", "")
	collection.AddIndex("idx_topics_author", false, "author_id", "")

	return app.Save(collection)
}

func createPosts(app core.App) error {
	collection := core.NewBaseCollection(postsCollectionTable)

	collection.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "topic_id", Required: true, Max: 15},
		&core.TextField{Name: "author_id", Required: true, Max: 15},
		&core.NumberField{Name: "sequence", Required: true, OnlyInt: true},
		// Not Required: a soft-deleted post empties its content (text hard
		// delete, tombstone row). The command layer enforces the
		// non-empty/maxChars contract for every visible post.
		&core.TextField{Name: "content", Max: 65536},
		&core.BoolField{Name: "deleted"},
		&core.DateField{Name: "edited"},
		// editor_id is set only when a moderator (not the author) edited the
		// post; empty otherwise.
		&core.TextField{Name: "editor_id", Max: 15},
	)
	lockBrowserRules(collection)
	// The uniqueness backstop for plan invariant 6/§3: two concurrent
	// replies can never claim the same per-topic sequence.
	collection.AddIndex("idx_posts_topic_sequence", true, "topic_id, sequence", "")
	collection.AddIndex("idx_posts_author", false, "author_id", "")

	return app.Save(collection)
}
