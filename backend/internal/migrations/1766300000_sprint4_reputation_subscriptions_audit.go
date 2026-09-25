package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766300000_sprint4_reputation_subscriptions_audit.go creates the Sprint 4 schema:
//
//   - `reputation_votes` — immutable votes cast on posts or user profiles.
//     Enforces UNIQUE(voter_id, post_id) for post votes and
//     UNIQUE(voter_id, target_id) for profile votes.
//   - `topic_subscriptions` — persistent topic follow ledger.
//     Enforces UNIQUE(topic_id, user_id).
//   - `audit_logs` — append-only ledger for staff actions. Browser writes and
//     deletions are locked.
//   - Updates `users` and `posts` collections with a `reputation` counter field.
const (
	reputationVotesCollectionTable    = "reputation_votes"
	topicSubscriptionsCollectionTable = "topic_subscriptions"
	auditLogsCollectionTable          = "audit_logs"
)

func init() {
	m.Register(func(app core.App) error {
		if err := addReputationCounterFields(app); err != nil {
			return fmt.Errorf("reputation counter fields: %w", err)
		}
		if err := addCategoryPermissionsField(app); err != nil {
			return fmt.Errorf("category permissions field: %w", err)
		}
		if err := createReputationVotes(app); err != nil {
			return fmt.Errorf("reputation_votes: %w", err)
		}
		if err := createTopicSubscriptions(app); err != nil {
			return fmt.Errorf("topic_subscriptions: %w", err)
		}
		if err := createAuditLogs(app); err != nil {
			return fmt.Errorf("audit_logs: %w", err)
		}
		return nil
	}, func(app core.App) error {
		for _, name := range []string{auditLogsCollectionTable, topicSubscriptionsCollectionTable, reputationVotesCollectionTable} {
			col, err := app.FindCollectionByNameOrId(name)
			if err == nil && col != nil {
				if err := app.Delete(col); err != nil {
					return err
				}
			}
		}
		if err := removeCategoryPermissionsField(app); err != nil {
			return err
		}
		return removeReputationCounterFields(app)
	})
}

func addCategoryPermissionsField(app core.App) error {
	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		return err
	}
	if categories.Fields.GetByName("permissions") == nil {
		categories.Fields.Add(&core.JSONField{Name: "permissions", MaxSize: 65536})
		if err := app.Save(categories); err != nil {
			return err
		}
	}
	return nil
}

func removeCategoryPermissionsField(app core.App) error {
	categories, err := app.FindCollectionByNameOrId("categories")
	if err == nil && categories != nil {
		categories.Fields.RemoveByName("permissions")
		_ = app.Save(categories)
	}
	return nil
}

func addReputationCounterFields(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}
	if users.Fields.GetByName("reputation") == nil {
		users.Fields.Add(&core.NumberField{Name: "reputation", OnlyInt: true})
		if err := app.Save(users); err != nil {
			return err
		}
	}

	posts, err := app.FindCollectionByNameOrId("posts")
	if err != nil {
		return err
	}
	if posts.Fields.GetByName("reputation") == nil {
		posts.Fields.Add(&core.NumberField{Name: "reputation", OnlyInt: true})
		if err := app.Save(posts); err != nil {
			return err
		}
	}

	return nil
}

func removeReputationCounterFields(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err == nil && users != nil {
		users.Fields.RemoveByName("reputation")
		_ = app.Save(users)
	}
	posts, err := app.FindCollectionByNameOrId("posts")
	if err == nil && posts != nil {
		posts.Fields.RemoveByName("reputation")
		_ = app.Save(posts)
	}
	return nil
}

func createReputationVotes(app core.App) error {
	col := core.NewBaseCollection(reputationVotesCollectionTable)

	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "voter_id", Required: true, Max: 15},
		&core.TextField{Name: "target_id", Required: true, Max: 15},
		&core.TextField{Name: "post_id", Max: 15},
		&core.TextField{Name: "topic_id", Max: 15},
		&core.NumberField{Name: "value", Required: true, OnlyInt: true},
		&core.TextField{Name: "comment", Max: 1024},
	)
	lockBrowserRules(col)

	// Partial unique index for post votes: UNIQUE(voter_id, post_id) where post_id != ''
	col.AddIndex("idx_rep_voter_post", true, "voter_id, post_id", "post_id != ''")
	// Partial unique index for profile votes: UNIQUE(voter_id, target_id) where post_id == ''
	col.AddIndex("idx_rep_voter_profile", true, "voter_id, target_id", "post_id = ''")
	// Keyset index for listing target user's reputation history
	col.AddIndex("idx_rep_target_created", false, "target_id, created, id", "")
	// Keyset index for post voters lookup
	col.AddIndex("idx_rep_post_created", false, "post_id, created, id", "")

	return app.Save(col)
}

func createTopicSubscriptions(app core.App) error {
	col := core.NewBaseCollection(topicSubscriptionsCollectionTable)

	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.TextField{Name: "topic_id", Required: true, Max: 15},
		&core.TextField{Name: "user_id", Required: true, Max: 15},
	)
	lockBrowserRules(col)

	// Unique constraint: one subscription per (topic_id, user_id) pair
	col.AddIndex("idx_sub_topic_user", true, "topic_id, user_id", "")
	col.AddIndex("idx_sub_user_created", false, "user_id, created, id", "")

	return app.Save(col)
}

func createAuditLogs(app core.App) error {
	col := core.NewBaseCollection(auditLogsCollectionTable)

	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.TextField{Name: "action_type", Required: true, Max: 64},
		&core.TextField{Name: "performer_id", Required: true, Max: 15},
		&core.JSONField{Name: "details", MaxSize: 65536},
	)
	lockBrowserRules(col)

	// Keyset pagination for audit logs list: created DESC, id DESC
	col.AddIndex("idx_audit_created_id", false, "created, id", "")
	col.AddIndex("idx_audit_performer", false, "performer_id, created, id", "")

	return app.Save(col)
}
