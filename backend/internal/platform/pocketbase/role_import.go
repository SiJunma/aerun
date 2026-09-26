package pocketbase

// Role registry import (Sprint 7).
//
// This is the first writer of the migration. It lives in the platform adapter
// because it is the only package allowed to import PocketBase, and the rules it
// encodes are non-obvious enough to belong next to the schema that enforces
// them:
//
//   - The target `roles` collection is the runtime authority and is seeded from
//     the compiled matrix in internal/auth. Its rules are all nil (server-only).
//   - The legacy snapshot's five system role documents DO carry a permissions
//     array, and the rehearsal diffs it against the compiled matrix as a set
//     (roles.go: auditLegacyRoleAgainstSpec). They are still never copied: the
//     compiled spec stays the single authority, and the diff is what proves the
//     two did not drift. Writing the legacy array instead would let a stale
//     export redefine what a role may do.
//   - Legacy custom roles ARE representable since migration 1766500000
//     (users.role is a text field validated against roles.role_id and
//     categories.allowed_roles may reference them), so the caller may pass
//     custom rows too: they are written verbatim with is_system=false and
//     their base_role_id / max_characters_limit fields.
//
// The import therefore reconciles the system registry against the compiled
// specs and appends the planned custom rows. Every write is an upsert keyed by
// the unique `role_id` index, so re-running the import is a no-op instead of a
// duplicate insert.

import (
	"fmt"
	"slices"
	"sort"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// RoleUpsert is the desired state of one registry row, mirroring the target
// collection fields. It is the platform package's own type so this file does not
// import the migration tool (the tool imports the platform, never the reverse).
type RoleUpsert struct {
	RoleID      string
	Name        string
	Rank        int
	Color       string
	IsSystem    bool
	Permissions []string
	// BaseRoleID is the system role a custom role derives from ("" for a
	// system role); target field roles.base_role_id.
	BaseRoleID string
	// MaxCharactersLimit is the per-role mask limit (0 = no explicit limit);
	// target field roles.max_characters_limit.
	MaxCharactersLimit int
}

// RoleImportReport states what the import changed, so a rehearsal can prove
// idempotency by comparing two reports.
type RoleImportReport struct {
	Created   []string
	Updated   []string
	Unchanged []string
	// ExtraRoleIDs are role rows present in the target but absent from the
	// compiled specs. They are never deleted here (deletion is a separate,
	// explicitly reviewed decision) but they are reported.
	ExtraRoleIDs []string
}

// Changed reports whether the import modified anything.
func (r RoleImportReport) Changed() bool {
	return len(r.Created) > 0 || len(r.Updated) > 0
}

// SystemRoleUpserts converts the compiled specs into upserts. This is the single
// source of truth: the migration seed and this importer must not drift.
func SystemRoleUpserts() []RoleUpsert {
	specs := auth.SystemRoles()
	out := make([]RoleUpsert, 0, len(specs))
	for _, spec := range specs {
		out = append(out, RoleUpsert{
			RoleID:      string(spec.Role),
			Name:        spec.Name,
			Rank:        spec.Rank,
			Color:       spec.Color,
			IsSystem:    spec.IsSystem,
			Permissions: auth.PermissionValues(spec.Permissions),
		})
	}
	return out
}

// ImportRoleRegistry makes the roles collection match upserts exactly. It runs
// in a single transaction so a failure cannot leave a half-written registry —
// a registry with a missing role would deny permissions forum-wide.
func ImportRoleRegistry(app core.App, upserts []RoleUpsert) (RoleImportReport, error) {
	var report RoleImportReport

	col, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return report, fmt.Errorf("roles collection unavailable: %w", err)
	}

	wanted := make(map[string]RoleUpsert, len(upserts))
	for _, u := range upserts {
		if u.RoleID == "" {
			return report, fmt.Errorf("role upsert without role_id")
		}
		if _, dup := wanted[u.RoleID]; dup {
			return report, fmt.Errorf("duplicate role upsert %q", u.RoleID)
		}
		wanted[u.RoleID] = u
	}

	err = app.RunInTransaction(func(txApp core.App) error {
		existing := make(map[string]*core.Record)
		rows, err := txApp.FindAllRecords(col.Id)
		if err != nil {
			return fmt.Errorf("read roles: %w", err)
		}
		for _, rec := range rows {
			if id := rec.GetString("role_id"); id != "" {
				existing[id] = rec
			}
		}

		ids := make([]string, 0, len(wanted))
		for id := range wanted {
			ids = append(ids, id)
		}
		sort.Strings(ids)

		for _, id := range ids {
			u := wanted[id]
			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				applyRoleUpsert(rec, u)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create role %s: %w", id, err)
				}
				report.Created = append(report.Created, id)
				continue
			}
			// A record is "clean" only if it already equals the spec. The
			// comparison therefore has to happen on the untouched record:
			// applyRoleUpsert would overwrite the very values being compared
			// and every run would report a change.
			if roleRecordMatches(rec, u) {
				report.Unchanged = append(report.Unchanged, id)
				continue
			}
			applyRoleUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update role %s: %w", id, err)
			}
			report.Updated = append(report.Updated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraRoleIDs = append(report.ExtraRoleIDs, id)
			}
		}
		sort.Strings(report.ExtraRoleIDs)
		return nil
	})
	if err != nil {
		return RoleImportReport{}, err
	}
	return report, nil
}

// applyRoleUpsert writes the desired state onto a record. It mirrors the seed
// in migration 1766000000 exactly, so a role written here is byte-identical to
// one written at migration time.
func applyRoleUpsert(rec *core.Record, u RoleUpsert) {
	rec.Set("role_id", u.RoleID)
	rec.Set("name", u.Name)
	rec.Set("rank", u.Rank)
	rec.Set("color", u.Color)
	rec.Set("is_system", u.IsSystem)
	rec.Set("permissions", u.Permissions)
	rec.Set("base_role_id", u.BaseRoleID)
	rec.Set("max_characters_limit", u.MaxCharactersLimit)
}

// roleRecordMatches reports whether rec already holds the desired state.
// Permissions are compared as sorted sets: PocketBase preserves the order a
// SelectField was given, but the compiled specs are an unordered vocabulary,
// so a reordering must not look like a schema change.
func roleRecordMatches(rec *core.Record, u RoleUpsert) bool {
	return rec.GetString("role_id") == u.RoleID &&
		rec.GetString("name") == u.Name &&
		rec.GetInt("rank") == u.Rank &&
		rec.GetString("color") == u.Color &&
		rec.GetBool("is_system") == u.IsSystem &&
		rec.GetString("base_role_id") == u.BaseRoleID &&
		rec.GetInt("max_characters_limit") == u.MaxCharactersLimit &&
		sameStringSet(rec.GetStringSlice("permissions"), u.Permissions)
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x := slices.Clone(a)
	y := slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}
