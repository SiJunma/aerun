package importer

// Tests for the plan half of the users writer (users.go): the translation of
// legacy account documents plus the official Auth export into target rows.

import (
	"strings"
	"testing"
	"time"
)

// newUserTestPlan builds the plan directly (no ledger round-trip), so these
// tests are about the translation rules rather than about decoding.
//
// Accounts:
//   - rootOwner    the forum owner: document nickname and created_at, auth
//     export email (authoritative), cached counters, admin message, Firebase
//     Storage avatar, settings, and one character row under its uid
//   - mutedMod     role_id pending with the real role in previous_role_id,
//     no auth export record
//   - customHolder custom role, no document nickname (provider name instead),
//     registration date only in the auth export
//   - noEmail      no address anywhere: must be skipped, never invented
//   - emailOnly    document address only, no nickname: email local part
//   - reservedNick reserved nickname: imported anyway, reported
func newUserTestPlan() *ImportPlan {
	return &ImportPlan{
		Users: map[string]map[string]any{
			"rootOwner": {
				"nickname":      "Owner",
				"role_id":       "root",
				"email":         "owner@legacy.example",
				"created_at":    time.Date(2019, 4, 1, 12, 0, 0, 0, time.UTC),
				"post_count":    42,
				"reputation":    7,
				"admin_message": "only the moderator may see this",
				"avatar_url":    "https://firebasestorage.googleapis.com/v0/b/bucket/o/avatar.png",
				"bio":           "I run this place",
				"settings":      map[string]any{"theme": "dark", "signature": "cheers"},
			},
			"mutedMod": {
				"nickname":         "Muted",
				"role_id":          "pending",
				"previous_role_id": "moderator",
				"email":            "Muted@Legacy.Example",
			},
			"customHolder": {
				"role_id": "custom1",
			},
			"noEmail": {
				"nickname": "Ghost",
				"role_id":  "player",
			},
			"emailOnly": {
				"role_id": "player",
				"email":   "Fire.Breather@Legacy.Example",
			},
			"reservedNick": {
				"nickname": "Moderator",
				"role_id":  "player",
				"email":    "reserved@legacy.example",
			},
		},
		AuthUsers: map[string]*AuthExportUser{
			"rootOwner": {LocalID: "rootOwner", Email: " Owner@Auth.Example ",
				EmailVerified: true, DisplayName: "ProviderOwner", CreatedAt: "1554100800000"},
			"customHolder": {LocalID: "customHolder", Email: "custom@auth.example",
				EmailVerified: false, DisplayName: "  Demon Fan  ", CreatedAt: "1600000000000"},
			"reservedNick": {LocalID: "reservedNick", Email: "reserved@auth.example",
				EmailVerified: true},
		},
		Roles: map[string]map[string]any{
			"custom1": {"name": "Demon", "base_role_id": "moderator", "is_system": false},
		},
		// A character row lives in plan.Characters (the classifier routes
		// users/{uid}/characters/{cid} there), not in the account bucket.
		Characters: map[string]map[string]any{
			"rootOwner/characters/c1": {"name": "Tavern Keeper"},
		},
	}
}

// reservedPredicate is the stand-in for auth.IsReservedNickname, which the
// command adapter supplies in production.
func reservedPredicate(nickname string) bool {
	return strings.EqualFold(nickname, "moderator")
}

// userRows indexes the planned rows by legacy uid for concise assertions.
func userRows(up *UserPlan) map[string]UserRow {
	out := make(map[string]UserRow, len(up.Rows))
	for _, row := range up.Rows {
		out[row.LegacyUID] = row
	}
	return out
}

func TestBuildUserPlan_CredentialsPrecedenceAndSkips(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	rows := userRows(up)

	if len(up.Rows) != 5 {
		t.Fatalf("rows = %d, want 5 (6 account docs minus the email-less one; the character row is not an account)", len(up.Rows))
	}
	if len(up.SkippedUIDs) != 1 || up.SkippedUIDs[0] != "noEmail" {
		t.Fatalf("skipped = %v, want [noEmail]", up.SkippedUIDs)
	}
	if _, ok := rows["rootOwner/characters/c1"]; ok {
		t.Error("character subcollection row planned as an account")
	}

	owner := rows["rootOwner"]
	// The auth export wins over the document address, is trimmed and
	// lowercased, and carries the verified flag.
	if owner.Email != "owner@auth.example" {
		t.Errorf("email = %q, want the auth export address", owner.Email)
	}
	if !owner.Verified {
		t.Error("verified = false, want the auth export flag")
	}
	if _, ok := owner.Findings["user_email_from_legacy_document"]; ok {
		t.Error("owner must not report the document fallback; the auth export holds the address")
	}

	// No auth export record: address falls back to the document (reported)
	// and verified can only be false.
	muted := rows["mutedMod"]
	if muted.Email != "muted@legacy.example" {
		t.Errorf("email = %q, want the document address lowercased", muted.Email)
	}
	if muted.Verified {
		t.Error("verified = true for an account without auth export metadata")
	}
	if _, ok := muted.Findings["user_without_auth_record"]; !ok {
		t.Error("missing user_without_auth_record finding")
	}
	if _, ok := muted.Findings["user_email_from_legacy_document"]; !ok {
		t.Error("missing user_email_from_legacy_document finding")
	}

	// Registration date: document first, auth export (epoch millis) second,
	// zero only when neither holds one.
	if want := time.Date(2019, 4, 1, 12, 0, 0, 0, time.UTC); !owner.CreatedAt.Equal(want) {
		t.Errorf("owner created = %s, want %s", owner.CreatedAt, want)
	}
	if want := time.UnixMilli(1600000000000).UTC(); !rows["customHolder"].CreatedAt.Equal(want) {
		t.Errorf("customHolder created = %s, want the auth export instant %s",
			rows["customHolder"].CreatedAt, want)
	}
	if !muted.CreatedAt.IsZero() {
		t.Errorf("mutedMod created = %s, want zero when no source holds a date", muted.CreatedAt)
	}
}

func TestBuildUserPlan_IdentityTranslation(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	rows := userRows(up)

	if up.RootUID != "rootOwner" {
		t.Fatalf("RootUID = %q, want rootOwner", up.RootUID)
	}
	owner := rows["rootOwner"]
	if owner.Role != "root" || owner.Status != "active" {
		t.Errorf("owner identity = %s/%s, want root/active", owner.Role, owner.Status)
	}
	if owner.TargetID != DeriveID(SpaceUser, "rootOwner") {
		t.Errorf("target id = %q, want the same derived id every relation uses", owner.TargetID)
	}

	// role_id "pending" is account state, not a role: the status becomes
	// pending and previous_role_id restores the real role.
	muted := rows["mutedMod"]
	if muted.Role != "moderator" || muted.Status != "pending" {
		t.Errorf("muted identity = %s/%s, want moderator/pending", muted.Role, muted.Status)
	}
	if _, ok := muted.Findings["user_role_translated"]; !ok {
		t.Error("missing user_role_translated finding for the pseudo-role")
	}

	// A custom role id is kept verbatim with its system base recorded, so
	// "is this account staff?" stays answerable from the compiled matrix.
	custom := rows["customHolder"]
	if custom.Role != "custom1" || custom.CustomRoleID != "moderator" {
		t.Errorf("custom identity = %s (base %q), want custom1 (base moderator)",
			custom.Role, custom.CustomRoleID)
	}
	if _, ok := custom.Findings["custom_role_assigned"]; !ok {
		t.Error("missing custom_role_assigned finding")
	}
	if got := up.Findings["custom_role_assigned"].Count; got != 1 {
		t.Errorf("plan-level custom_role_assigned count = %d, want 1", got)
	}
}

func TestBuildUserPlan_NicknameFallbackChain(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	rows := userRows(up)

	// Document nickname is used as-is, without a fallback finding.
	owner := rows["rootOwner"]
	if owner.Nickname != "Owner" {
		t.Errorf("owner nickname = %q, want Owner", owner.Nickname)
	}
	if _, ok := owner.Findings["user_nickname_from_provider"]; ok {
		t.Error("owner has a document nickname; no provider fallback expected")
	}

	// No document nickname: the provider display name, trimmed, reported.
	custom := rows["customHolder"]
	if custom.Nickname != "Demon Fan" {
		t.Errorf("customHolder nickname = %q, want the trimmed provider name", custom.Nickname)
	}
	if _, ok := custom.Findings["user_nickname_from_provider"]; !ok {
		t.Error("missing user_nickname_from_provider finding")
	}

	// No nickname anywhere: the local part of the (already normalised) email.
	emailOnly := rows["emailOnly"]
	if emailOnly.Nickname != "fire.breather" {
		t.Errorf("emailOnly nickname = %q, want the email local part", emailOnly.Nickname)
	}
	if _, ok := emailOnly.Findings["user_nickname_from_email"]; !ok {
		t.Error("missing user_nickname_from_email finding")
	}

	// A reserved nickname is still imported — refusing it would lock a real
	// member out — and reported for a staff rename.
	reserved := rows["reservedNick"]
	if reserved.Nickname != "Moderator" {
		t.Errorf("reservedNick nickname = %q, want it kept verbatim", reserved.Nickname)
	}
	if _, ok := reserved.Findings["user_nickname_reserved"]; !ok {
		t.Error("missing user_nickname_reserved finding")
	}
	if reserved.Email != "reserved@auth.example" || !reserved.Verified {
		t.Errorf("reservedNick credentials = %s/%t, want the auth export values",
			reserved.Email, reserved.Verified)
	}
}

func TestBuildUserPlan_ReportedDecisions(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	owner := userRows(up)["rootOwner"]

	// Every deliberate omission or deferral is a finding, at row level...
	for _, code := range []string{
		"avatar_url_pending_storage_rewrite",
		"admin_message_not_imported",
		"user_counters_deferred_to_rebuild",
		"user_characters_owned_by_characters_writer",
	} {
		if _, ok := owner.Findings[code]; !ok {
			t.Errorf("owner row is missing the %q finding", code)
		}
		f := up.Findings[code]
		if f == nil || f.Count != 1 {
			t.Errorf("plan finding %q = %+v, want one occurrence", code, f)
		}
	}
	if got := up.Findings["user_without_auth_record"].Count; got != 2 {
		t.Errorf("user_without_auth_record count = %d, want 2 (mutedMod, emailOnly)", got)
	}
	pw := up.Findings["password_not_transferable"]
	if pw == nil || pw.Examples[0] != "accounts=5" {
		t.Errorf("password_not_transferable = %+v, want accounts=5", pw)
	}
	if _, ok := up.Findings["root_admin_missing"]; ok {
		t.Error("the fixture has a root account; root_admin_missing must not be reported")
	}

	// Settings migrate verbatim — the frontend reads theme, language and
	// signature straight out of users.settings.
	if owner.Settings["theme"] != "dark" || owner.Settings["signature"] != "cheers" {
		t.Errorf("settings = %v, want the legacy object copied verbatim", owner.Settings)
	}
	if owner.Profile.Bio != "I run this place" {
		t.Errorf("bio = %q, want the explicit profile column filled", owner.Profile.Bio)
	}
}

func TestBuildUserPlan_IsDeterministic(t *testing.T) {
	first := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	second := BuildUserPlan(newUserTestPlan(), reservedPredicate)

	a := strings.Join(first.SortedRowLines(), "\n")
	b := strings.Join(second.SortedRowLines(), "\n")
	if a != b {
		t.Error("two plans of the same input render differently; the report must be reproducible")
	}
	prev := ""
	for _, row := range first.Rows {
		if prev != "" && row.LegacyUID < prev {
			t.Fatalf("rows are not sorted: %q after %q", row.LegacyUID, prev)
		}
		prev = row.LegacyUID
	}
}

func TestUserPlan_SubsetRecomputesFindings(t *testing.T) {
	full := BuildUserPlan(newUserTestPlan(), reservedPredicate)

	sub, err := full.Subset([]string{"rootOwner"})
	if err != nil {
		t.Fatal(err)
	}
	if len(sub.Rows) != 1 || sub.Rows[0].LegacyUID != "rootOwner" {
		t.Fatalf("subset rows = %+v, want only rootOwner", sub.Rows)
	}
	// The findings describe the selection, not the full export: a
	// -root-only bootstrap must not report accounts it never touches.
	pw := sub.Findings["password_not_transferable"]
	if pw == nil || pw.Examples[0] != "accounts=1" {
		t.Errorf("password_not_transferable = %+v, want accounts=1", pw)
	}
	if _, ok := sub.Findings["user_without_auth_record"]; ok {
		t.Error("subset findings leaked decisions about unselected accounts")
	}
	if sub.RootUID != "rootOwner" {
		t.Errorf("subset RootUID = %q, want it preserved", sub.RootUID)
	}

	if _, err := full.Subset([]string{"nobody"}); err == nil {
		t.Error("selecting an unknown account must fail instead of importing nothing")
	}
	if _, err := full.Subset(nil); err == nil {
		t.Error("an empty selection must fail")
	}
}

func TestUserPlan_RootAdminRow(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	row, err := up.RootAdminRow()
	if err != nil {
		t.Fatal(err)
	}
	if row.LegacyUID != "rootOwner" {
		t.Errorf("root row = %q, want rootOwner", row.LegacyUID)
	}

	// No root in the export: the tooling refuses to guess who owns the forum.
	noRoot := newUserTestPlan()
	noRoot.Users["rootOwner"]["role_id"] = "admin"
	without := BuildUserPlan(noRoot, reservedPredicate)
	if without.RootUID != "" {
		t.Fatalf("RootUID = %q, want empty", without.RootUID)
	}
	if _, ok := without.Findings["root_admin_missing"]; !ok {
		t.Error("missing root_admin_missing finding")
	}
	if _, err := without.RootAdminRow(); err == nil {
		t.Error("RootAdminRow must fail when the export identifies no root account")
	}
}

func TestUserPlan_UpsertsCarryEveryField(t *testing.T) {
	up := BuildUserPlan(newUserTestPlan(), reservedPredicate)
	for i := range up.Rows {
		if up.Rows[i].LegacyUID == "rootOwner" {
			up.Rows[i].Password = "bootstrap-secret"
		}
	}

	upserts := up.Upserts()
	if len(upserts) != len(up.Rows) {
		t.Fatalf("upserts = %d, want %d", len(upserts), len(up.Rows))
	}
	for _, u := range upserts {
		if u.LegacyUID != "rootOwner" {
			continue
		}
		if u.TargetID != DeriveID(SpaceUser, "rootOwner") {
			t.Errorf("target id = %q, want the derived id", u.TargetID)
		}
		if u.Email != "owner@auth.example" || !u.Verified {
			t.Errorf("credentials = %s/%t", u.Email, u.Verified)
		}
		if u.Nickname != "Owner" || u.Role != "root" || u.Status != "active" {
			t.Errorf("identity = %s/%s/%s", u.Nickname, u.Role, u.Status)
		}
		if u.Profile.Bio != "I run this place" {
			t.Errorf("profile = %+v, want the explicit columns mapped", u.Profile)
		}
		if u.Settings["theme"] != "dark" {
			t.Errorf("settings = %v, want the legacy object", u.Settings)
		}
		if u.Password != "bootstrap-secret" {
			t.Errorf("password = %q, want the planned create-only password", u.Password)
		}
		if !u.CreatedAt.Equal(time.Date(2019, 4, 1, 12, 0, 0, 0, time.UTC)) {
			t.Errorf("created = %s, want the historical registration date", u.CreatedAt)
		}
		return
	}
	t.Fatal("rootOwner missing from the upserts")
}
