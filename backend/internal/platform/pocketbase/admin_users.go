package pocketbase

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Sprint 2 command (plan §4 Sprint 2 task 5): GET /api/aerun/admin/users —
// the staff-only admin read model. It is gated by the admin_access
// permission (root and admin roles only: moderators deliberately do not have
// it).
//
// The response is assembled field by field, never by serialising the record,
// and that whitelist is the whole security property of this endpoint:
//
//   - email is NOT in it. The address is an authentication credential, not
//     profile data: it is the password-reset target and the OAuth2 subject,
//     and it travels to the browser of every admin who opens the members
//     table. Nothing in the product needs it — the admin UI shows the
//     nickname, and a staff member who must reach an address uses the
//     PocketBase console, which is already a superuser surface. It is
//     deliberately absent rather than masked, so a client cannot mistake a
//     redacted value for a real one.
//   - tokenKey, password and legacy_firebase_uid can never leak for the same
//     reason: they are simply not named.
//
// The counters (posts_count, topics_count, reputation) are denormalised
// columns maintained by the command layer and rebuildable by
// RecomputeUserCounters; they are safe to expose because they are already
// public on the profile (1766000000 publishes every non-hidden field of an
// active account).
const (
	// adminListDefaultPerPage is the page size when the caller does not ask
	// for one.
	adminListDefaultPerPage = 30
	// adminListMaxPerPage caps it. 30 is both the default and the ceiling:
	// this endpoint feeds a table that the client paginates, and a larger
	// page would let one caller pull the whole table into one response.
	adminListMaxPerPage = 30
	// adminDeleteBodyBytes bounds the admin user delete body. The payload is
	// one flag; the limit is generous rather than tight so a client sending
	// extra fields is not rejected for the wrong reason.
	adminDeleteBodyBytes = 8 * 1024
)

func adminListUsersHandler(e *core.RequestEvent) error {
	query := e.Request.URL.Query()
	page, perPage := parseAdminPagination(query.Get("page"), query.Get("perPage"))

	var where []dbx.Expression
	status := strings.TrimSpace(query.Get("status"))
	if status != "" {
		// AllStatusValues is the STORED vocabulary (it carries the "deleted"
		// soft-delete marker), so staff can FIND deleted rows here without the
		// value ever becoming assignable — assignment validates separately
		// through Status.IsValid().
		if !slices.Contains(auth.AllStatusValues(), status) {
			return e.BadRequestError("unknown status filter", nil)
		}
		where = append(where, dbx.HashExp{"status": status})
	} else {
		// A DELETED account is not in the members table.
		//
		// The owner's ruling (2026-10-19): the staff table lists the accounts
		// that can still act. A soft-deleted account cannot act at all — it
		// holds no permissions, its session is dead, and its content is either
		// kept as history or purged with it — so a row for it in the table is
		// a row the staff cannot do anything with, next to rows they can.
		//
		// The account is still reachable, and still auditable: the
		// `?status=deleted` filter below is the deliberate way to ask for
		// exactly those rows (a check that nothing was left behind, a look at
		// what a given member's history still holds). It is a targeted query,
		// not the list the table draws.
		where = append(where, notDeletedUsersExpr())
	}

	total, err := e.App.CountRecords(usersCollectionName, where...)
	if err != nil {
		return router.NewInternalServerError("user count failed", err)
	}

	// RecordQuery with bound expressions: the status value never enters the
	// SQL string, so the filter cannot become an injection point.
	listQuery := e.App.RecordQuery(usersCollectionName)
	for _, expr := range where {
		listQuery.AndWhere(expr)
	}
	listQuery.OrderBy("created DESC", "id ASC").
		Limit(int64(perPage)).
		Offset(int64((page - 1) * perPage))
	var records []*core.Record
	if err := listQuery.All(&records); err != nil {
		return router.NewInternalServerError("user list failed", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		items = append(items, map[string]any{
			"id":       record.Id,
			"nickname": record.GetString("nickname"),
			// The role stays the STORED role here, on purpose: this is the
			// staff view, and the original role of a deleted account is
			// history the staff may need (it is what the account held while
			// it could act). The public profile is the surface that paints
			// "Deleted" instead (see profileRole).
			//
			// What the staff view must NOT do is present a deleted account
			// as living: the `deleted` flag and `status` below carry that
			// verdict, and the admin table renders a "Deleted" badge from
			// them.
			"role":       record.GetString("role"),
			"status":     record.GetString("status"),
			"deleted":    isUserDeleted(record),
			"verified":   record.GetBool("verified"),
			"avatar_url": record.GetString("avatar_url"),
			// The one-line status MembersPage renders under the nickname. It was
			// missing here, so the admin table received `undefined` for it from
			// this route while the public read supplied a real value — the same
			// row rendering differently depending on which endpoint answered,
			// which is the signature of a mapper gap rather than a data gap.
			"status_line": record.GetString("status_line"),
			"created":     record.GetDateTime("created"),
			"updated":     record.GetDateTime("updated"),
			// The durable last-visit clock (migration 1767300000), which is
			// what the members table renders once a member is no longer in the
			// live presence map.
			//
			// The `created` fallback is the never-empty guarantee, enforced at
			// the boundary where the value is actually consumed rather than
			// trusted to every writer. Registration is provably real activity,
			// so falling back to it can only understate how recently someone
			// was here — it can never invent a visit. Emitting a zero time
			// instead would push the problem onto every client and this column
			// is read by exactly one of them.
			"last_seen": lastSeenOrCreated(record),
			// Denormalised counters. Emitted under the legacy names the
			// frontend already reads (MembersPage sorts on `post_count` and
			// `reputation`), so no consumer has to learn a third vocabulary.
			"post_count":   record.GetInt("posts_count"),
			"topics_count": record.GetInt("topics_count"),
			"reputation":   record.GetInt("reputation"),
		})
	}

	totalItems := int(total)
	totalPages := (totalItems + perPage - 1) / perPage
	return e.JSON(http.StatusOK, map[string]any{
		"page":       page,
		"perPage":    perPage,
		"totalItems": totalItems,
		"totalPages": totalPages,
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

// lastSeenOrCreated returns the account's last-visit timestamp, falling back to
// its registration date when the column is empty.
//
// The two writers of users.last_seen (the heartbeat and account creation) both
// fill it, and migration 1767300000 backfills every pre-existing row, so the
// empty case is already meant to be unreachable. It stays reachable in exactly
// one realistic way: a row restored from a backup taken before the migration
// and never re-imported. Rather than let that surface as a blank column in the
// members table, the read answers with `created` — which is a real, provable
// activity time for the account, so the result can only ever be conservative.
//
// It also guards the ordering, so a caller cannot get a last-seen that predates
// the account's own registration. That would be nonsense data rather than
// missing data, and it is exactly the sort of thing that survives into a release
// because no row happens to hit it.
func lastSeenOrCreated(record *core.Record) types.DateTime {
	created := record.GetDateTime("created")
	lastSeen := record.GetDateTime(userLastSeenField)
	if lastSeen.IsZero() {
		return created
	}
	if !created.IsZero() && lastSeen.Time().Before(created.Time()) {
		return created
	}
	return lastSeen
}

// parseAdminPagination normalises the page/perPage query parameters.
// Invalid or non-positive values fall back to the defaults; perPage is
// capped at adminListMaxPerPage so no caller can pull the whole table in a
// single response, however it spells the request.
func parseAdminPagination(pageRaw, perPageRaw string) (int, int) {
	page, err := strconv.Atoi(pageRaw)
	if err != nil || page < 1 {
		page = 1
	}
	perPage, err := strconv.Atoi(perPageRaw)
	if err != nil || perPage < 1 {
		perPage = adminListDefaultPerPage
	}
	if perPage > adminListMaxPerPage {
		perPage = adminListMaxPerPage
	}
	return page, perPage
}

type adminUpdateUserForm struct {
	Role   *string `json:"role"`
	Status *string `json:"status"`
	// NotifyRoleChange asks the server to tell the target member that their
	// role was changed. A missing field means true (see the handler): the
	// AdminPage checkbox is checked by default, and callers that do not send
	// the field at all still produce the notification.
	NotifyRoleChange *bool `json:"notify_role_change"`
}

func adminUpdateUserHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	// The caller's resolved role, needed by checkRoleChange: which roles this
	// account may hand out is a rank question about WHO IS ASKING.
	acc := AccessFrom(e)

	userID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, 32*1024)
	if err != nil {
		return err
	}

	var form adminUpdateUserForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		targetUser, err := txApp.FindRecordById(usersCollectionName, userID)
		if err != nil || targetUser == nil {
			return 0, nil, notFoundError("user not found")
		}
		if isUserDeleted(targetUser) {
			// A soft-deleted row is a finished state: role/status forms must
			// not rewrite it back into circulation without the coordinated
			// undelete writes that do not exist.
			return 0, nil, conflictError("user is already deleted")
		}

		oldRole := targetUser.GetString("role")
		roleChanged := false

		if form.Role != nil {
			role := strings.TrimSpace(*form.Role)
			// The role column holds legacy custom role ids verbatim
			// (1766500000), so the compiled value list is no longer the
			// authority on what may be assigned. The roles collection is: an
			// id with no row there would resolve to deny-by-default at
			// request time (access.go falls back to the compiled matrix, which
			// knows no such role), so it is rejected here instead of silently
			// producing an account that can do nothing.
			if err := requireKnownRole(txApp, role); err != nil {
				return 0, nil, err
			}
			// Rank and appointment rules, in one place. `role` is validated
			// above, so anything reaching here is a role id that really exists.
			if err := checkRoleChange(txApp, acc.Role, targetUser.GetString("role"), role); err != nil {
				return 0, nil, err
			}
			targetUser.Set("role", role)
			targetUser.Set("custom_role_id", customRoleIDFor(txApp, role))
			if role != oldRole {
				roleChanged = true
			}
		}

		if form.Status != nil {
			status := strings.TrimSpace(*form.Status)
			// Status, not AllStatusValues: the stored vocabulary carries the
			// "deleted" soft-delete marker, but ASSIGNING it here would create
			// a half-deleted row (status without is_deleted and without the
			// released nickname key). IsValid reads the assignable set only.
			if !auth.Status(status).IsValid() {
				return 0, nil, validationError("invalid status value")
			}
			targetUser.Set("status", status)
		}

		// PocketBase validates the ENTIRE record on Save, not just the changed
		// fields. A row created before the `status` column existed, or one whose
		// `tokenKey` was never rotated, would fail validation here with a 500
		// even though only the role is being changed. Repair the required fields
		// before saving so the role update is never blocked by stale data.
		if strings.TrimSpace(targetUser.GetString("status")) == "" {
			targetUser.Set("status", string(auth.StatusActive))
		}
		if len(targetUser.GetString("tokenKey")) < 30 {
			targetUser.RefreshTokenKey()
		}
		
		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to update user", err)
		}

		// Tell the member their role changed, unless the admin unchecked the
		// "notify user" box. The box is checked by default and a caller that
		// sends no flag at all gets the notification too (missing == true).
		// A failed notification must not roll back the role change itself:
		// the write is done and audited, so the best-effort notice is logged
		// and the command still succeeds — the same reasoning that keeps a
		// failed post notification from costing the author their reply.
		if roleChanged && (form.NotifyRoleChange == nil || *form.NotifyRoleChange) {
			newRole := targetUser.GetString("role")
			if _, err := createNotification(txApp, userID, e.Auth.Id, "role_change",
				"Your role has been changed",
				map[string]any{
					"target_id":     userID,
					"old_role":      oldRole,
					"old_role_name": roleDisplayName(txApp, oldRole),
					"new_role":      newRole,
					"new_role_name": roleDisplayName(txApp, newRole),
					"changed_by":    e.Auth.Id,
				},
			); err != nil {
				txApp.Logger().Warn("role change notification failed; the role change itself succeeded",
					"error", err, "targetId", userID, "actorId", e.Auth.Id, "oldRole", oldRole, "newRole", newRole)
			}
		}

		_ = recordAuditLog(txApp, "admin_user_update", e.Auth.Id, map[string]any{
			"target_id": userID,
			"role":      targetUser.GetString("role"),
			"status":    targetUser.GetString("status"),
		})

		return http.StatusOK, map[string]any{
			"id":         targetUser.Id,
			"role":       targetUser.GetString("role"),
			"status":     targetUser.GetString("status"),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// roleDisplayName resolves a role id to the human-readable name from the
// roles registry (the same `name` roleBadgePayload publishes for badges).
// It falls back to the id itself so the notice never renders an empty slot
// when the registry row is missing.
func roleDisplayName(app core.App, roleID string) string {
	if roleID == "" {
		return ""
	}
	if rec, err := app.FindFirstRecordByFilter(
		rolesCollectionName,
		"role_id = {:rid}",
		dbx.Params{"rid": roleID},
	); err == nil && rec != nil {
		if name := rec.GetString("name"); name != "" {
			return name
		}
	}
	return roleID
}

// checkRoleChange is the authority rule for changing an account's role.
//
//	admin → may act on STRICTLY LOWER accounts only, and may not appoint an
//	        admin. Demoting an admin is therefore impossible for an admin,
//	        because an admin target is not strictly lower.
//	root  → may act on anyone, but may still not WRITE the `root` role.
//
// The last clause is the owner's ruling and it is the reason this function
// exists rather than a simple rank comparison: root is TRANSFERRED, never
// granted. She was asked about appointing additional root admins, decided that
// was a bad idea, and asked for a dedicated one-way transfer instead. So a
// plain role write can create and destroy every other role, and `root` can
// only ever be entered through that transfer command — a second root created
// here would be an escalation with no ceremony and no record of the decision.
//
// Every other case is a rank question, and the rank comes from the `roles`
// row, which is the runtime authority (see rankFor).
func checkRoleChange(txApp core.App, actor auth.Role, currentRole, newRole string) error {
	newAuthRole := auth.Role(newRole)

	// Nobody writes `root` through this path. Transfer is the only way in.
	if newAuthRole == auth.RoleRoot {
		return forbiddenError(
			"the root admin role cannot be assigned directly; it is transferred through a separate procedure",
		)
	}

	if actor == auth.RoleRoot {
		return nil
	}

	if actor != auth.RoleAdmin {
		return forbiddenError("only an administrator or the chief admin may change roles")
	}

	// An admin may not appoint another admin. `newRole` was already checked
	// against the role registry, so anything reaching here that is an admin is
	// that exact role.
	if newAuthRole == auth.RoleAdmin {
		return forbiddenError("only the chief admin may appoint an administrator")
	}

	// And only on a strictly lower account, which is also what makes demoting
	// an admin unreachable.
	if rankFor(txApp, auth.Role(currentRole)) >= rankFor(txApp, actor) {
		return forbiddenError(
			"you can only change the role of an account ranked strictly below yours",
		)
	}
	return nil
}

// requireKnownRole rejects a role id that has no row in the roles collection.
//
// A role is valid if the roles collection knows it — whether a compiled system
// role or an imported custom role. The compiled list alone is not enough since
// 1766500000: it would refuse every legacy custom role id and make the four
// imported roles unassignable, while still accepting the ids the matrix knows.
//
// An empty id is rejected too: users.role is required, and an empty value would
// make every permission check fall through to deny-by-default.
func requireKnownRole(app core.App, role string) error {
	if role == "" {
		return validationError("invalid role value")
	}
	collection, err := app.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return internalError("roles collection unavailable", err)
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": role})
	if err != nil {
		return internalError("role lookup failed", err)
	}
	if len(records) != 1 {
		// Zero: unknown role. More than one: a duplicated role_id would make
		// the permission lookup in access.go ambiguous, so it is refused too.
		return validationError("invalid role value")
	}
	return nil
}

// customRoleIDFor returns the id of the system role a custom role derives from,
// or "" for a system role. Keeping it in its own column means "is this account
// staff?" stays answerable from the compiled matrix even though the role column
// now holds opaque legacy ids (see 1766500000).
func customRoleIDFor(app core.App, role string) string {
	collection, err := app.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return ""
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": role})
	if err != nil || len(records) != 1 {
		return ""
	}
	return records[0].GetString("base_role_id")
}

// adminDeleteUserHandler is registered after adminUpdateUserHandler in
// registerRoutes.
//
// SOFT DELETE. The users row is never removed: it is taken out of
// circulation in one transaction so the profile page and the author's posts
// keep rendering with the baked nickname/avatar/counters instead of 404ing.
// See markdowns/DONE_DELETED_USER_PROFILE_AND_POSTS_2026-10-18.md.
//
// The three coordinated writes:
//   - is_deleted = true (the explicit flag from 1770000009);
//   - status = "deleted" (auth.StatusDeleted — outside AllStatuses, so the
//     permission narrowing denies everything and the row can never act;
//     users.status is a TextField since 1766500000, so no schema change is
//     needed to hold the value);
//   - nickname_normalized = "" (the partial UNIQUE index only constrains
//     non-empty keys, so a fresh registration may reuse the nickname; the
//     display nickname stays baked for rendering).
//
// delete_posts (body {"delete_posts": true} or ?delete_posts=1, default
// false) additionally hard-deletes the member's content in the SAME
// transaction: every owned topic (with its posts, votes and subscriptions,
// through the same purgeTopicResidue/deleteTopicPosts path the topic delete
// uses) plus every remaining owned post, plus the profile-level reputation
// votes in both directions. Without the flag the posts stay and their author
// decorates as Deleted.
func adminDeleteUserHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	userID := e.Request.PathValue("id")
	deletePosts := adminDeletePostsRequested(e)
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		targetUser, err := txApp.FindRecordById(usersCollectionName, userID)
		if err != nil || targetUser == nil {
			return 0, nil, notFoundError("user not found")
		}
		if isUserDeleted(targetUser) {
			return 0, nil, conflictError("user is already deleted")
		}

		if deletePosts {
			if err := purgeUserContent(txApp, userID); err != nil {
				return 0, nil, err
			}
		}

		targetUser.Set(userIsDeletedField, true)
		targetUser.Set("status", string(auth.StatusDeleted))
		// nickname_normalized is cleared through the RECORD, not through a raw
		// UPDATE.
		//
		// The empty key is what releases the nickname for reuse: the partial
		// UNIQUE index (`nickname_normalized != ''`) only constrains non-empty
		// keys. It used to need a raw UPDATE because the column was REQUIRED
		// and a record save with an empty value is refused by validation
		// ("cannot be blank") — but that left the row UNSAVABLE, so every
		// later counter move on the deleted account (adjustUserReputation,
		// adjustUserPostCount, adjustUserTopicCount) died with a 500.
		// Migration 1770000010 makes the column optional, which is what the
		// partial index always assumed; the row stays writable, and the
		// release commits in the same transaction as the flag above.
		targetUser.Set("nickname_normalized", "")
		// The email address is released for reuse as well: the users collection's
		// partial UNIQUE index on email (`WHERE email != ''`) only constrains
		// non-empty values, so an empty email frees the address for a fresh
		// registration. Migration 1770000014 makes the column optional so the
		// row stays writable after this write, and the release commits in the
		// same transaction as the flag above. Storing deleted accounts' emails
		// is not our practice.
		targetUser.Set("email", "")
		// The session dies with the account. A PocketBase auth token is signed
		// with `tokenKey + AuthToken.Secret` and verified against the CURRENT
		// tokenKey on every request, so rotating the key invalidates every
		// token this account holds — the one in the browser and any refresh
		// token it could mint. Without this the account keeps a live session
		// until the token expires on its own; the auth hook only refuses a NEW
		// sign-in.
		//
		// This is the same mechanism PocketBase itself uses when a password is
		// reset (core/record_model_auth.go), and it needs no extra column.
		targetUser.RefreshTokenKey()
		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to delete user", err)
		}

		// A DELETED ACCOUNT CAN NEVER READ ANOTHER MESSAGE of its direct
		// messages, so it must not hold the collector's watermark back
		// (owner ruling 2026-10-19).
		//
		// The erase point becomes INT_MAX — "this participant will never read
		// anything" — so the watermark of every conversation this account was
		// in is decided by the members who are still around. A survivor who
		// then erases their own side of such a chat has, by that alone, taken
		// the watermark to their own point, and the collector removes the
		// rows.
		if err := markUserDMErasesForever(txApp, userID); err != nil {
			return 0, nil, err
		}

		_ = recordAuditLog(txApp, "admin_user_delete", e.Auth.Id, map[string]any{
			"target_id":    userID,
			"delete_posts": deletePosts,
		})

		return http.StatusOK, map[string]any{
			"deleted":      true,
			"delete_posts": deletePosts,
			"id":           userID,
			"request_id":   requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// adminDeletePostsRequested reads the delete_posts flag for the admin user
// delete: a JSON body {"delete_posts": true} wins, otherwise the
// ?delete_posts=1 query parameter. Anything else — absent body, malformed
// JSON, any other value — means "account only".
func adminDeletePostsRequested(e *core.RequestEvent) bool {
	if raw, err := readBodyLimited(e, adminDeleteBodyBytes); err == nil && len(raw) > 0 {
		var form struct {
			DeletePosts *bool `json:"delete_posts"`
		}
		if err := json.Unmarshal(raw, &form); err == nil && form.DeletePosts != nil {
			return *form.DeletePosts
		}
	}
	query := strings.TrimSpace(e.Request.URL.Query().Get("delete_posts"))
	return query == "1" || strings.EqualFold(query, "true")
}
