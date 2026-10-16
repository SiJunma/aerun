package pocketbase

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
)

// Stored author variants. These strings are kept in sync with migration
// 1770000000_author_ref_schema; only this package owns their runtime writes.
const (
	authorKindField       = "author_kind"
	guestDisplayNameField = "guest_display_name"
	authorKindAccount     = "account"
	authorKindGuest       = "guest"
)

func setAccountAuthorRef(record *core.Record, userID string) {
	record.Set("author_id", userID)
	record.Set(authorKindField, authorKindAccount)
	record.Set(guestDisplayNameField, "")
}

func setGuestAuthorRef(record *core.Record, displayName string) {
	record.Set("author_id", "")
	record.Set(authorKindField, authorKindGuest)
	record.Set(guestDisplayNameField, displayName)
}

// verifyAuthorRefSchema asserts at boot that every mandatory AuthorRef column
// actually exists.
//
// It exists because the same silent failure this audit removes keeps coming
// back through restores: PocketBase's Record.Set on a missing field is a
// SILENT no-op, so a database restored from a snapshot taken before migration
// 1769800000/1770000000 — while the migration tracker still records them as
// applied — would never re-run the migration on restart. Every guest write
// would then drop its nickname/display name without an error, and the forum
// index would render "Deleted user" for every guest.
//
// apis.Serve applies every migration before OnServe runs, so reaching this
// hook with a column missing is not a race and not a first-boot condition —
// it means the binary and the data directory disagree, and continuing would
// serve a forum whose guest authorship is quietly wrong. Refusing to start is
// the honest outcome: the fix is to run the migrations, which any restart of
// a current binary does automatically. A one-off snapshot repair lives in an
// explicit operator migration with a report, never in silent runtime code.
func verifyAuthorRefSchema(app core.App) error {
	required := map[string][]string{
		postsCollectionName:  {"author_id", "guest_nickname", authorKindField, guestDisplayNameField},
		topicsCollectionName: {"author_id", "guest_nickname", "last_post_guest_nickname", authorKindField, guestDisplayNameField},
	}
	for _, collectionName := range []string{postsCollectionName, topicsCollectionName} {
		collection, err := app.FindCachedCollectionByNameOrId(collectionName)
		if err != nil {
			return fmt.Errorf("%s collection unavailable: %w", collectionName, err)
		}
		for _, field := range required[collectionName] {
			if collection.Fields.GetByName(field) == nil {
				return fmt.Errorf(
					"%s.%s is missing: this binary and the data directory are out of sync "+
						"(migrations run automatically on start -- if you are seeing this, the "+
						"process is running a build from before migration 1770000000, and every "+
						"guest write would silently drop its author identity)",
					collectionName, field)
			}
		}
	}
	return nil
}
