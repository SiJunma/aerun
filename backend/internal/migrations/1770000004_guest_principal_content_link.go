// 1770000004_guest_principal_content_link.go links guest-authored content to a
// guest principal.
//
// WHY A SEPARATE MIGRATION. Migration 1770000003 created the guest_principals
// collection but did not touch posts/topics. This migration adds the
// guest_principal_id column to both so a guest post/topic can carry the stable
// principal that voted on it, edited it (future capability), or is otherwise
// attributable to one browser identity.
//
// Idempotent by construction; the down path removes only the new column.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(addGuestPrincipalContentLink, removeGuestPrincipalContentLink)
}

func addGuestPrincipalContentLink(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		if collection.Fields.GetByName("guest_principal_id") == nil {
			collection.Fields.Add(&core.TextField{
				Name: "guest_principal_id",
				Max:  64,
			})
		}
		collection.AddIndex("idx_"+collectionName+"_guest_principal_id", false, "guest_principal_id", "")
		if err := app.Save(collection); err != nil {
			return fmt.Errorf("save %s guest_principal_id: %w", collectionName, err)
		}
	}
	return nil
}

func removeGuestPrincipalContentLink(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		collection.RemoveIndex("idx_" + collectionName + "_guest_principal_id")
		collection.Fields.RemoveByName("guest_principal_id")
		if err := app.Save(collection); err != nil {
			return fmt.Errorf("remove %s guest_principal_id: %w", collectionName, err)
		}
	}
	return nil
}
