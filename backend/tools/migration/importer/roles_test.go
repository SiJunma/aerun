package importer

import (
	"strings"
	"testing"
)

// TestDifference pins the set-difference semantics used by the permission
// drift report. It previously returned the intersection instead, so
// "legacy-only" and "compiled-only" printed identical lists and real drift was
// invisible.
func TestDifference(t *testing.T) {
	cases := []struct {
		name string
		a, b []string
		want []string
	}{
		{"identical", []string{"a", "b"}, []string{"b", "a"}, []string{}},
		{"only in a", []string{"a", "b"}, []string{"a"}, []string{"b"}},
		{"only in b", []string{"a"}, []string{"a", "b"}, []string{}},
		{"disjoint", []string{"a"}, []string{"b"}, []string{"a"}},
		{"extra copies count", []string{"a", "a", "b"}, []string{"a"}, []string{"a", "b"}},
		{"sorted output", []string{"z", "a", "m"}, nil, []string{"a", "m", "z"}},
		{"empty a", nil, []string{"a"}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := difference(tc.a, tc.b)
			if len(got) != len(tc.want) {
				t.Fatalf("difference(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("difference(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
				}
			}
			// Both sides of a drift report being non-empty and equal means the
			// comparison itself is broken.
			back := difference(tc.b, tc.a)
			if len(got) > 0 && len(back) > 0 && sameStringSet(got, back) {
				t.Fatalf("difference is symmetric for %v/%v: %v", tc.a, tc.b, got)
			}
		})
	}
}

func TestSameStringSet(t *testing.T) {
	if !sameStringSet([]string{"a", "b"}, []string{"b", "a"}) {
		t.Error("order must not matter for a permission set")
	}
	if sameStringSet([]string{"a"}, []string{"a", "b"}) {
		t.Error("different sizes must not compare equal")
	}
	if sameStringSet([]string{"a", "a"}, []string{"a"}) {
		t.Error("duplicates must not compare equal")
	}
	if !sameStringSet(nil, []string{}) {
		t.Error("empty inputs must compare equal")
	}
}

// TestAppendBoundedTruncatesASortedWalk documents the real contract: the
// helper only truncates, and determinism comes from the caller walking sorted
// keys (see BuildRolePlan). An unsorted walk would keep an arbitrary prefix,
// which is why the walk is sorted rather than the helper.
func TestAppendBoundedTruncatesASortedWalk(t *testing.T) {
	input := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"}

	var list []string
	for _, s := range input {
		list = appendBounded(list, s)
	}
	if len(list) != maxFindingDetails {
		t.Fatalf("list length = %d, want the cap %d", len(list), maxFindingDetails)
	}
	// The retained prefix is the first maxFindingDetails of the walk.
	if want := input[:maxFindingDetails]; !equalStrings(list, want) {
		t.Errorf("list = %v, want %v", list, want)
	}

	// At the cap the list must not grow.
	before := len(list)
	list = appendBounded(list, "z")
	if len(list) != before {
		t.Errorf("length changed past the cap: %d, want %d", len(list), before)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// testSystemRoleSpecs mirrors internal/auth's compiled system roles: the
// authority the target roles registry is seeded from.
func testSystemRoleSpecs() []RoleRow {
	return []RoleRow{
		{RoleID: "admin", Name: "Admin", Rank: 1000, Color: "danger", IsSystem: true,
			Permissions: []string{"view_forum", "post_reply", "manage_users"}},
		{RoleID: "moderator", Name: "Moderator", Rank: 500, Color: "info", IsSystem: true,
			Permissions: []string{"view_forum", "post_reply"}},
		{RoleID: "player", Name: "Player", Rank: 100, Color: "primary", IsSystem: true,
			Permissions: []string{"view_forum", "post_reply"}},
		{RoleID: "spectator", Name: "Spectator", Rank: 50, Color: "secondary", IsSystem: true,
			Permissions: []string{"view_forum"}},
		{RoleID: "guest", Name: "Guest", Rank: 0, Color: "light", IsSystem: true,
			Permissions: []string{"view_forum"}},
	}
}

// TestBuildRolePlan_SystemRolesMatchCompiled is the positive case from the real
// 2026-09 export: the five legacy system documents agree with the compiled
// matrix, which is the evidence that the compiled contract is a faithful port.
func TestBuildRolePlan_SystemRolesMatchCompiled(t *testing.T) {
	plan := newCompatPlan()
	specs := testSystemRoleSpecs()
	for _, spec := range specs {
		plan.Roles[spec.RoleID] = map[string]any{
			"name":         spec.Name,
			"color":        spec.Color,
			"is_system":    true,
			"base_role_id": spec.RoleID,
			"permissions":  toAnySlice(spec.Permissions),
		}
	}

	rp, err := BuildRolePlan(plan, specs, nil)
	if err != nil {
		t.Fatalf("BuildRolePlan: %v", err)
	}
	if len(rp.LegacySystem) != len(specs) || len(rp.LegacyCustom) != 0 {
		t.Errorf("system=%d custom=%d, want %d/0",
			len(rp.LegacySystem), len(rp.LegacyCustom), len(specs))
	}
	if len(rp.MissingSystem) != 0 {
		t.Errorf("MissingSystem = %v, want none", rp.MissingSystem)
	}
	if got := rp.Findings["legacy_role_permissions_match_compiled"]; got == nil || got.Count != len(specs) {
		t.Errorf("expected %d permission matches, got %v", len(specs), got)
	}

	// The compiled spec is authority: rows equal the input, sorted, not the
	// legacy documents.
	if len(rp.Rows) != len(specs) {
		t.Fatalf("Rows = %d, want %d", len(rp.Rows), len(specs))
	}
	for i := 1; i < len(rp.Rows); i++ {
		if rp.Rows[i-1].RoleID >= rp.Rows[i].RoleID {
			t.Fatalf("Rows are not sorted by role_id: %v", rp.Rows)
		}
	}
	if rp.Rows[0].RoleID != "admin" || !rp.Rows[0].IsSystem || rp.Rows[0].Rank != 1000 {
		t.Errorf("admin row = %+v, want the compiled spec", rp.Rows[0])
	}
	// Every row's permissions come from the spec, not the legacy document.
	for _, row := range rp.Rows {
		var want []string
		for _, spec := range specs {
			if spec.RoleID == row.RoleID {
				want = spec.Permissions
			}
		}
		if !sameStringSet(row.Permissions, want) {
			t.Errorf("row %s permissions = %v, want compiled %v", row.RoleID, row.Permissions, want)
		}
	}
}

// TestBuildRolePlan_CustomRolesImportedVerbatim covers the real export's four
// custom role documents: since migration 1766500000 they are first-class data,
// so they are planned verbatim (CustomRows) with their holders keeping the role.
func TestBuildRolePlan_CustomRolesImportedVerbatim(t *testing.T) {
	plan := newCompatPlan()
	specs := testSystemRoleSpecs()
	plan.Roles["suI1QvXIT0ywatdwCpci"] = map[string]any{
		"name": "NorthbayCitizen+", "color": "primary", "is_system": false,
		"base_role_id": "player", "max_characters_limit": 5,
		"permissions": toAnySlice([]string{"view_forum", "post_reply", "not_a_real_permission"}),
	}
	plan.Roles["H0EuRMeGSBiZjq3AIeo9"] = map[string]any{
		"name": "Demon", "color": "primary", "is_system": false,
		"base_role_id": "player", "permissions": toAnySlice([]string{"view_forum"}),
	}
	plan.Users["uid-1"] = map[string]any{"role_id": "suI1QvXIT0ywatdwCpci"}
	plan.Users["uid-2"] = map[string]any{"role_id": "suI1QvXIT0ywatdwCpci"}
	plan.Users["uid-3"] = map[string]any{"role_id": "H0EuRMeGSBiZjq3AIeo9"}
	// A character subcollection row repeats its parent's role_id and must not
	// be counted as a second user.
	plan.Users["uid-1/characters/c1"] = map[string]any{"role_id": "suI1QvXIT0ywatdwCpci"}

	// The permission vocabulary only knows view_forum and post_reply, so the
	// fake permission must be dropped with a finding.
	rp, err := BuildRolePlan(plan, specs, []string{"view_forum", "post_reply"})
	if err != nil {
		t.Fatalf("BuildRolePlan: %v", err)
	}
	if len(rp.LegacyCustom) != 2 {
		t.Fatalf("LegacyCustom = %v, want 2 ids", rp.LegacyCustom)
	}
	if got := rp.CustomRoleUsers["suI1QvXIT0ywatdwCpci"]; got != 2 {
		t.Errorf("custom role user count = %d, want 2 (subcollection row must not count)", got)
	}
	if got := rp.CustomRoleUsers["H0EuRMeGSBiZjq3AIeo9"]; got != 1 {
		t.Errorf("custom role user count = %d, want 1", got)
	}
	// Custom roles are planned verbatim: role_id = legacy document id,
	// is_system false, base role recorded, permissions validated.
	if len(rp.CustomRows) != 2 {
		t.Fatalf("CustomRows = %v, want 2 rows", rp.CustomRows)
	}
	byID := map[string]RoleRow{}
	for _, row := range rp.CustomRows {
		byID[row.RoleID] = row
	}
	demon := byID["H0EuRMeGSBiZjq3AIeo9"]
	if demon.Name != "Demon" || demon.IsSystem || demon.BaseRoleID != "player" ||
		strings.Join(demon.Permissions, ",") != "view_forum" {
		t.Errorf("Demon row = %+v, want verbatim player-based row", demon)
	}
	plus := byID["suI1QvXIT0ywatdwCpci"]
	if plus.MaxCharactersLimit != 5 {
		t.Errorf("NorthbayCitizen+ mask limit = %d, want 5", plus.MaxCharactersLimit)
	}
	if got := strings.Join(plus.Permissions, ","); got != "post_reply,view_forum" {
		t.Errorf("NorthbayCitizen+ permissions = %q, want the enforced subset", got)
	}
	// The compiled system rows must stay untouched by the custom import.
	if len(rp.Rows) != len(specs) {
		t.Errorf("Rows = %d, want %d system rows", len(rp.Rows), len(specs))
	}
	// The writer consumes Rows+CustomRows as one idempotent upsert set.
	// A custom role has no rank of its own: it inherits the base role's rank
	// (player = 100 in the fixture).
	upserts := rp.Upserts()
	if len(upserts) != len(specs)+2 {
		t.Fatalf("Upserts = %d, want %d", len(upserts), len(specs)+2)
	}
	if upserts[0].RoleID != "H0EuRMeGSBiZjq3AIeo9" || upserts[0].Rank != 100 {
		t.Errorf("first upsert = %+v, want the custom role with the base rank 100", upserts[0])
	}
	// All five system roles are absent from the legacy export, which is normal
	// and must be reported, not treated as an error.
	if len(rp.MissingSystem) != len(specs) {
		t.Errorf("MissingSystem = %v, want all %d", rp.MissingSystem, len(specs))
	}
	// Findings: every system role lacks a legacy document, the two custom
	// roles keep their holders, and the fake permission was dropped.
	want := map[string]int{
		"target_role_without_legacy_document": len(specs),
		"custom_role_users_keep_role":         2,
		"custom_role_permission_unknown":      1,
	}
	if len(rp.Findings) != len(want) {
		t.Errorf("findings = %v, want exactly %v", rp.SortedFindingLines(), want)
	}
	for code, count := range want {
		f, ok := rp.Findings[code]
		if !ok {
			t.Errorf("missing finding %q, got %v", code, rp.SortedFindingLines())
			continue
		}
		if f.Count != count {
			t.Errorf("finding %q count = %d, want %d", code, f.Count, count)
		}
	}
	// A clean system match must not produce a permission-drift finding: the
	// fixture's system permissions are absent, which is the "no legacy
	// document" case, not a contradiction.
	if f := rp.Findings["legacy_role_permissions_drift"]; f != nil {
		t.Errorf("unexpected permission drift for compiled system roles: %v", f)
	}
}

// toAnySlice builds the []any shape a decoded Firestore array field has, so
// fixtures exercise the same code path as real staged records.
func toAnySlice(values []string) []any {
	out := make([]any, 0, len(values))
	for _, v := range values {
		out = append(out, v)
	}
	return out
}
