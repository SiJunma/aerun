package migrations

// 1780000000_topic_description.go gives a topic the one content field the
// legacy Firestore topic document carried and this schema silently dropped:
// `description` — the short subtitle ("Краткое описание") the topic form has
// rendered since the Firestore era.
//
// Before this migration the description had nowhere to go, at EVERY layer:
// `createTopicForm`/`updateTopicForm` did not accept it, `topicPayload` did
// not emit it, and the client's `updateTopic` whitelist did not forward it.
// The two forms held the value in state and sent it into the void: the
// category list and topic header rendered it only from optimistic state,
// and every reload rewound it to empty. The first-post editor's description
// input was literally decorative.
//
// Max 200 mirrors the client's own limit (TopicFormPage LIMITS.description
// and the editor's maxLength={200}) — the same bound lives in
// forum.MaxTopicDescriptionLen and is enforced by
// forum.ValidateTopicDescription on both write paths.
//
// The field is OPTIONAL with an empty default: an existing topic never had
// one, and a NOT NULL default would rewrite the whole table to say what was
// already true.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return addTopicDescriptionField(app)
	}, func(app core.App) error {
		return removeTopicDescriptionField(app)
	})
}

// addTopicDescriptionField adds the `description` field to the topics collection.
// It avoids app.Save(topics) because that triggers SyncRecordTableSchema →
// dropCollectionIndexes → dbutils.ParseIndex, which can hang due to regex
// catastrophic backtracking in PocketBase v0.40.4 (see CI log).
// Instead the column is added directly via ALTER TABLE and the collection record
// is persisted to _collections without invoking the schema-sync hooks.
func addTopicDescriptionField(app core.App) error {
	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	if topics.Fields.GetByName("description") != nil {
		return nil // already exists
	}

	// Add the column directly to the SQLite table.
	if _, err := app.DB().NewQuery(
		"ALTER TABLE topics ADD COLUMN description VARCHAR(200)",
	).Execute(); err != nil {
		return fmt.Errorf("alter table: %w", err)
	}

	// Update the in-memory collection so subsequent operations in this app
	// instance are aware of the new field.
	ensureField(topics, &core.TextField{Name: "description", Max: 200})

	// Persist the schema change to _collections directly, bypassing
	// app.Save() which triggers SyncRecordTableSchema → dropCollectionIndexes →
	// dbutils.ParseIndex (catastrophic regex backtracking in PocketBase v0.40.4).
	raw, err := topics.Fields.MarshalJSON()
	if err != nil {
		return fmt.Errorf("marshal fields: %w", err)
	}
	if _, err := app.DB().NewQuery(
		"UPDATE _collections SET fields = {:fields} WHERE id = {:id}",
	).Bind(dbx.Params{"fields": string(raw), "id": topics.Id}).Execute(); err != nil {
		return fmt.Errorf("update collection fields: %w", err)
	}

	// Reload the collections cache so the new field is visible to subsequent
	// operations in this app instance (topic creation, etc.).
	if err := app.ReloadCachedCollections(); err != nil {
		return fmt.Errorf("reload collections cache: %w", err)
	}

	return nil
}

func removeTopicDescriptionField(app core.App) error {
	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	if topics.Fields.GetByName("description") == nil {
		return nil // already removed
	}

	// Remove the column directly from the SQLite table.
	if _, err := app.DB().NewQuery(
		"ALTER TABLE topics DROP COLUMN description",
	).Execute(); err != nil {
		return fmt.Errorf("drop column: %w", err)
	}

	// Update the in-memory collection.
	topics.Fields.RemoveByName("description")

	// Persist the schema change to _collections directly.
	raw, err := topics.Fields.MarshalJSON()
	if err != nil {
		return fmt.Errorf("marshal fields: %w", err)
	}
	if _, err := app.DB().NewQuery(
		"UPDATE _collections SET fields = {:fields} WHERE id = {:id}",
	).Bind(dbx.Params{"fields": string(raw), "id": topics.Id}).Execute(); err != nil {
		return fmt.Errorf("update collection fields: %w", err)
	}

	// Reload the collections cache so the field removal is visible.
	if err := app.ReloadCachedCollections(); err != nil {
		return fmt.Errorf("reload collections cache: %w", err)
	}

	return nil
}
