package pocketbase

// Tests for the users writer (user_import.go): the second writer of the
// migration. They reuse migratedApp from role_import_test.go so every case
// runs against the real target schema, and they assert the three properties
// the cutover depends on — create with historical dates, idempotent re-runs,
// never delete — plus the password and validation policies.

import (
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// sampleUserUpserts returns two valid accounts addressed to the compiled role
// registry (root and player both exist after migration). The owner carries a
// profile, settings and a historical registration date; the player carries
// only the required columns, so the empty-settings and generated-password
// paths are covered too.
func sampleUserUpserts() []UserUpsert {
	return []UserUpsert{
		{
			LegacyUID: "fb-owner",
			TargetID:  "owner0000000000",
			Email:     "owner@example.com",
			Verified:  true,
			Nickname:  "Owner",
			Role:      "root",
			Status:    "active",
			AvatarURL: "https://example.com/owner.png",
			Profile:   UserProfile{Bio: "I run this place", Location: "Nowhere"},
			Settings:  map[string]any{"theme": "dark"},
			CreatedAt: time.Date(2019, 4, 1, 12, 0, 0, 0, time.UTC),
		},
		{
			LegacyUID: "fb-player",
			TargetID:  "player000000000",
			Email:     "player@example.com",
			Nickname:  "Player One",
			Role:      "player",
			Status:    "pending",
			CreatedAt: time.Date(2021, 6, 15, 8, 30, 0, 0, time.UTC),
		},
	}
}

// importedUsers keys every imported row by its legacy uid — the upsert key
// and the stable identity in both databases.
func importedUsers(t *testing.T, app core.App) map[string]*core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		t.Fatal(err)
	}
	out := make(map[string]*core.Record)
	for _, rec := range rows {
		if uid := rec.GetString("legacy_firebase_uid"); uid != "" {
			out[uid] = rec
		}
	}
	return out
}

func TestImportUsers_CreatesRowsPreservingRegistrationDate(t *testing.T) {
	app := migratedApp(t)

	report, err := ImportUsers(app, sampleUserUpserts())
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Created) != 2 || report.Created[0] != "fb-owner" || report.Created[1] != "fb-player" {
		t.Fatalf("created = %v, want both accounts sorted", report.Created)
	}
	if len(report.Updated) != 0 || len(report.Unchanged) != 0 {
		t.Errorf("a first import must only create: updated=%v unchanged=%v",
			report.Updated, report.Unchanged)
	}
	if len(report.ExtraLegacyUIDs) != 0 {
		t.Errorf("extras = %v, want none", report.ExtraLegacyUIDs)
	}

	rows := importedUsers(t, app)
	if len(rows) != 2 {
		t.Fatalf("rows in db = %d, want 2", len(rows))
	}
	owner := rows["fb-owner"]
	if owner == nil {
		t.Fatal("owner not written")
	}
	// The record id comes from the mapping table, so every relation written
	// later resolves to this row.
	if owner.Id != "owner0000000000" {
		t.Errorf("record id = %q, want the derived target id", owner.Id)
	}
	if owner.Email() != "owner@example.com" || !owner.GetBool("verified") {
		t.Errorf("credentials = %s/%t", owner.Email(), owner.GetBool("verified"))
	}
	if owner.GetString("nickname") != "Owner" || owner.GetString("nickname_normalized") != "owner" {
		t.Errorf("nickname = %q/%q, want Owner/owner",
			owner.GetString("nickname"), owner.GetString("nickname_normalized"))
	}
	if owner.GetString("role") != "root" || owner.GetString("status") != "active" {
		t.Errorf("identity = %s/%s, want root/active",
			owner.GetString("role"), owner.GetString("status"))
	}
	if owner.GetString("bio") != "I run this place" || owner.GetString("avatar_url") != "https://example.com/owner.png" {
		t.Errorf("profile columns not written: bio=%q avatar=%q",
			owner.GetString("bio"), owner.GetString("avatar_url"))
	}
	if got := canonicalJSON(owner.Get("settings")); got != `{"theme":"dark"}` {
		t.Errorf("settings = %s, want the legacy object verbatim", got)
	}

	// The historical registration date survives the autodate field, which
	// silently ignores Set — that is why the writer uses SetRaw.
	want := time.Date(2019, 4, 1, 12, 0, 0, 0, time.UTC)
	if got := owner.GetDateTime("created").Time().UTC(); !got.Equal(want) {
		t.Errorf("created = %s, want the historical date %s", got, want)
	}

	player := rows["fb-player"]
	if player.GetString("status") != "pending" {
		t.Errorf("player status = %q, want pending", player.GetString("status"))
	}
	// An absent settings object must be stored as {}, never null.
	if got := canonicalJSON(player.Get("settings")); got != "{}" {
		t.Errorf("empty settings = %s, want {}", got)
	}
	if player.GetDateTime("created").IsZero() {
		t.Error("player registration date not written")
	}

	// No password was supplied, so both rows got a random unusable one that
	// is handed back exactly once — with mail disabled it is the only way in.
	if len(report.GeneratedPasswords) != 2 {
		t.Fatalf("generated passwords = %v, want one per created row", report.GeneratedPasswords)
	}
	for uid, generated := range report.GeneratedPasswords {
		if !rows[uid].ValidatePassword(generated) {
			t.Errorf("generated password for %s does not validate", uid)
		}
	}
}

func TestImportUsers_IsIdempotent(t *testing.T) {
	app := migratedApp(t)
	upserts := sampleUserUpserts()
	if _, err := ImportUsers(app, upserts); err != nil {
		t.Fatal(err)
	}
	ids := make(map[string]string)
	for uid, rec := range importedUsers(t, app) {
		ids[uid] = rec.Id
	}

	second, err := ImportUsers(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("second run changed the database: created=%v updated=%v",
			second.Created, second.Updated)
	}
	if len(second.Unchanged) != 2 {
		t.Errorf("unchanged = %v, want both accounts", second.Unchanged)
	}
	if len(second.GeneratedPasswords) != 0 {
		t.Errorf("existing rows must not receive a regenerated password: %v",
			second.GeneratedPasswords)
	}
	// The upsert key is the hidden legacy uid, not the record id: a re-run
	// must never replace the row, because every relation points at it.
	for uid, id := range ids {
		if got := importedUsers(t, app)[uid].Id; got != id {
			t.Errorf("%s was replaced (%s -> %s)", uid, id, got)
		}
	}
}

func TestImportUsers_RepairsDriftWithoutTouchingCreated(t *testing.T) {
	app := migratedApp(t)
	upserts := sampleUserUpserts()
	if _, err := ImportUsers(app, upserts); err != nil {
		t.Fatal(err)
	}

	victim := importedUsers(t, app)["fb-owner"]
	originalID := victim.Id
	originalCreated := victim.GetDateTime("created")
	victim.Set("nickname", "Tampered")
	victim.Set("bio", "stripped by hand")
	victim.Set("verified", false)
	victim.Set("nickname_normalized", "tampered")
	if err := app.Save(victim); err != nil {
		t.Fatal(err)
	}

	report, err := ImportUsers(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Updated) != 1 || report.Updated[0] != "fb-owner" {
		t.Fatalf("updated = %v, want exactly [fb-owner]", report.Updated)
	}
	if len(report.Unchanged) != 1 || report.Unchanged[0] != "fb-player" {
		t.Errorf("unchanged = %v, want the untouched [fb-player]", report.Unchanged)
	}

	repaired := importedUsers(t, app)["fb-owner"]
	if repaired.Id != originalID {
		t.Errorf("repair replaced the row (%s -> %s); drift must be fixed in place",
			originalID, repaired.Id)
	}
	if repaired.GetString("nickname") != "Owner" || repaired.GetString("nickname_normalized") != "owner" {
		t.Errorf("nickname not repaired: %q/%q",
			repaired.GetString("nickname"), repaired.GetString("nickname_normalized"))
	}
	if repaired.GetString("bio") != "I run this place" || !repaired.GetBool("verified") {
		t.Errorf("drift survived: bio=%q verified=%t",
			repaired.GetString("bio"), repaired.GetBool("verified"))
	}
	// The registration date is create-only: repairing a row must not age it.
	if got := repaired.GetDateTime("created"); !got.Equal(originalCreated) {
		t.Errorf("created changed during repair: %s -> %s", originalCreated, got)
	}
}

func TestImportUsers_ReportsExtrasWithoutDeleting(t *testing.T) {
	app := migratedApp(t)
	all := sampleUserUpserts()
	if _, err := ImportUsers(app, all); err != nil {
		t.Fatal(err)
	}

	// A partial run (say, -uid fb-owner) must not destroy the accounts it
	// does not mention: they are reported for review instead.
	report, err := ImportUsers(app, []UserUpsert{all[0]})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.ExtraLegacyUIDs) != 1 || report.ExtraLegacyUIDs[0] != "fb-player" {
		t.Fatalf("extras = %v, want [fb-player]", report.ExtraLegacyUIDs)
	}
	if _, ok := importedUsers(t, app)["fb-player"]; !ok {
		t.Error("the extra account was deleted; the importer must never remove rows")
	}
}

func TestImportUsers_PasswordPolicy(t *testing.T) {
	app := migratedApp(t)

	bootstrap := sampleUserUpserts()
	bootstrap[0].Password = "correct horse battery staple"
	report, err := ImportUsers(app, bootstrap)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := report.GeneratedPasswords["fb-owner"]; ok {
		t.Error("a caller-supplied password must not also generate one")
	}
	if len(report.GeneratedPasswords) != 1 {
		t.Errorf("generated = %v, want only the player", report.GeneratedPasswords)
	}
	rows := importedUsers(t, app)
	if !rows["fb-owner"].ValidatePassword("correct horse battery staple") {
		t.Error("the supplied bootstrap password was not set")
	}

	// A re-run with a fresh plan (no password) must not invalidate a
	// password the owner may already have changed.
	rerun := sampleUserUpserts()
	rerun[0].Password = "different password offered by a later run"
	second, err := ImportUsers(app, rerun)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("re-run reported a change: created=%v updated=%v", second.Created, second.Updated)
	}
	after := importedUsers(t, app)
	if !after["fb-owner"].ValidatePassword("correct horse battery staple") {
		t.Error("a re-run overwrote an existing password")
	}
	if after["fb-owner"].ValidatePassword("different password offered by a later run") {
		t.Error("a re-run silently applied a new password to an existing account")
	}
	if !after["fb-player"].ValidatePassword(report.GeneratedPasswords["fb-player"]) {
		t.Error("the player's generated password stopped working after the re-run")
	}
}

// TestImportUsers_RejectsInvalidBatchWithoutWriting proves the two guard
// rails: the batch is validated before the transaction opens (so a bad row
// cannot leave a half-imported account list), and the role registry is
// consulted inside the transaction (so an unknown role rolls the whole batch
// back instead of writing unauthorised accounts).
func TestImportUsers_RejectsInvalidBatchWithoutWriting(t *testing.T) {
	app := migratedApp(t)

	cases := []struct {
		name    string
		mutate  func(batch []UserUpsert)
		wantErr string
	}{
		{"missing email", func(b []UserUpsert) { b[0].Email = "" }, "email is required"},
		{"missing nickname", func(b []UserUpsert) { b[0].Nickname = "" }, "nickname is required"},
		{"missing role", func(b []UserUpsert) { b[0].Role = "" }, "role is required"},
		{"unknown status", func(b []UserUpsert) { b[0].Status = "frozen" }, "unknown status"},
		{"malformed target id", func(b []UserUpsert) { b[0].TargetID = "short" }, "not a 15 character"},
		{"duplicate uid", func(b []UserUpsert) { b[1].LegacyUID = b[0].LegacyUID }, "duplicate user upsert"},
		{"case-insensitive duplicate email",
			func(b []UserUpsert) { b[1].Email = "OWNER@example.com" }, "share the email"},
		{"duplicate normalised nickname",
			func(b []UserUpsert) { b[1].Nickname = "OWNER" }, "share the nickname key"},
		{"duplicate target id",
			func(b []UserUpsert) { b[1].TargetID = b[0].TargetID }, "share the target id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			batch := sampleUserUpserts()
			tc.mutate(batch)
			_, err := ImportUsers(app, batch)
			if err == nil {
				t.Fatal("the batch must be rejected")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error = %q, want it to mention %q", err, tc.wantErr)
			}
			// Validation happens before the transaction: the valid part of
			// the batch must not have been written either.
			if rows := importedUsers(t, app); len(rows) != 0 {
				t.Errorf("a rejected batch wrote %d rows", len(rows))
			}
		})
	}

	t.Run("role missing from the registry", func(t *testing.T) {
		clearRoleRows(t, app)
		_, err := ImportUsers(app, sampleUserUpserts())
		if err == nil {
			t.Fatal("import must refuse to write a role the registry does not hold")
		}
		if !strings.Contains(err.Error(), "import the registry first") {
			t.Errorf("error = %q, want it to point at the registry", err)
		}
		if rows := importedUsers(t, app); len(rows) != 0 {
			t.Errorf("the rolled-back transaction left %d rows", len(rows))
		}
	})
}
