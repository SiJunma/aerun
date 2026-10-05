package migrations

// 1768000000_post_author_character_and_pin.go gives a post the two facts it
// could not previously store, both of which the legacy Firestore documents
// carried and this schema silently dropped:
//
//  1. `author_character_id` — the MASK a message was written under.
//
//     `characters` and `users.last_selected_character_id` both already existed
//     (1766600000, 1766900000), and the topic/reply forms both offered a mask
//     picker, but NO post column referenced it: `PRAGMA table_info(posts)` had
//     no such field, and `createTopicForm`/`createPostForm` did not accept one.
//     The picker therefore only ever wrote `users.last_selected_character_id`,
//     which nothing read back, so every message was stamped with the account
//     identity. The UI looked like it worked and silently did not.
//
//     `topics` carries the same two references (`author_character_id`,
//     `last_post_author_character_id`) so a topic row and its newest post agree
//     about who is speaking without a second lookup.
//
//  2. `topics.first_post_pinned` — "Pin first post on all pages".
//
//     The topic form has rendered this checkbox since the Firestore era and
//     held its state in `pinFirstPost`, but never sent it, because no column
//     existed to receive it.
//
//     It lives on the TOPIC, not on the post, and that placement is not a
//     detail. The legacy Firestore topic document carried `first_post_pinned`
//     (PROJECT_SPEC.md:107 — "закрепить первое сообщение на всех страницах
//     темы"; 23 topics have it set in the rehearsal export), and the retired
//     callable read it as `topicData.first_post_pinned && page > 1` and then
//     fetched the topic's EARLIEST post by `created_at`. So the flag is a
//     property of the topic, and "the pinned post" is a rule ("the first one"),
//     not a per-post fact.
//
//     Storing it per-post instead would have been a plausible-looking redesign
//     that broke the contract: TopicPage gates its banner on
//     `topic.first_post_pinned`, the topic editor round-trips the same field
//     (TopicPage.jsx:1848), and an imported legacy topic would have lost its
//     pin entirely.
//
// BOTH are OPTIONAL with an empty default, and that is the load-bearing
// decision: an existing topic has no mask and is not pinned, and a NOT NULL
// default would rewrite the whole table to say what was already true.
//
// The mask reference is TEXT, not a relation, for the same reason
// `categories.group_id` and `roles.base_role_id` are (1767500000, 1766500000):
// a topic must stay importable and readable when its character row is missing
// from a partial export. The command layer validates ownership on write.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return addAuthorCharacterAndPinFields(app)
	}, func(app core.App) error {
		return removeAuthorCharacterAndPinFields(app)
	})
}

func addAuthorCharacterAndPinFields(app core.App) error {
	posts, err := mutateCollectionForSchema(app, "posts")
	if err != nil {
		return fmt.Errorf("posts: %w", err)
	}
	// The delete guard in characters.go already asks the schema for this field
	// (postsHaveAuthorCharacter) precisely so a character delete can refuse
	// while posts still name it. Adding the field makes that guard live rather
	// than dormant, so it is exercised by the existing test suite.
	ensureField(posts, &core.TextField{Name: "author_character_id", Max: 15})
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("posts.author_character_id: %w", err)
	}

	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	ensureField(topics, &core.TextField{Name: "author_character_id", Max: 15})
	ensureField(topics, &core.TextField{Name: "last_post_author_character_id", Max: 15})
	ensureField(topics, &core.BoolField{Name: "first_post_pinned"})
	return app.Save(topics)
}

func removeAuthorCharacterAndPinFields(app core.App) error {
	posts, err := mutateCollectionForSchema(app, "posts")
	if err != nil {
		return fmt.Errorf("posts: %w", err)
	}
	posts.Fields.RemoveByName("author_character_id")
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("posts.author_character_id: %w", err)
	}

	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	topics.Fields.RemoveByName("author_character_id")
	topics.Fields.RemoveByName("last_post_author_character_id")
	topics.Fields.RemoveByName("first_post_pinned")
	return app.Save(topics)
}
