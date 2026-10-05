package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// topicReadStatesCollectionTable is the per-member "where I stopped reading"
// table (internal/platform/pocketbase/notifications.go).
const topicReadStatesCollectionTable = "topic_read_states"

// 1768300000_topic_read_states.go gives unread-topic counting a server-side read
// state to count against.
//
// The client used to keep this in localStorage (`aerun_readmap_<uid>`), and the
// unread badge was computed in the browser from a `topics?limit=50` list. That
// arrangement could not produce a correct number for three separate reasons, and
// only one of them was about cost:
//
//  1. The list was capped. A member with 60 unread topics was told 50, because
//     `limit=50` is a page size being used as a total.
//  2. It was per-browser. Reading a topic on the desktop did not mark it read on
//     the phone, so the same member saw two different counts depending on the
//     device, with no way for either to be wrong-looking.
//  3. It ignored category visibility. The client filtered with a local
//     `hasPermission` over the categories it happened to have loaded, so a topic
//     in a category this member may not read still counted towards the badge —
//     a number larger than the list it summarises.
//
// The count moves to the server (see countUnreadTopics), and this table is what
// it counts against. One row per (user, topic), written when a member opens a
// topic or marks all read, and it holds a timestamp rather than a boolean:
// "unread since when" is the only question, and a bool cannot answer it for the
// member who read a topic before someone replied.
//
// Retention is deliberately absent. One row per topic a member ever opens is
// bounded by the forum's own topic count, which is the same order as the
// subscriptions table next to it; a prune here would be a deletion path with
// nothing to reclaim.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		collection := core.NewBaseCollection(topicReadStatesCollectionTable)
		// Plain text ids, not RelationFields, and that is a deliberate match to
		// the rest of this schema rather than a shortcut. dm_members, topic_
		// subscriptions and the rest all hold `user_id`/`topic_id` as TextField
		// with Max 15, and the ids are PocketBase's own 15-character keys.
		//
		// A RelationField would look tidier and would break: it stores the target
		// COLLECTION ID, and at this point in the migration sequence neither
		// `users` nor `topics` is resolvable by name in a fresh database, so the
		// migration fails with "the relation collection doesn't exist" before any
		// of this code is exercised. Consistency with dm_members also means the
		// cascade rules for a deleted topic live in one place — the delete
		// handlers, which already settle their denormalized copies — instead of
		// being duplicated as a field flag.
		collection.Fields.Add(
			&core.TextField{Name: "user_id", Required: true, Max: 15},
			&core.TextField{Name: "topic_id", Required: true, Max: 15},
			// Plain datetime, never autodate `updated`: this IS the payload. A
			// member's read position is the instant they last looked, and it must
			// not move when the row is re-saved for any other reason.
			&core.DateField{Name: "last_read_at"},
		)
		// Server-only, like every other collection the command layer owns. The
		// browser writes read state through POST /topics/:id/read; nothing needs
		// direct collection access.
		collection.ListRule = nil
		collection.ViewRule = nil
		collection.CreateRule = nil
		collection.UpdateRule = nil
		collection.DeleteRule = nil
		// One row per (member, topic): the read upsert is idempotent on this
		// index, which is what keeps repeated visits from piling up rows.
		collection.AddIndex("idx_topic_read_states_pair", true, "user_id, topic_id", "")
		// Serves the count's LEFT JOIN on (user, topic).
		collection.AddIndex("idx_topic_read_states_user_topic", false, "user_id, topic_id", "")
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId(topicReadStatesCollectionTable)
		if err != nil {
			return err
		}
		return app.Delete(collection)
	})
}
