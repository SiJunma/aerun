// 1770000006_fix_author_id_required.go ensures posts.author_id and topics.author_id
// are NOT Required so guests can publish without an account.
// Migration 1769900000 was supposed to do this, but on some local data dirs it
// either ran before the field existed or the field was re-created as Required=true.
// This migration unconditionally sets Required = false.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(ensureAuthorIdOptional, revertAuthorIdRequired)
}

func ensureAuthorIdOptional(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		field := collection.Fields.GetByName("author_id")
		if field != nil {
			if textField, ok := field.(*core.TextField); ok {
				textField.Required = false
				if err := app.Save(collection); err != nil {
					return fmt.Errorf("make %s.author_id optional: %w", collectionName, err)
				}
			}
		}
	}
	return nil
}

func revertAuthorIdRequired(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		field := collection.Fields.GetByName("author_id")
		if field != nil {
			if textField, ok := field.(*core.TextField); ok {
				textField.Required = true
				if err := app.Save(collection); err != nil {
					return fmt.Errorf("make %s.author_id required: %w", collectionName, err)
				}
			}
		}
	}
	return nil
}