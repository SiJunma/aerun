package pocketbase

import "testing"

// TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir pins the boot guard.
//
// The failure it exists to catch is silent by construction: PocketBase's
// Record.Set on a missing field is a no-op, so a database restored from a
// snapshot taken before migration 1769800000/1770000000 keeps serving 200s
// while every guest write quietly drops its author identity and the index
// renders "Deleted user". A guard that returns nil here would restore exactly
// the silence the audit removed together with repairGuestNicknameSchema.
func TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// The test app has migrations applied, so the healthy path must pass.
	if err := verifyAuthorRefSchema(app); err != nil {
		t.Fatalf("a migrated data dir must pass the guard: %v", err)
	}

	// Drop the AuthorRef fields the way a restore from a pre-migration backup
	// would. The cached collection is what OnServe reads, so this mirrors a
	// binary that postdates the snapshot.
	for _, collectionName := range []string{postsCollectionName, topicsCollectionName} {
		collection, err := app.FindCachedCollectionByNameOrId(collectionName)
		if err != nil {
			t.Fatal(err)
		}
		collection.Fields.RemoveByName(authorKindField)
		collection.Fields.RemoveByName(guestDisplayNameField)
		if err := app.Save(collection); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.ReloadCachedCollections(); err != nil {
		t.Fatal(err)
	}

	if err := verifyAuthorRefSchema(app); err == nil {
		t.Fatal("the guard must reject a data dir without the AuthorRef columns; " +
			"otherwise guest writes degrade silently again")
	}
}
