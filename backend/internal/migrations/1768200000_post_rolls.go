package migrations

// 1768200000_post_rolls.go gives a post the result of its dice throws, the
// last thing the legacy Firestore documents carried and this schema dropped.
//
// `processDiceRolls` (src/utils/dice.js) rewrites every `[dice=N]` the author
// typed into a reference plus a companion entry — `[roll=roll_1791050763756_1]`
// and `{id, sides, value, type, timestamp}` — because a roll that is not yet
// thrown cannot be shown as a number. The TAG therefore carries no result on
// its own; the map IS the result.
//
// The `posts` collection had no column to receive it: createPosts (1766100000)
// defines content, sequence, editor_id and dates, and no later migration added
// one. The read model did not return it either (postPayload never had a
// `rolls` key), and the browser dropped it before the request left —
// `createPost` destructured `{ content }` out of processDiceRolls and sent
// only the text. So the roll was generated, displayed in the optimistic card,
// and then discarded: after a reload every reader, guest included, got the raw
// `[roll=roll_…]` text back from BBCode's "no such roll" branch. The dice
// worked for exactly as long as the author did not refresh.
//
// It is JSON, not a relation, for the same reason `author_character_id` is
// text (1768000000): the map is denormalised presentation state owned by the
// post, has no rows of its own, and must stay readable when a referenced roll
// is absent rather than turning a renderable post into a failed join.
//
// OPTIONAL with an empty default. A post written before this migration has no
// throws, and a NOT NULL default would rewrite every existing row to say what
// was already true.
//
// `dm_messages` gets the same column for the same reason: sendDmMessage ran
// processDiceRolls too and threw the map away, so the same raw text appeared in
// private messages.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// maxRollsJSONBytes bounds the stored map. 64 rolls of `{id, sides, value,
// type}` is roughly 6 KB, so 32 KB leaves generous headroom while keeping a
// single post row from carrying an unbounded blob.
const maxRollsJSONBytes = 32768

func init() {
	m.Register(func(app core.App) error {
		return addPostRollsFields(app)
	}, func(app core.App) error {
		return removePostRollsFields(app)
	})
}

func addPostRollsFields(app core.App) error {
	posts, err := mutateCollectionForSchema(app, "posts")
	if err != nil {
		return fmt.Errorf("posts: %w", err)
	}
	ensureField(posts, &core.JSONField{Name: "rolls", MaxSize: maxRollsJSONBytes})
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("posts.rolls: %w", err)
	}

	messages, err := mutateCollectionForSchema(app, "dm_messages")
	if err != nil {
		return fmt.Errorf("dm_messages: %w", err)
	}
	ensureField(messages, &core.JSONField{Name: "rolls", MaxSize: maxRollsJSONBytes})
	if err := app.Save(messages); err != nil {
		return fmt.Errorf("dm_messages.rolls: %w", err)
	}
	return nil
}

func removePostRollsFields(app core.App) error {
	posts, err := mutateCollectionForSchema(app, "posts")
	if err != nil {
		return fmt.Errorf("posts: %w", err)
	}
	posts.Fields.RemoveByName("rolls")
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("posts.rolls: %w", err)
	}

	messages, err := mutateCollectionForSchema(app, "dm_messages")
	if err != nil {
		return fmt.Errorf("dm_messages: %w", err)
	}
	messages.Fields.RemoveByName("rolls")
	if err := app.Save(messages); err != nil {
		return fmt.Errorf("dm_messages.rolls: %w", err)
	}
	return nil
}
