package importer

// Legacy -> target identity compatibility (Sprint 7 task 2/4).
//
// Two legacy conventions do not survive into the target contract and have to
// be translated record by record, otherwise the import silently changes who
// may do what:
//
//  1. The legacy app stored account state *inside* role_id: a suspended
//     player had role_id "pending" and a banned moderator had role_id
//     "banned", with the real role parked in previous_role_id. The target
//     model separates the two (see internal/auth/status.go), so those pseudo
//     roles must become statuses and the role must be restored.
//  2. The legacy roles collection also holds *custom* rows (is_system false,
//     random doc id, e.g. "Demon" or "NorthbayCitizen+"). Since migration
//     1766500000 these are first-class target data: users.role is a text field
//     validated against roles.role_id, so a custom role id is kept verbatim and
//     its system base role is recorded in users.custom_role_id. The role
//     documents themselves are imported verbatim by the roles writer (see
//     roles.go: BuildRolePlan.CustomRows).
//
// Anything that cannot be represented is returned as a note so the
// reconciliation report can explain every difference between source and
// target, which is exactly what the Sprint 7 DoD demands.

import (
	"fmt"
	"sort"
	"strings"
)

// Pseudo role ids the legacy application used to encode account state.
const (
	legacyRolePending = "pending"
	legacyRoleBanned  = "banned"
	legacyRoleGuest   = "guest"
)

// DefaultImportRole is the role assigned when a legacy user carries no
// resolvable role. It is deliberately "player" and never "guest": imported
// accounts are real members, and a guest downgrade would lock a working
// account out of the forum — the failure mode fixed in 1b8752b.
const DefaultImportRole = "player"

// Identity holds the translated account state for one imported user.
type Identity struct {
	// Role is the target role id. It may be a compiled system role or an
	// imported custom role id: migration 1766500000 made users.role a text
	// field validated against roles.role_id, so a custom role is representable.
	Role string
	// BaseRoleID is the system role a custom role derives from ("" for a
	// system role). It feeds users.custom_role_id, keeping "am I staff?"
	// answerable from the compiled matrix.
	BaseRoleID string
	// Status is the target account status.
	Status string
	// LegacyRole is the raw legacy role_id, kept for the report.
	LegacyRole string
	// CustomRole is the legacy custom role id when the user holds one.
	CustomRole string
	// Notes explains every non-trivial decision taken for this user.
	Notes []string
}

// MapUserRole translates a legacy user document into a target role/status
// pair. plan is consulted to resolve custom role ids through their role
// document. Unknown input never fails the import: it falls back to a safe
// value and reports what happened through Notes.
func MapUserRole(plan *ImportPlan, fields map[string]any) Identity {
	legacy := stringField(fields, "role_id")
	prev := stringField(fields, "previous_role_id")
	status := stringField(fields, "status")

	id := Identity{LegacyRole: legacy, Role: DefaultImportRole, Status: "active"}

	switch legacy {
	case "":
		id.Notes = append(id.Notes, "role_id missing")
	case legacyRolePending, legacyRoleBanned:
		want := "pending"
		if legacy == legacyRoleBanned {
			want = "banned"
		}
		id.Status = want
		if prev == "" {
			id.Notes = append(id.Notes, want+" without previous_role_id")
		}
		role, base, note := resolveRole(plan, prev)
		id.Role, id.BaseRoleID, id.CustomRole = role, base, customRoleID(role)
		if note != "" {
			id.Notes = append(id.Notes, note)
		}
	case legacyRoleGuest:
		// A stored account is never a guest: guests are not persisted
		// identities in the target model.
		id.Notes = append(id.Notes, "role_id guest mapped to player")
	default:
		role, base, note := resolveRole(plan, legacy)
		id.Role, id.BaseRoleID, id.CustomRole = role, base, customRoleID(role)
		if note != "" {
			id.Notes = append(id.Notes, note)
		}
	}

	// A real status field is authoritative unless it disagrees with a
	// state-role; there the more restrictive role already won.
	switch status {
	case "":
	case "active":
		id.Status = "active"
	case "banned", "pending":
		if id.Status == "active" {
			id.Status = status
		} else if id.Status != status {
			id.Notes = append(id.Notes, fmt.Sprintf(
				"status %q disagrees with role_id %q, kept %q", status, legacy, id.Status))
		}
	default:
		id.Notes = append(id.Notes, fmt.Sprintf("unknown status %q mapped to active", status))
	}

	return id
}

// resolveRole maps a legacy role id onto a target role id. Since migration
// 1766500000 a custom role is representable, so a custom role id is kept
// verbatim and its (system) base role is returned for users.custom_role_id.
// note is the human-readable explanation appended to the user's Notes.
func resolveRole(plan *ImportPlan, legacyRole string) (role, baseRole, note string) {
	if legacyRole == "" {
		return DefaultImportRole, "", "role_id missing"
	}
	if isSystemRole(legacyRole) {
		return legacyRole, "", ""
	}
	doc, ok := plan.Roles[legacyRole]
	if !ok {
		// Dangling reference: the legacy UI allowed role ids that never got
		// a role document (the "root" alias in the live export is one).
		return DefaultImportRole, "", fmt.Sprintf("unknown role_id %q mapped to player", legacyRole)
	}
	name := stringField(doc, "name")
	base := stringField(doc, "base_role_id")
	if !isSystemRole(base) {
		return legacyRole, DefaultImportRole,
			fmt.Sprintf("custom role %q kept, unknown base_role_id %q mapped to %s", name, base, DefaultImportRole)
	}
	return legacyRole, base, fmt.Sprintf("custom role %q kept as role_id (base %s)", name, base)
}

// customRoleID reports whether a resolved role id denotes a custom role.
func customRoleID(role string) string {
	if isSystemRole(role) {
		return ""
	}
	return role
}

func isSystemRole(role string) bool {
	switch role {
	case "root", "admin", "moderator", "player", "spectator", "guest":
		return true
	default:
		return false
	}
}

// Finding is one explainable difference between the source export and the
// target schema. Findings never abort an import by themselves; they are what
// makes the reconciliation report auditable.
type Finding struct {
	Code  string
	Count int
	// Examples holds up to maxFindingDetails affected legacy ids.
	Examples []string
}

// maxFindingDetails bounds report size: the ledger holds thousands of posts and
// repeating that list per finding would bury the decision-maker.
const maxFindingDetails = 10

// Compatibility aggregates the decisions MapUserRole took across the plan plus
// the structural gaps that need a human decision before cutover.
type Compatibility struct {
	// RoleDecisions counts "legacy role -> target role" transitions.
	RoleDecisions map[string]int
	// StatusCounts counts the target statuses assigned.
	StatusCounts map[string]int
	// Findings lists representability gaps, keyed by code.
	Findings map[string]*Finding
}

// AuditPlan walks the plan and records every mapping decision and every
// representability gap. It is read-only and cheap, so the CLI runs it on every
// rehearsal.
func AuditPlan(plan *ImportPlan) *Compatibility {
	c := &Compatibility{
		RoleDecisions: make(map[string]int),
		StatusCounts:  make(map[string]int),
		Findings:      make(map[string]*Finding),
	}
	// The first maxFindingDetails *lexicographically smallest* examples are
	// kept, not the first ones encountered: plan buckets are Go maps whose
	// iteration order is random, so "first seen" would make two reports of the
	// same export differ and destroy the report diff that Sprint 7 relies on.
	// A bounded sorted insert keeps memory constant without materialising every
	// id of a 3k-post collection.
	note := func(code, example string) {
		f, ok := c.Findings[code]
		if !ok {
			f = &Finding{Code: code}
			c.Findings[code] = f
		}
		f.Count++
		i := sort.SearchStrings(f.Examples, example)
		if i < len(f.Examples) && f.Examples[i] == example {
			return // same record noted twice; counted, not repeated
		}
		if len(f.Examples) >= maxFindingDetails {
			if example > f.Examples[len(f.Examples)-1] {
				return // larger than every retained example: count only
			}
			f.Examples = f.Examples[:maxFindingDetails-1]
		}
		f.Examples = append(f.Examples, "")
		copy(f.Examples[i+1:], f.Examples[i:])
		f.Examples[i] = example
	}

	// Users is keyed by Firebase UID, but the classifier also parks character
	// subcollection rows ("uid/characters/cid") in the same bucket: they are
	// not accounts and have no role/status by design, so auditing them would
	// drown the report in fake "role_id missing" entries. They are folded into
	// the parent user's settings at write time, which is itself a decision the
	// report has to show.
	charKeys := make([]string, 0)
	for uid, fields := range plan.Users {
		if strings.Contains(uid, "/") {
			charKeys = append(charKeys, uid)
			continue
		}
		id := MapUserRole(plan, fields)
		c.RoleDecisions[fmt.Sprintf("%s -> %s", id.LegacyRole, id.Role)]++
		c.StatusCounts[id.Status]++
		if id.CustomRole != "" {
			note("custom_role_assigned", fmt.Sprintf("%s=%s(base %s)", uid, id.CustomRole, id.BaseRoleID))
		}
		for _, n := range id.Notes {
			note(n, uid)
		}
	}
	for _, key := range charKeys {
		note("character_docs_folded_into_user_settings", key)
	}

	// Auth export credentials whose account document was dropped as an
	// orphan (no role_id) are dead users: they are counted here so a reviewer
	// sees that the auth export was not silently merged.
	orphanAuth := make([]string, 0)
	for uid := range plan.AuthUsers {
		if _, ok := plan.Users[uid]; !ok {
			orphanAuth = append(orphanAuth, uid)
		}
	}
	sort.Strings(orphanAuth)
	if len(orphanAuth) > 0 {
		f := &Finding{Code: "orphan_auth_record_dropped", Count: len(orphanAuth)}
		for _, uid := range orphanAuth {
			f.Examples = appendBounded(f.Examples, uid)
		}
		c.Findings["orphan_auth_record_dropped"] = f
	}

	// Posts must carry a per-topic sequence in the target, and the legacy
	// document stores none; it is rebuilt from created_at order.
	for id := range plan.Posts {
		note("post_sequence_recomputed", id)
	}

	// Category groups exist in the source but have no target collection yet:
	// categories are flattened in the target forum tree.
	for id := range plan.CategoryGroups {
		note("category_group_without_target_table", id)
	}

	// Drafts import into posts with is_draft=true: each one is reported as a
	// decision, so a reviewer sees that authored unsent content survives the
	// cutover. They are NOT counted into post counters (RecomputeCounters
	// reads plan.Posts only) and get no sequence until published.
	for _, id := range sortedKeys(plan.Drafts) {
		note("draft_imported_as_post", id)
	}
	return c
}

// SortedRoleDecisions returns role transitions in deterministic order, so two
// rehearsals over the same export print byte-identical reports.
func (c *Compatibility) SortedRoleDecisions() []string {
	out := make([]string, 0, len(c.RoleDecisions))
	for k, v := range c.RoleDecisions {
		out = append(out, fmt.Sprintf("%s: %d", k, v))
	}
	sort.Strings(out)
	return out
}

// SortedFindings returns the findings in deterministic order.
func (c *Compatibility) SortedFindings() []string {
	return SortedFindings(c.Findings)
}

// SortedFindings renders any finding set in deterministic order. It is exported
// because the roles reconciliation (roles.go) reports findings too, and both
// must render identically for a reviewer to read one combined report.
func SortedFindings(findings map[string]*Finding) []string {
	out := make([]string, 0, len(findings))
	for _, f := range findings {
		out = append(out, fmt.Sprintf("%s: %d %v", f.Code, f.Count, f.Examples))
	}
	sort.Strings(out)
	return out
}
