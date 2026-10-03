package migrations

import (
	"slices"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestIdentityRbacMigration asserts the Sprint 2 schema contract: the users
// auth collection with locked mutations and a public profile read rule, and
// the roles registry seeded from the compiled matrix in internal/auth.
func TestIdentityRbacMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	// NewTestApp applies RunAllMigrations on a fresh (empty) data dir, so the
	// collections below exist exactly as production would have them.

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection must exist after migrations: %v", err)
	}
	if !users.IsAuth() {
		t.Fatal("users must be an auth collection")
	}

	for _, name := range []string{
		"nickname", "nickname_normalized", "role", "status",
		"legacy_firebase_uid", "avatar_url", "settings",
	} {
		if users.Fields.GetByName(name) == nil {
			t.Fatalf("users must contain the %q field", name)
		}
	}
	if users.Fields.GetByName("name") != nil {
		t.Fatal("the PocketBase demo field name must not survive the adoption")
	}

	// 1766500000 makes the role column free text so imported custom role ids
	// are storable. It must stay a required text field: a select could only
	// ever hold the six compiled ids, so no legacy custom role could be
	// assigned. The command layer (admin_users.go requireKnownRole) is what
	// validates the value now, against the roles collection.
	roleField, ok := users.Fields.GetByName("role").(*core.TextField)
	if !ok {
		t.Fatalf("role must be a text field so custom role ids are storable, got %T",
			users.Fields.GetByName("role"))
	}
	if !roleField.Required {
		t.Fatal("role must stay required: an empty role denies every permission")
	}
	if users.Fields.GetByName("custom_role_id") == nil {
		t.Fatal("users must carry custom_role_id to keep staff checks answerable")
	}

	statusField, ok := users.Fields.GetByName("status").(*core.SelectField)
	if !ok {
		t.Fatal("status must be a select field")
	}
	if !slices.Equal(statusField.Values, auth.AllStatusValues()) {
		t.Fatalf("status values drifted: %v", statusField.Values)
	}

	legacyField, ok := users.Fields.GetByName("legacy_firebase_uid").(*core.TextField)
	if !ok || !legacyField.Hidden {
		t.Fatal("legacy_firebase_uid must be a hidden field (never in API responses)")
	}

	indexes := string(users.Indexes.String())
	for _, index := range []string{
		"CREATE UNIQUE INDEX `idx_users_nickname_normalized`",
		"CREATE UNIQUE INDEX `idx_users_legacy_firebase_uid`",
		"nickname_normalized != ''",
		"legacy_firebase_uid != ''",
	} {
		if !strings.Contains(indexes, index) {
			t.Fatalf("users indexes must contain %q, got %s", index, indexes)
		}
	}

	// The read rules are open to everyone (1768100000): a ban limits what the
	// account may DO, not what other people may read about it. The write rules
	// below are the part that must NOT move with them — a wider view rule must
	// never become a wider write rule.
	if users.ListRule == nil || *users.ListRule != openReadRule {
		t.Fatalf("users list rule must not depend on status, got %v", users.ListRule)
	}
	if users.ViewRule == nil || *users.ViewRule != openReadRule {
		t.Fatalf("users view rule must not depend on status, got %v", users.ViewRule)
	}
	for _, rule := range []*string{users.ViewRule, users.ListRule} {
		if strings.Contains(*rule, "status") {
			t.Fatalf("no read rule may branch on status, got %q", *rule)
		}
	}
	for name, rule := range map[string]*string{
		"create": users.CreateRule,
		"update": users.UpdateRule,
		"delete": users.DeleteRule,
	} {
		if rule != nil {
			t.Fatalf("users %s rule must stay locked (nil), got %q", name, *rule)
		}
	}

	if users.AuthAlert.Enabled {
		t.Fatal("auth alerts must be disabled while mail delivery is hard-disabled")
	}
	if users.OTP.Enabled {
		t.Fatal("OTP auth must stay disabled in this sprint")
	}
	// Migrations run exactly once, so they only establish the disabled
	// baseline: the credential-driven enablement happens in the serve-time
	// configureOAuth2 reconcile (internal/platform/pocketbase/oauth2.go).
	if users.OAuth2.Enabled {
		t.Fatal("migrations must keep OAuth2 disabled, got enabled")
	}
	if !users.PasswordAuth.Enabled {
		t.Fatal("password auth must stay enabled for the upcoming registration command")
	}

	// roles registry
	roles, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		t.Fatalf("roles collection must exist after migrations: %v", err)
	}
	for name, rule := range map[string]*string{
		"list":   roles.ListRule,
		"view":   roles.ViewRule,
		"create": roles.CreateRule,
		"update": roles.UpdateRule,
		"delete": roles.DeleteRule,
	} {
		if rule != nil {
			t.Fatalf("roles %s rule must stay locked (nil), got %q", name, *rule)
		}
	}

	records, err := app.FindAllRecords("roles")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != len(auth.SystemRoles()) {
		t.Fatalf("expected %d seeded roles, got %d", len(auth.SystemRoles()), len(records))
	}
	byRole := make(map[string]*core.Record, len(records))
	for _, record := range records {
		byRole[record.GetString("role_id")] = record
	}
	for _, spec := range auth.SystemRoles() {
		record, ok := byRole[string(spec.Role)]
		if !ok {
			t.Fatalf("role %s was not seeded", spec.Role)
			continue
		}
		if record.GetString("name") != spec.Name {
			t.Fatalf("role %s name drifted: %q", spec.Role, record.GetString("name"))
		}
		if record.GetInt("rank") != spec.Rank {
			t.Fatalf("role %s rank drifted: %d", spec.Role, record.GetInt("rank"))
		}
		if record.GetString("color") != spec.Color {
			t.Fatalf("role %s color drifted: %q", spec.Role, record.GetString("color"))
		}
		if record.GetBool("is_system") != spec.IsSystem {
			t.Fatalf("role %s is_system drifted", spec.Role)
		}
		if !slices.Equal(record.GetStringSlice("permissions"), auth.PermissionValues(spec.Permissions)) {
			t.Fatalf("role %s permissions drifted: %v", spec.Role, record.GetStringSlice("permissions"))
		}
	}
}

// TestNicknameUniquenessIsEnforcedOnlyForRealNicknames pins the index
// predicate from the identity migration: two accounts can never share a
// normalised nickname, while rows that predate the identity contract
// (PocketBase snapshots, Firebase records awaiting the Sprint 7 import) may
// coexist without one instead of colliding on the empty string.
func TestNicknameUniquenessIsEnforcedOnlyForRealNicknames(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection must exist after migrations: %v", err)
	}

	newUser := func(email, nickname string) *core.Record {
		record := core.NewRecord(users)
		record.Set("email", email)
		record.SetPassword("CorrectHorse1!")
		record.Set("nickname", nickname)
		record.Set("nickname_normalized", auth.NormalizeNickname(nickname))
		record.Set("role", string(auth.RolePlayer))
		record.Set("status", string(auth.StatusActive))
		return record
	}

	if err := app.Save(newUser("first@example.com", "Aerun")); err != nil {
		t.Fatalf("failed to create the first account: %v", err)
	}
	// " AERUN " normalises to the same key, so the unique index must reject it
	// even though the raw nickname differs.
	if err := app.Save(newUser("second@example.com", " AERUN ")); err == nil {
		t.Fatal("a second account must not reuse an existing normalised nickname")
	}

	// SaveNoValidate mirrors the import path (raw row first, validation later);
	// DB constraints still apply, so this proves the predicate really excludes
	// empty nicknames.
	for i, email := range []string{"legacy-a@example.com", "legacy-b@example.com"} {
		legacy := newUser(email, "")
		legacy.Set("nickname_normalized", "")
		if err := app.SaveNoValidate(legacy); err != nil {
			t.Fatalf("legacy row %d must be accepted without a normalised nickname: %v", i, err)
		}
	}
}
