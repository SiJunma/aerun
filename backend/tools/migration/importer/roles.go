package importer

// Legacy roles -> target roles registry (Sprint 7 task 2).
//
// The target `roles` collection is *seeded from the compiled matrix* in
// internal/auth (1766000000_identity_rbac.go: createRoles) and is the runtime
// authority for permissions. Importing the legacy roles collection verbatim
// would be actively harmful:
//
//   - All five legacy *system* role documents carry a permissions array that
//     agrees with the compiled matrix (the rehearsal diffs them and reports
//     `legacy_role_permissions_match_compiled`). They are still never written:
//     the compiled spec stays the single authority, and the diff is what proves
//     the two did not drift. The four custom role documents, by contrast, hold
//     their own permission sets — which is precisely why copying the collection
//     verbatim is unsafe, because those sets were never enforceable in the target.
//   - Four of the nine documents are custom roles (is_system false, random doc
//     id). Since migration 1766500000 they ARE representable: users.role is a
//     text field validated against roles.role_id and categories.allowed_roles
//     may reference them, so they are planned verbatim in CustomRows and the
//     users holding them keep their role.
//
// So the roles import is deliberately NOT a data copy. It is a reconciliation
// that proves the seeded registry is intact and reports every legacy role that
// cannot be represented. That keeps the compiled contract authoritative while
// still accounting for all source data, which is what the sprint DoD demands.

import (
	"fmt"
	"sort"
	"strings"

	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
)

// RoleRow is the target state of one roles-collection record.
type RoleRow struct {
	// RoleID is the unique business key (idx_roles_role_id).
	RoleID string
	// Name, Rank, Color and IsSystem are the target field values.
	Name     string
	Rank     int
	Color    string
	IsSystem bool
	// Permissions is the permission set for this role.
	Permissions []string
	// BaseRoleID is the system role a custom role derives from ("" for a
	// system role); target field roles.base_role_id.
	BaseRoleID string
	// MaxCharactersLimit is the per-role mask limit (0 = no explicit limit);
	// target field roles.max_characters_limit.
	MaxCharactersLimit int
}

// RolePlan is the full result of reconciling the legacy roles collection
// against the target registry.
type RolePlan struct {
	// Rows is the target system role set, sorted by role id. This is what the
	// target database must contain for the compiled matrix after the import.
	Rows []RoleRow
	// CustomRows is the legacy custom roles to be written verbatim (is_system
	// false, role_id = legacy document id), sorted by role id. Since migration
	// 1766500000 these are first-class data: categories.allowed_roles and
	// users.role may reference them.
	CustomRows []RoleRow
	// LegacySystem lists legacy documents that map 1:1 onto a system role.
	LegacySystem []string
	// LegacyCustom lists legacy custom role document ids.
	LegacyCustom []string
	// MissingSystem lists system roles with no legacy document. Expected: the
	// target registry is compiled, not source-driven, so this is normal.
	MissingSystem []string
	// CustomRoleUsers maps a custom role document id to the number of legacy
	// users that referenced it, so a reviewer sees who keeps the role.
	CustomRoleUsers map[string]int
	// Findings explains every difference, for the reconciliation report.
	Findings map[string]*Finding
}

// BuildRolePlan reconciles the plan's roles collection with the target
// registry described by systemRows (the compiled system roles, passed in so
// this package stays free of internal/auth and of PocketBase).
//
// systemRows must be the authoritative specs; anything the legacy export says
// about a system role is treated as untrusted metadata to be reported, never as
// authority. A legacy row that contradicts the spec is a finding, because a
// wrong role definition silently changes who may do what.
//
// allowedPermissions is the target permission vocabulary (compiled from
// internal/auth by the caller). A custom role permission outside it cannot be
// enforced and is dropped with a finding; nil disables the vocabulary check
// (used by tests that only exercise the structural path).
func BuildRolePlan(plan *ImportPlan, systemRows []RoleRow, allowedPermissions []string) (*RolePlan, error) {
	specs := make(map[string]RoleRow, len(systemRows))
	for _, row := range systemRows {
		if row.RoleID == "" {
			return nil, fmt.Errorf("role spec without role_id")
		}
		if _, dup := specs[row.RoleID]; dup {
			return nil, fmt.Errorf("duplicate role spec %q", row.RoleID)
		}
		specs[row.RoleID] = row
	}
	allowed := make(map[string]bool, len(allowedPermissions))
	for _, p := range allowedPermissions {
		allowed[p] = true
	}

	rp := &RolePlan{
		CustomRoleUsers: make(map[string]int),
		Findings:        make(map[string]*Finding),
	}

	// Count which legacy roles users actually reference, so the report can show
	// the blast radius of each custom role fold. Character subcollection rows
	// carry the same role fields as their parent user and must not be counted
	// twice.
	referenced := make(map[string]int)
	for uid, fields := range plan.Users {
		if strings.Contains(uid, "/") {
			continue
		}
		if role := stringField(fields, "role_id"); role != "" {
			referenced[role]++
		}
	}

	// This walk is over sorted legacy ids, so keeping only the first
	// maxFindingDetails examples is deterministic (the smallest ones).
	note := func(code, example string) {
		f, ok := rp.Findings[code]
		if !ok {
			f = &Finding{Code: code}
			rp.Findings[code] = f
		}
		f.Count++
		f.Examples = appendBounded(f.Examples, example)
	}

	for _, legacyID := range sortedKeys(plan.Roles) {
		doc := plan.Roles[legacyID]
		if isSystemRole(legacyID) {
			spec, ok := specs[legacyID]
			if !ok {
				// A legacy system role id the target does not define. Never
				// fatal: MapUserRole already folded its users.
				note("legacy_system_role_not_in_target", legacyID)
				continue
			}
			rp.LegacySystem = append(rp.LegacySystem, legacyID)
			auditLegacyRoleAgainstSpec(note, legacyID, doc, spec)
			continue
		}

		// Custom role: first-class target data since 1766500000. It is
		// planned verbatim (role_id = legacy document id) and its holders
		// keep the role; only unenforceable permissions are dropped.
		rp.LegacyCustom = append(rp.LegacyCustom, legacyID)

		base := stringField(doc, "base_role_id")
		if base != "" && !isSystemRole(base) {
			note("custom_role_base_unknown", fmt.Sprintf("%s: base %q", legacyID, base))
			base = DefaultImportRole
		}
		row := RoleRow{
			RoleID:             legacyID,
			Name:               stringField(doc, "name"),
			Color:              stringField(doc, "color"),
			IsSystem:           false,
			BaseRoleID:         base,
			MaxCharactersLimit: numberField(doc, "max_characters_limit"),
		}
		perms := stringSliceField(doc, "permissions")
		valid := make([]string, 0, len(perms))
		if len(allowed) > 0 {
			for _, p := range perms {
				if allowed[p] {
					valid = append(valid, p)
					continue
				}
				note("custom_role_permission_unknown", fmt.Sprintf("%s: %q", legacyID, p))
			}
		} else {
			valid = append(valid, perms...)
		}
		sort.Strings(valid)
		row.Permissions = valid
		rp.CustomRows = append(rp.CustomRows, row)

		if n := referenced[legacyID]; n > 0 {
			rp.CustomRoleUsers[legacyID] = n
			note("custom_role_users_keep_role", fmt.Sprintf("%s=%s(%d)", legacyID, row.Name, n))
		} else {
			note("custom_role_unreferenced", fmt.Sprintf("%s=%s", legacyID, row.Name))
		}
	}

	// Target roles with no legacy counterpart are normal: the registry is
	// compiled, so a role may exist without legacy data. Still reported so a
	// reviewer can confirm nothing was dropped.
	for _, row := range systemRows {
		if _, ok := plan.Roles[row.RoleID]; !ok {
			rp.MissingSystem = append(rp.MissingSystem, row.RoleID)
			note("target_role_without_legacy_document", row.RoleID)
		}
	}

	rp.Rows = append([]RoleRow(nil), systemRows...)
	sort.Slice(rp.Rows, func(i, j int) bool { return rp.Rows[i].RoleID < rp.Rows[j].RoleID })
	sort.Slice(rp.CustomRows, func(i, j int) bool { return rp.CustomRows[i].RoleID < rp.CustomRows[j].RoleID })
	sort.Strings(rp.LegacySystem)
	sort.Strings(rp.MissingSystem)
	sort.Strings(rp.LegacyCustom)
	return rp, nil
}

// Upserts converts the plan into the platform package's transport type so the
// roles writer can persist the full target registry: compiled system rows plus
// the imported custom rows. A custom role has no authority rank of its own
// (ordering comes from users.custom_role_id), but roles.rank is required, so a
// custom row inherits the rank of its base system role.
func (rp *RolePlan) Upserts() []pb.RoleUpsert {
	if rp == nil {
		return nil
	}
	baseRank := make(map[string]int, len(rp.Rows))
	for _, r := range rp.Rows {
		baseRank[r.RoleID] = r.Rank
	}
	rows := make([]RoleRow, 0, len(rp.Rows)+len(rp.CustomRows))
	rows = append(rows, rp.Rows...)
	rows = append(rows, rp.CustomRows...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].RoleID < rows[j].RoleID })
	out := make([]pb.RoleUpsert, 0, len(rows))
	for _, r := range rows {
		rank := r.Rank
		if !r.IsSystem {
			rank = baseRank[r.BaseRoleID]
		}
		out = append(out, pb.RoleUpsert{
			RoleID:             r.RoleID,
			Name:               r.Name,
			Rank:               rank,
			Color:              r.Color,
			IsSystem:           r.IsSystem,
			Permissions:        r.Permissions,
			BaseRoleID:         r.BaseRoleID,
			MaxCharactersLimit: r.MaxCharactersLimit,
		})
	}
	return out
}

// auditLegacyRoleAgainstSpec reports any contradiction between a legacy system
// role document and the compiled spec. Legacy is only ever the reporter here.
func auditLegacyRoleAgainstSpec(note func(code, example string), legacyID string, doc map[string]any, spec RoleRow) {
	if name := stringField(doc, "name"); name != "" && name != spec.Name {
		note("legacy_role_name_differs", fmt.Sprintf("%s: %q vs %q", legacyID, name, spec.Name))
	}
	if color := stringField(doc, "color"); color != "" && color != spec.Color {
		note("legacy_role_color_differs", fmt.Sprintf("%s: %q vs %q", legacyID, color, spec.Color))
	}
	// The decisive one. The legacy system rows DO carry a permissions array, so
	// this diffs it against the compiled spec as a set and reports both outcomes.
	// A match is the evidence that the compiled matrix is a faithful port; a
	// difference is a real drift that a human must rule on. Neither outcome ever
	// changes what gets written: the compiled spec stays the authority, so a
	// future maintainer cannot "fix" the importer into honouring the legacy array.
	perms := stringSliceField(doc, "permissions")
	switch {
	case len(perms) == 0:
		note("legacy_role_permissions_empty_using_compiled", legacyID)
	case sameStringSet(perms, spec.Permissions):
		note("legacy_role_permissions_match_compiled", fmt.Sprintf("%s=%d", legacyID, len(perms)))
	default:
		note("legacy_role_permissions_differ_from_compiled", fmt.Sprintf(
			"%s: legacy-only=%v compiled-only=%v",
			legacyID, difference(perms, spec.Permissions), difference(spec.Permissions, perms)))
	}
	if base := stringField(doc, "base_role_id"); base != "" && base != legacyID {
		note("legacy_role_base_differs", fmt.Sprintf("%s: base %q", legacyID, base))
	}
	if !legacyBoolField(doc, "is_system") {
		note("legacy_system_role_not_flagged_system", legacyID)
	}
}

// RoleRowsFrom converts the platform package's upserts into pure role rows, so
// the translation layer can reconcile them against the snapshot without
// importing PocketBase. The importer is the only allowed direction of the
// dependency: the tool depends on the platform, never the reverse.
func RoleRowsFrom(upserts []pb.RoleUpsert) []RoleRow {
	out := make([]RoleRow, 0, len(upserts))
	for _, u := range upserts {
		out = append(out, RoleRow{
			RoleID:             u.RoleID,
			Name:               u.Name,
			Rank:               u.Rank,
			Color:              u.Color,
			IsSystem:           u.IsSystem,
			Permissions:        u.Permissions,
			BaseRoleID:         u.BaseRoleID,
			MaxCharactersLimit: u.MaxCharactersLimit,
		})
	}
	return out
}

// SortedFindingLines renders the reconciliation findings in a stable order so
// two rehearsals of one export produce comparable output.
func (rp *RolePlan) SortedFindingLines() []string {
	codes := make([]string, 0, len(rp.Findings))
	for code := range rp.Findings {
		codes = append(codes, code)
	}
	sort.Strings(codes)

	lines := make([]string, 0, len(codes))
	for _, code := range codes {
		f := rp.Findings[code]
		line := fmt.Sprintf("%s: %d", code, f.Count)
		if len(f.Examples) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(f.Examples, " "))
		}
		lines = append(lines, line)
	}
	return lines
}

// SortedCustomRoleLines renders the custom-role fold blast radius in a stable
// order. CustomRoleUsers is a Go map, so iterating it directly would make the
// rehearsal output differ between two runs of the same export — which would
// defeat the DoD diff.
func (rp *RolePlan) SortedCustomRoleLines() []string {
	ids := make([]string, 0, len(rp.CustomRoleUsers))
	for id := range rp.CustomRoleUsers {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	lines := make([]string, 0, len(ids))
	for _, id := range ids {
		lines = append(lines, fmt.Sprintf("%s=%d", id, rp.CustomRoleUsers[id]))
	}
	return lines
}

// appendBounded appends example unless the list is already at the cap.
func appendBounded(list []string, example string) []string {
	if len(list) >= maxFindingDetails {
		return list
	}
	return append(list, example)
}

// sameStringSet reports whether two slices hold the same elements, ignoring
// order and duplicates. Permissions are an unordered vocabulary, so a legacy
// array that merely lists them differently is not drift.
func sameStringSet(a, b []string) bool {
	ca, cb := elementCounts(a), elementCounts(b)
	if len(ca) != len(cb) {
		return false
	}
	for k, v := range ca {
		if cb[k] != v {
			return false
		}
	}
	return true
}

// difference returns the elements of a that are absent from b, sorted. It is
// how a permission drift is explained: "legacy-only" and "compiled-only" sides.
func difference(a, b []string) []string {
	inB := elementCounts(b)
	counts := elementCounts(a)
	out := make([]string, 0, len(counts))
	for s, n := range counts {
		if missing := n - inB[s]; missing > 0 {
			for range missing {
				out = append(out, s)
			}
		}
	}
	sort.Strings(out)
	return out
}

func elementCounts(list []string) map[string]int {
	out := make(map[string]int, len(list))
	for _, s := range list {
		out[s]++
	}
	return out
}

// numberField extracts an integer field from a decoded Firestore document.
// Absent or non-numeric values are 0 — "no explicit limit" in the target.
func numberField(m map[string]any, key string) int {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

func legacyBoolField(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}
