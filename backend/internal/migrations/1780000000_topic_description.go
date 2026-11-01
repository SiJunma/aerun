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

func addTopicDescriptionField(app core.App) error {
	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	ensureField(topics, &core.TextField{Name: "description", Max: 200})
	return app.Save(topics)
}

func removeTopicDescriptionField(app core.App) error {
	topics, err := mutateCollectionForSchema(app, "topics")
	if err != nil {
		return fmt.Errorf("topics: %w", err)
	}
	topics.Fields.RemoveByName("description")
	return app.Save(topics)
}
