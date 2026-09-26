package importer

import (
	"fmt"
	"strings"
	"testing"
)

// newCompatPlan mirrors what the real 2026-09 export actually contains: system
// role ids, custom role documents, a "root" value with no role document, and
// accounts whose status field is absent.
func newCompatPlan() *ImportPlan {
	return &ImportPlan{
		Users:          map[string]map[string]any{},
		Roles:          map[string]map[string]any{},
		Skipped:        map[string]int{},
		AuthUsers:      map[string]*AuthExportUser{},
		Categories:     map[string]map[string]any{},
		CategoryGroups: map[string]map[string]any{"grp-1": {"name": "Northbay"}},
		Topics:         map[string]map[string]any{},
		Posts:          map[string]map[string]any{"post-1": {"topic_id": "top-1"}},
		Drafts:         map[string]map[string]any{},
		Subscriptions:  map[string]map[string]any{},
		ReputationLogs: map[string]map[string]any{},
		AuditLogs:      map[string]map[string]any{},
		Notifications:  map[string]map[string]any{},
		DMs:            map[string]map[string]any{},
		DMMessages:     map[string]map[string]any{},
	}
}

func TestMapUserRole(t *testing.T) {
	plan := newCompatPlan()
	plan.Roles["suI1QvXIT0ywatdwCpci"] = map[string]any{
		"name": "NorthbayCitizen+", "base_role_id": "player", "is_system": false,
	}
	plan.Roles["H0EuRMeGSBiZjq3AIeo9"] = map[string]any{
		"name": "Demon", "base_role_id": "admin", "is_system": false,
	}
	// A custom role whose base is itself garbage must still land somewhere safe.
	plan.Roles["brokenrole"] = map[string]any{"name": "Broken", "base_role_id": "deleted_base"}

	cases := []struct {
		name       string
		fields     map[string]any
		wantRole   string
		wantStatus string
		wantNotes  []string
	}{
		{
			name:       "plain player",
			fields:     map[string]any{"role_id": "player"},
			wantRole:   "player",
			wantStatus: "active",
		},
		{
			// The live export uses "root" for its owner account even though no
			// roles/root document exists; it is a compiled system role and must
			// survive intact.
			name:       "root survives without a role document",
			fields:     map[string]any{"role_id": "root"},
			wantRole:   "root",
			wantStatus: "active",
		},
		{
			name:       "moderator is a system role",
			fields:     map[string]any{"role_id": "moderator"},
			wantRole:   "moderator",
			wantStatus: "active",
		},
		{
			// 10 of the 12 exported accounts have no status field at all. The
			// default must be active: defaulting to pending would lock every
			// imported member out of the forum.
			name:       "missing status defaults to active",
			fields:     map[string]any{"role_id": "player"},
			wantRole:   "player",
			wantStatus: "active",
		},
		{
			name:       "custom role is kept verbatim",
			fields:     map[string]any{"role_id": "suI1QvXIT0ywatdwCpci"},
			wantRole:   "suI1QvXIT0ywatdwCpci",
			wantStatus: "active",
			wantNotes:  []string{`custom role "NorthbayCitizen+" kept as role_id (base player)`},
		},
		{
			name:       "custom role keeps its recorded base role",
			fields:     map[string]any{"role_id": "H0EuRMeGSBiZjq3AIeo9"},
			wantRole:   "H0EuRMeGSBiZjq3AIeo9",
			wantStatus: "active",
			wantNotes:  []string{`custom role "Demon" kept as role_id (base admin)`},
		},
		{
			name:       "custom role with an unrecognised base falls back to player",
			fields:     map[string]any{"role_id": "brokenrole"},
			wantRole:   "brokenrole",
			wantStatus: "active",
			wantNotes:  []string{`custom role "Broken" kept, unknown base_role_id "deleted_base" mapped to player`},
		},
		{
			name:       "unknown role id is not silently promoted",
			fields:     map[string]any{"role_id": "ghost-role"},
			wantRole:   "player",
			wantStatus: "active",
			wantNotes:  []string{`unknown role_id "ghost-role" mapped to player`},
		},
		{
			name:       "pending pseudo role becomes a status",
			fields:     map[string]any{"role_id": "pending", "previous_role_id": "moderator"},
			wantRole:   "moderator",
			wantStatus: "pending",
		},
		{
			name:       "banned pseudo role restores its previous role",
			fields:     map[string]any{"role_id": "banned", "previous_role_id": "spectator"},
			wantRole:   "spectator",
			wantStatus: "banned",
		},
		{
			name:       "banned without history keeps player",
			fields:     map[string]any{"role_id": "banned"},
			wantRole:   "player",
			wantStatus: "banned",
			wantNotes:  []string{"banned without previous_role_id", "role_id missing"},
		},
		{
			// Guests are not persisted identities in the target model, and the
			// guest role is read-only by design (1b8752b): an imported account
			// may never be downgraded to it.
			name:       "stored account is never mapped to guest",
			fields:     map[string]any{"role_id": "guest"},
			wantRole:   "player",
			wantStatus: "active",
			wantNotes:  []string{"role_id guest mapped to player"},
		},
		{
			name:       "missing role id lands on the default",
			fields:     map[string]any{"nickname": "Nobody"},
			wantRole:   "player",
			wantStatus: "active",
			wantNotes:  []string{"role_id missing"},
		},
		{
			name:       "explicit status is honoured",
			fields:     map[string]any{"role_id": "player", "status": "banned"},
			wantRole:   "player",
			wantStatus: "banned",
		},
		{
			name:       "explicit pending status is honoured",
			fields:     map[string]any{"role_id": "player", "status": "pending"},
			wantRole:   "player",
			wantStatus: "pending",
		},
		{
			name:       "state-role wins a disagreement with status",
			fields:     map[string]any{"role_id": "pending", "previous_role_id": "player", "status": "banned"},
			wantRole:   "player",
			wantStatus: "pending",
			wantNotes:  []string{`status "banned" disagrees with role_id "pending", kept "pending"`},
		},
		{
			name:       "unknown status string degrades to active and reports",
			fields:     map[string]any{"role_id": "player", "status": "suspended"},
			wantRole:   "player",
			wantStatus: "active",
			wantNotes:  []string{`unknown status "suspended" mapped to active`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MapUserRole(plan, tc.fields)
			if got.Role != tc.wantRole {
				t.Errorf("Role = %q, want %q", got.Role, tc.wantRole)
			}
			if got.Status != tc.wantStatus {
				t.Errorf("Status = %q, want %q", got.Status, tc.wantStatus)
			}
			if got.LegacyRole != stringField(tc.fields, "role_id") {
				t.Errorf("LegacyRole = %q, want %q", got.LegacyRole, stringField(tc.fields, "role_id"))
			}
			// Role resolution reports through Notes; CustomRole only carries
			// the legacy custom role id for the reconciliation report.
			gotNotes := append([]string{}, got.Notes...)
			for _, want := range tc.wantNotes {
				if !containsString(gotNotes, want) {
					t.Errorf("notes %v missing %q", gotNotes, want)
				}
			}
			if len(tc.wantNotes) != len(gotNotes) {
				t.Errorf("notes = %v, want %v", gotNotes, tc.wantNotes)
			}
			// Whatever happens, the result must be expressible in the target
			// schema: a known status and a role that either is a compiled
			// system role or has a role document (a custom role imported
			// verbatim since migration 1766500000).
			if !isSystemRole(got.Role) {
				if _, ok := plan.Roles[got.Role]; !ok {
					t.Errorf("role %q is neither a system role nor a role document", got.Role)
				}
			}
			switch got.Status {
			case "active", "pending", "banned":
			default:
				t.Errorf("status %q is not a target status", got.Status)
			}
		})
	}
}

// TestAuditPlan_CountsAndFindings checks that every plan decision is counted
// and that the structural gaps a human must rule on are always reported.
func TestAuditPlan_CountsAndFindings(t *testing.T) {
	plan := newCompatPlan()
	plan.Users["uid-1"] = map[string]any{"role_id": "player"}
	plan.Users["uid-2"] = map[string]any{"role_id": "suI1QvXIT0ywatdwCpci"}
	plan.Users["uid-3"] = map[string]any{"role_id": "banned", "previous_role_id": "moderator"}

	c := AuditPlan(plan)

	if total := sumCounts(c.RoleDecisions); total != 3 {
		t.Errorf("role decisions cover %d users, want 3", total)
	}
	if total := sumCounts(c.StatusCounts); total != 3 {
		t.Errorf("status counts cover %d users, want 3", total)
	}
	if c.StatusCounts["banned"] != 1 {
		t.Errorf("StatusCounts[banned] = %d, want 1", c.StatusCounts["banned"])
	}
	if c.RoleDecisions["suI1QvXIT0ywatdwCpci -> player"] != 1 {
		t.Errorf("custom role transition missing from %v", c.RoleDecisions)
	}
	for _, code := range []string{"post_sequence_recomputed", "category_group_without_target_table"} {
		f, ok := c.Findings[code]
		if !ok {
			t.Fatalf("finding %q missing from %v", code, c.Findings)
		}
		if f.Count != 1 || len(f.Examples) != 1 {
			t.Errorf("finding %q = count %d examples %v, want 1/1", code, f.Count, f.Examples)
		}
	}
}

// TestAuditPlan_ReportsAreDeterministic guards the rehearsal workflow: the
// report is diffed between runs, so it must not shuffle between them.
func TestAuditPlan_ReportsAreDeterministic(t *testing.T) {
	build := func() *ImportPlan {
		plan := newCompatPlan()
		for i := 0; i < 50; i++ {
			uid := fmt.Sprintf("uid-%02d", i)
			plan.Posts["post-"+uid] = map[string]any{"topic_id": "top-1"}
			plan.CategoryGroups["grp-"+uid] = map[string]any{"name": uid}
			switch i % 3 {
			case 0:
				plan.Users[uid] = map[string]any{"role_id": "player"}
			case 1:
				plan.Users[uid] = map[string]any{"role_id": "moderator"}
			default:
				plan.Users[uid] = map[string]any{"role_id": "pending", "previous_role_id": "player"}
			}
		}
		return plan
	}

	first, second := AuditPlan(build()), AuditPlan(build())
	a, b := strings.Join(first.SortedFindings(), "\n"), strings.Join(second.SortedFindings(), "\n")
	if a != b {
		t.Fatal("findings differ between two identical plans")
	}
	c, d := strings.Join(first.SortedRoleDecisions(), "\n"), strings.Join(second.SortedRoleDecisions(), "\n")
	if c != d {
		t.Fatal("role decisions differ between two identical plans")
	}
	if got := first.Findings["post_sequence_recomputed"].Count; got != 51 {
		t.Errorf("post finding count = %d, want 51 (50 seeded + 1 fixture post)", got)
	}
	// Examples are bounded so a 3k-post export cannot produce a 3k-line report.
	if got := len(first.Findings["post_sequence_recomputed"].Examples); got != maxFindingDetails {
		t.Errorf("examples = %d, want the cap %d", got, maxFindingDetails)
	}
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func sumCounts(m map[string]int) int {
	total := 0
	for _, v := range m {
		total += v
	}
	return total
}
