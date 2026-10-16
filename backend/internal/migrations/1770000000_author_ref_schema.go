// 1770000000_author_ref_schema.go introduces the explicit AuthorRef storage
// variant for forum content. It deliberately keeps author_id and guest_nickname
// during the compatibility rollout; command handlers switch to the new fields
// in a following change, and the old fields are removed only after telemetry
// proves there are no legacy readers.
package migrations

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const (
	authorKindField       = "author_kind"
	guestDisplayNameField = "guest_display_name"
	authorKindAccount     = "account"
	authorKindGuest       = "guest"
)

func init() {
	m.Register(addAuthorRefSchema, removeAuthorRefSchema)
}

func addAuthorRefSchema(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}

		if collection.Fields.GetByName(authorKindField) == nil {
			collection.Fields.Add(&core.SelectField{
				Name:      authorKindField,
				MaxSelect: 1,
				Values:    []string{authorKindAccount, authorKindGuest},
			})
		}
		if collection.Fields.GetByName(guestDisplayNameField) == nil {
			collection.Fields.Add(&core.TextField{Name: guestDisplayNameField, Max: 64})
		}

		collection.AddIndex("idx_"+collectionName+"_author_kind", false, authorKindField, "")
		if err := app.Save(collection); err != nil {
			return fmt.Errorf("save %s author ref schema: %w", collectionName, err)
		}
	}

	return backfillAuthorRefs(app)
}

// backfillAuthorRefs establishes the only safe mapping for rows produced before
// AuthorRef existed. Rows that have neither an account id nor a guest display
// name remain deliberately unclassified: labelling damaged legacy data as a
// guest would invent an identity and make later moderation/audit misleading.
func backfillAuthorRefs(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		records, err := app.FindAllRecords(collectionName)
		if err != nil {
			return fmt.Errorf("list %s for author ref backfill: %w", collectionName, err)
		}

		unknown := 0
		for _, record := range records {
			if record.GetString(authorKindField) != "" {
				continue
			}

			authorID := strings.TrimSpace(record.GetString("author_id"))
			guestName := strings.TrimSpace(record.GetString("guest_nickname"))
			switch {
			case authorID != "":
				record.Set(authorKindField, authorKindAccount)
				record.Set(guestDisplayNameField, "")
			case guestName != "":
				record.Set(authorKindField, authorKindGuest)
				record.Set(guestDisplayNameField, guestName)
			default:
				unknown++
				continue
			}

			if err := app.Save(record); err != nil {
				return fmt.Errorf("backfill %s author ref %s: %w", collectionName, record.Id, err)
			}
		}
		if unknown > 0 {
			app.Logger().Warn("author ref backfill left legacy rows unclassified", "collection", collectionName, "count", unknown)
		}
	}
	return nil
}

func removeAuthorRefSchema(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		collection.RemoveIndex("idx_" + collectionName + "_author_kind")
		collection.Fields.RemoveByName(authorKindField)
		collection.Fields.RemoveByName(guestDisplayNameField)
		if err := app.Save(collection); err != nil {
			return fmt.Errorf("remove %s author ref schema: %w", collectionName, err)
		}
	}
	return nil
}
