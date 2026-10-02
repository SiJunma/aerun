package migrations

// 1767800000_split_post_topic_permissions.go does three things that belong
// together because they all come from one product decision: moderation is
// granted per action, not as a single umbrella.
//
//  1. FORUM SETTINGS MOVE TO THE SERVER, WITH CEILINGS.
//
//     `maxPostsPerTopic` and `postsPerPage` were admin-panel values living ONLY
//     in the browser's localStorage (src/api/admin.js). The backend had no copy,
//     so what the server enforced was the compiled constant
//     forum.MaxPostsPerTopic = 5000 while the UI showed the reader 1000/2000 —
//     three numbers for one rule. Worse, the value was per-browser: an admin
//     lowering the limit did nothing to anybody else's forum, and no server-side
//     check could honour it.
//
//     The limits become rows in a `forum_settings` collection and the compiled
//     constants become CEILINGS around that tuning. The owner's instruction: the
//     setting is adjustable in the admin panel, but capped so a forum cannot be
//     left with unbounded topics.
//
//  2. PERMISSION SPLIT. `moderate_content` gated six unrelated actions
//     (edit/delete x post/topic, plus two lock bypasses), so "a moderator who
//     edits but never deletes" was unrepresentable. The eight new keys live in
//     internal/auth; this migration extends the roles.permissions SelectField
//     vocabulary and back-fills existing role rows, because that field
//     validates against a fixed list and an unknown key is a save-time error.
//
//     The back-fill is deliberately CONSERVATIVE: any role holding
//     `moderate_content` receives all eight, so no role loses a capability on
//     the day of the split. Narrowing afterwards is an explicit act.
//
//  3. AUDIT DETAILS GROW. A post delete is logged WITH THE POST TEXT (the owner
//     asked for the admin log to be the surviving record of what was said), and
//     a body may be 65536 characters. The old MaxSize could truncate exactly the
//     payload the audit exists to preserve, so it is raised well above one
//     maximum post.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// forumSettingsCollectionName is the single-row collection holding the tunable
// forum limits. One row, fixed id, so the read path is one primary-key lookup
// rather than a "latest wins" scan.
const forumSettingsCollectionName = "forum_settings"

const (
	// auditDetailsMaxBytes bounds one audit entry's details JSON. A body is at
	// most 65536 characters; a UTF-8 body of multi-byte runes can reach ~4
	// bytes each, and the delete audit carries the body alongside ids and
	// titles. 1 MiB leaves room for several such payloads in one entry.
	auditDetailsMaxBytes = 1 << 20

	// forumSettingsID is the fixed id of the single settings row. A literal
	// rather than a generated id so the row is reachable without a query, and
	// so a re-run is an upsert rather than a second row.
	//
	// It is 15 characters because that is PocketBase's minimum record id
	// length, and the record id is generated BEFORE the `key` field is applied
	// — an id shorter than that fails validation at the collection layer, not
	// at the field.
	forumSettingsID = "forumsettings01"
)

// splitPermissionKeys is the set the back-fill grants and the rollback removes.
// Declared once so the two passes cannot drift apart.
var splitPermissionKeys = []auth.Permission{
	auth.PermEditSelfPost,
	auth.PermEditOthersPosts,
	auth.PermDeleteSelfPost,
	auth.PermDeleteOthersPosts,
	auth.PermEditSelfTopic,
	auth.PermEditOthersTopics,
	auth.PermDeleteSelfTopic,
	auth.PermDeleteOthersTopics,
}

func init() {
	m.Register(applySplitPermissions, revertSplitPermissions)
}

// createForumSettings creates the collection and seeds the singleton row.
//
// The seed values are what the Firestore snapshot actually carried
// (maxPostsPerTopic 2000) rather than the frontend defaults, so a migrated
// forum does not silently resize every topic the moment it boots. Both are
// still clamped to the ceilings on read, so a legacy value above a ceiling
// degrades to the ceiling instead of being honoured.
func createForumSettings(app core.App) error {
	col := core.NewBaseCollection(forumSettingsCollectionName)
	col.Fields.Add(
		&core.TextField{Name: "key", Required: true, Max: 64},
		&core.NumberField{
			Name:     "max_posts_per_topic",
			Min:      float64Ptr(float64(auth.MinMaxPostsPerTopic)),
			Max:      float64Ptr(float64(auth.HardMaxPostsPerTopic)),
			Required: true,
		},
		&core.NumberField{
			Name:     "posts_per_page",
			Min:      float64Ptr(float64(auth.MinPostsPerPage)),
			Max:      float64Ptr(float64(auth.HardMaxPostsPerPage)),
			Required: true,
		},
	)
	// Server-only: read by the command layer, never by a browser.
	col.ListRule = nil
	col.ViewRule = nil
	col.CreateRule = nil
	col.UpdateRule = nil
	col.DeleteRule = nil

	existing, findErr := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if findErr == nil && existing != nil {
		// Idempotent against a database that already has the collection.
		col.Id = existing.Id
	} else if err := app.Save(col); err != nil {
		return err
	}

	seed, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || seed == nil {
		record := core.NewRecord(col)
		record.Set("id", forumSettingsID)
		record.Set("key", "singleton")
		record.Set("max_posts_per_topic", auth.DefaultMaxPostsPerTopic)
		record.Set("posts_per_page", auth.DefaultPostsPerPage)
		return app.Save(record)
	}
	return nil
}

// extendRolePermissionVocabulary adds the new keys to the SelectField so a
// role row may carry them.
//
// ORDER MATTERS: the values list is extended and saved BEFORE any row is
// written. A SelectField rejects a value outside its own list, so writing rows
// first would fail with "invalid permission" on the new keys.
func extendRolePermissionVocabulary(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		return fmt.Errorf("roles.permissions is not a select field")
	}
	existing := make(map[string]bool, len(field.Values))
	for _, v := range field.Values {
		existing[v] = true
	}
	for _, v := range auth.AllPermissionValues() {
		if !existing[v] {
			field.Values = append(field.Values, v)
		}
	}
	field.MaxSelect = len(field.Values)
	return app.Save(col)
}

func applySplitPermissions(app core.App) error {
	if err := createForumSettings(app); err != nil {
		return fmt.Errorf("forum_settings: %w", err)
	}
	if err := extendRolePermissionVocabulary(app); err != nil {
		return fmt.Errorf("roles permissions: %w", err)
	}
	if err := backfillSplitPermissions(app); err != nil {
		return fmt.Errorf("roles backfill: %w", err)
	}
	return enlargeAuditDetails(app)
}

func revertSplitPermissions(app core.App) error {
	if err := restoreAuditDetails(app); err != nil {
		return err
	}
	if err := removeSplitPermissions(app); err != nil {
		return err
	}
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err == nil && col != nil {
		return app.Delete(col)
	}
	return nil
}

// backfillSplitPermissions reconciles every role row against the split.
//
// TWO POPULATIONS, TWO RULES — and conflating them is a real bug this function
// was written to avoid:
//
//   - SYSTEM roles are the compiled authority (internal/auth/role.go). They are
//     re-seeded from the spec verbatim, because the spec is where the owner's
//     decision lives. A blanket "grant all eight to anything holding
//     moderate_content" would have handed MODERATORS `delete_others_topics`,
//     which the owner explicitly refused: a moderator does not delete another
//     account's topic. Trusting the umbrella key here would have quietly undone
//     a product decision in the database.
//   - CUSTOM roles (is_system=false, e.g. the imported legacy ones) have no
//     compiled spec to reconcile against, so they get the CONSERVATIVE grant:
//     anything holding `moderate_content` receives all eight, so no role loses
//     a capability the day the split lands. Narrowing one afterwards is an
//     explicit act in the admin panel.
func backfillSplitPermissions(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		return err
	}
	compiled := compiledRolePermissions()

	for _, row := range rows {
		roleID := row.GetString("role_id")
		if spec, isSystem := compiled[roleID]; isSystem {
			// Re-seed in the spec's own order, so the stored set matches
			// exactly rather than merely containing the same keys.
			row.Set("permissions", auth.PermissionValues(spec))
			if err := app.Save(row); err != nil {
				return fmt.Errorf("role %s: %w", roleID, err)
			}
			continue
		}

		current := row.GetStringSlice("permissions")
		if !permissionListHas(current, string(auth.PermModerateContent)) {
			continue
		}
		merged := current
		for _, add := range splitPermissionKeys {
			if !permissionListHas(merged, string(add)) {
				merged = append(merged, string(add))
			}
		}
		row.Set("permissions", merged)
		if err := app.Save(row); err != nil {
			return fmt.Errorf("role %s: %w", roleID, err)
		}
	}
	return nil
}

// compiledRolePermissions maps each system role id to its compiled spec, so the
// reconciliation above cannot drift from internal/auth.
func compiledRolePermissions() map[string][]auth.Permission {
	out := make(map[string][]auth.Permission)
	for _, spec := range auth.SystemRoles() {
		out[string(spec.Role)] = spec.Permissions
	}
	return out
}

// removeSplitPermissions is the rollback: the new keys leave the vocabulary and
// the rows that only gained them lose them again. It does NOT guess which key
// an operator had narrowed — `moderate_content` is still on every affected row,
// so the pre-split behaviour is restored exactly.
func removeSplitPermissions(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	drop := make(map[string]bool, len(splitPermissionKeys))
	for _, k := range splitPermissionKeys {
		drop[string(k)] = true
	}
	if field, ok := col.Fields.GetByName("permissions").(*core.SelectField); ok {
		kept := make([]string, 0, len(field.Values))
		for _, v := range field.Values {
			if !drop[v] {
				kept = append(kept, v)
			}
		}
		field.Values = kept
		field.MaxSelect = len(kept)
		if err := app.Save(col); err != nil {
			return err
		}
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		return err
	}
	for _, row := range rows {
		current := row.GetStringSlice("permissions")
		kept := make([]string, 0, len(current))
		for _, p := range current {
			if !drop[p] {
				kept = append(kept, p)
			}
		}
		row.Set("permissions", kept)
		if err := app.Save(row); err != nil {
			return err
		}
	}
	return nil
}

func enlargeAuditDetails(app core.App) error {
	col, err := app.FindCollectionByNameOrId("audit_logs")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("details").(*core.JSONField)
	if !ok {
		return fmt.Errorf("audit_logs.details is not a JSON field")
	}
	field.MaxSize = auditDetailsMaxBytes
	return app.Save(col)
}

func restoreAuditDetails(app core.App) error {
	col, err := app.FindCollectionByNameOrId("audit_logs")
	if err != nil {
		return err
	}
	if field, ok := col.Fields.GetByName("details").(*core.JSONField); ok {
		field.MaxSize = 65536
		return app.Save(col)
	}
	return nil
}

// float64Ptr is the address-of a literal, needed because core.NumberField takes
// *float64 for its bounds and nil means "unbounded" — which is exactly what
// these ceilings exist to prevent.
func float64Ptr(v float64) *float64 {
	return &v
}

// permissionListHas is a local membership test for permission keys.
//
// Named distinctly from `containsString`, which exists in this package's test
// files: a test-only helper is not visible to production code, so reusing the
// name would collide the moment both are compiled together.
func permissionListHas(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
