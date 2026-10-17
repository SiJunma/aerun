// 1770000007_topic_read_cursor.go adds cursor fields to topic_read_states so the
// unread model can compare by (created, id) instead of relying on a timestamp
// alone. A timestamp write says "I read at this instant", but it does not prove
// the reader saw a specific post; a post created between page load and the write
// can be marked read without ever being shown. The cursor pins the read position
// to an actual post row.
//
// Fields added:
//   - last_read_post_id — id of the post the reader last saw
//   - last_read_created — created of that post
//   - last_read_post_tiebreak_id — tie-breaker id for the (created, id) comparator
//
// last_read_at is kept for backfill: existing timestamp strings become a
// temporary lower bound until the client sends a post id.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const (
	lastReadPostIDField        = "last_read_post_id"
	lastReadCreatedField       = "last_read_created"
	lastReadPostTiebreakIDField = "last_read_post_tiebreak_id"
)

func init() {
	m.Register(addTopicReadCursorFields, removeTopicReadCursorFields)
}

func addTopicReadCursorFields(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(topicReadStatesCollectionTable)
	if err != nil || collection == nil {
		return fmt.Errorf("find %s collection: %w", topicReadStatesCollectionTable, err)
	}

	for _, field := range []*core.TextField{
		{Name: lastReadPostIDField, Max: 15},
		{Name: lastReadPostTiebreakIDField, Max: 15},
	} {
		if collection.Fields.GetByName(field.Name) == nil {
			collection.Fields.Add(field)
		}
	}
	if collection.Fields.GetByName(lastReadCreatedField) == nil {
		collection.Fields.Add(&core.DateField{Name: lastReadCreatedField})
	}

	if err := app.Save(collection); err != nil {
		return fmt.Errorf("save topic_read_states cursor fields: %w", err)
	}
	return nil
}

func removeTopicReadCursorFields(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(topicReadStatesCollectionTable)
	if err != nil || collection == nil {
		return fmt.Errorf("find %s collection: %w", topicReadStatesCollectionTable, err)
	}

	for _, name := range []string{lastReadPostIDField, lastReadCreatedField, lastReadPostTiebreakIDField} {
		if collection.Fields.GetByName(name) != nil {
			collection.Fields.RemoveByName(name)
		}
	}

	return app.Save(collection)
}