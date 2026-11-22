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
	// adminBulkBodyBytes bounds a bulk users body: at most adminListMaxPerPage
	// ids plus a small payload, so one command never pulls the whole table.
	adminBulkBodyBytes = 64 * 1024
	// adminBulkMaxIDs caps one bulk command (§4.2 of the spec): a request may
	// name at most one staff page of users, so a single transaction never
	// stretches across the whole table even though the 64 KB body budget
	// would admit far more.
	adminBulkMaxIDs = 100
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

	// `search` narrows by nickname substring. The needle is BOUND, never
	// interpolated, for the same reason the mention picker binds it
	// (user_profile.go): a nickname may contain `%` and `_`, and a LIKE built
	// by concatenation is both an injection point and a way to match every
	// account. The filter applies BEFORE the page is cut, so the totalPages
	// the client paginates over counts the NARROWED set.
	if search := strings.TrimSpace(query.Get("search")); search != "" {
		where = append(where, dbx.Like("nickname", search))
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
		items = append(items, staffUserRow(record))
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

// staffUserRow builds one whitelisted staff row for the admin read model.
// Both the paginated list and the caller's own `self` row answer through it,
// so the two can never drift apart — and the whitelist here is the whole
// security property of the endpoint.
func staffUserRow(record *core.Record) map[string]any {
	return map[string]any{
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
	}
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
		oldStatus := targetUser.GetString("status")
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
			// A status write is aimed at somebody's standing, so it passes the
			// same destructive-action authority matrix as the bulk endpoints —
			// and one's own account is never a ban/unban target (the bulk
			// endpoints refuse self-action the same way; owner ruling §9.5).
			if userID == e.Auth.Id {
				return 0, nil, forbiddenError("you cannot ban or unban your own account")
			}
			if err := checkUserTargetAuthority(txApp, acc.Role, targetUser.GetString("role")); err != nil {
				return 0, nil, err
			}
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

		// The audit entry must name the target by NICKNAME (§9.7 of the
		// spec) and carry the previous values next to the new ones: a
		// status alone ("banned") cannot tell a ban from an unban without
		// the old value beside it. The nickname is read off the record
		// before the save — a delete keeps the display nickname baked, but
		// capturing first makes the entry independent of that invariant.
		_ = recordAuditLog(txApp, "admin_user_update", e.Auth.Id, map[string]any{
			"target_id":       userID,
			"target_nickname": targetUser.GetString("nickname"),
			"old_role":        oldRole,
			"old_status":      oldStatus,
			"role":            targetUser.GetString("role"),
			"status":          targetUser.GetString("status"),
		})

		// A fresh ban must vanish from "online now" immediately, and other
		// browsers must hear about it through the presence signal. An
		// unban changes nothing here: the member reappears on their next
		// click/heartbeat like any returning visitor.
		if targetUser.GetString("status") == string(auth.StatusBanned) && oldStatus != string(auth.StatusBanned) {
			evictOnlineMember(userID)
			publishPresenceSignal(e.App)
		}

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

// checkUserTargetAuthority guards the DESTRUCTIVE account actions — ban,
// unban (status writes) and soft-delete — against the target's rank.
//
// It is deliberately STRICTER than the shared staff authority matrix of
// staff_authority.go: renaming or editing an equal is reversible, but a ban
// or a delete is a hostile act, so the target must rank STRICTLY below the
// actor. An admin therefore can neither ban nor delete a peer admin, and an
// unresolvable actor rank (the deny-by-default of rankFor) refuses too.
//
// On top of the rank rule the owner ruled that the chief admin account can
// never be the TARGET of these actions at all: root cannot be banned,
// unbanned or deleted — not by an admin, not by root itself. The role
// changes hands only through the transfer procedure.
//
// Self-targeting is a separate refusal (self_action) checked by the caller.
func checkUserTargetAuthority(txApp core.App, actor auth.Role, targetRole string) error {
	if auth.Role(targetRole) == auth.RoleRoot {
		return forbiddenError("the chief admin account cannot be banned, unbanned or deleted")
	}
	if actor == auth.RoleRoot {
		return nil
	}
	if rankFor(txApp, auth.Role(targetRole)) >= rankFor(txApp, actor) {
		return forbiddenError(
			"you can only ban, unban or delete accounts ranked strictly below yours",
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

	// The delete is aimed at somebody else's standing: the actor's resolved
	// role feeds the destructive-action authority matrix below.
	acc := AccessFrom(e)

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
		// One's own account is never a delete target, and the target must
		// pass the destructive-action authority matrix — strictly below the
		// actor, with the chief admin untouchable at all (owner ruling, §9.5).
		if userID == e.Auth.Id {
			return 0, nil, forbiddenError("you cannot delete your own account")
		}
		if err := checkUserTargetAuthority(txApp, acc.Role, targetUser.GetString("role")); err != nil {
			return 0, nil, err
		}

		// §9.7 of the spec: the audit entry names the target by nickname,
		// captured before the row is taken out of circulation.
		targetNickname := targetUser.GetString("nickname")

		if deletePosts {
			if err := purgeUserContent(txApp, userID, e.Auth.Id); err != nil {
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
			"target_id":       userID,
			"target_nickname": targetNickname,
			"delete_posts":    deletePosts,
		})

		// A deleted account must vanish from "online now" immediately, and
		// every other browser must hear about it through the presence
		// signal — otherwise the name lingers for up to 15 minutes.
		evictOnlineMember(userID)
		publishPresenceSignal(e.App)

		return http.StatusOK, map[string]any{
			"deleted":      true,
			"delete_posts": deletePosts,
			"id":           userID,
			"request_id":   requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// adminBulkUpdateForm is the body of PATCH /admin/users/bulk. Role and Status
// are each optional, but at least one must be present (§4.2 of the spec); both
// may be sent in one pass (re-role a list AND ban it). ids is required,
// non-empty, deduplicated and capped at adminBulkMaxIDs.
type adminBulkUpdateForm struct {
	IDs              []string `json:"ids"`
	Role             *string  `json:"role"`
	Status           *string  `json:"status"`
	NotifyRoleChange *bool    `json:"notify_role_change"`
}

// adminBulkDeleteForm is the body of DELETE /admin/users/bulk.
type adminBulkDeleteForm struct {
	IDs         []string `json:"ids"`
	DeletePosts *bool    `json:"delete_posts"`
}

// bulkItem is one target's result inside a bulk command response.
// PreviousStatus is internal only (never serialised): the post-commit
// presence eviction needs to know whether a ban actually changed anything.
type bulkItem struct {
	ID             string `json:"id"`
	OK             bool   `json:"ok"`
	Error          string `json:"error,omitempty"`
	Code           string `json:"code,omitempty"`
	Role           string `json:"role,omitempty"`
	Status         string `json:"status,omitempty"`
	PreviousStatus string `json:"-"`
}

// dedupeIDs returns ids in first-seen order without duplicates.
//
// A repeated id would otherwise be saved twice, audited twice and counted
// twice in processed/succeeded — and in the delete pass the second encounter
// of the same id would read back as already_deleted and pollute the items
// list with a phantom error.
func dedupeIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// bulkIDsFromForm validates the id list both bulk handlers share: it
// deduplicates, refuses an array that is empty (or empty after deduplication)
// and enforces the adminBulkMaxIDs ceiling from §4.2 of the spec.
func bulkIDsFromForm(ids []string) ([]string, error) {
	deduped := dedupeIDs(ids)
	if len(deduped) == 0 {
		return nil, validationError("expected a non-empty ids array")
	}
	if len(deduped) > adminBulkMaxIDs {
		return nil, validationError("too many ids: at most 100 per request")
	}
	return deduped, nil
}

// adminBulkUpdateUsersHandler performs one bulk operation (role change or
// ban/unban) over a list of users in a single transaction, target by target.
// Every target is checked independently: a refused target is reported in
// `items` with a machine-readable code and does not abort the rest. HTTP is
// 200 even on partial failure; only a bad body (400) or a missing actor-level
// right (403) fails the whole request. Gate: PermAdminAccess (§2 of spec).
func adminBulkUpdateUsersHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	acc := AccessFrom(e)

	raw, err := readBodyLimited(e, adminBulkBodyBytes)
	if err != nil {
		return err
	}
	var form adminBulkUpdateForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	form.IDs, err = bulkIDsFromForm(form.IDs)
	if err != nil {
		return err
	}

	hasRole := form.Role != nil
	hasStatus := form.Status != nil
	if !hasRole && !hasStatus {
		return validationError("expected role or status in the body")
	}
	if hasRole {
		if !auth.Has(acc.Permissions, auth.PermChangeRoles) {
			return router.NewForbiddenError("you are not allowed to change roles", nil)
		}
		if err := requireKnownRole(e.App, strings.TrimSpace(*form.Role)); err != nil {
			return err
		}
	}
	if hasStatus {
		if !auth.Has(acc.Permissions, auth.PermBanUsers) {
			return router.NewForbiddenError("you are not allowed to ban or unban users", nil)
		}
		switch strings.TrimSpace(*form.Status) {
		case string(auth.StatusBanned), string(auth.StatusActive):
		default:
			return validationError("invalid status value")
		}
	}

	role := ""
	if form.Role != nil {
		role = strings.TrimSpace(*form.Role)
	}
	status := ""
	if form.Status != nil {
		status = strings.TrimSpace(*form.Status)
	}
	notifyRoleChange := true
	if form.NotifyRoleChange != nil {
		notifyRoleChange = *form.NotifyRoleChange
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		var items []bulkItem
		// targets feeds THE audit event of this command (§9.7 of the spec):
		// a bulk operation writes exactly ONE audit row, and it must name
		// every processed account by nickname — including the refused ones —
		// so the log reader sees the FULL list the admin attempted, with the
		// values each account had before the command touched it.
		var targets []map[string]any
		succeeded := 0

		for _, id := range form.IDs {
			item := bulkItem{ID: id}

			targetUser, err := txApp.FindRecordById(usersCollectionName, id)
			if err != nil || targetUser == nil {
				item.Error = "user not found"
				item.Code = "not_found"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "ok": false, "code": "not_found"})
				continue
			}
			// The nickname and the current role/status are captured at load:
			// every later branch (refusal included) can name the account and
			// its standing in the audit summary, and the success path reads
			// them after saves that never touch the nickname.
			nickname := targetUser.GetString("nickname")
			oldRole := targetUser.GetString("role")
			oldStatus := targetUser.GetString("status")
			if isUserDeleted(targetUser) {
				item.Error = "user is already deleted"
				item.Code = "already_deleted"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "already_deleted", "old_role": oldRole, "old_status": oldStatus})
				continue
			}
			// An actor cannot act on their own account through bulk either.
			if id == claim.Actor {
				item.Error = "cannot act on your own account"
				item.Code = "self_action"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "self_action", "old_role": oldRole, "old_status": oldStatus})
				continue
			}

			// A status write is aimed at the target's standing: the target
			// must pass the destructive-action authority matrix — strictly
			// below the actor, and the chief admin is untouchable at all
			// (owner ruling, §9.5 of the spec).
			if err := checkUserTargetAuthority(txApp, acc.Role, targetUser.GetString("role")); err != nil {
				item.Error = err.Error()
				item.Code = "forbidden"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "forbidden", "old_role": oldRole, "old_status": oldStatus})
				continue
			}

			roleChanged := false
			if role != "" {
				if err := checkRoleChange(txApp, acc.Role, oldRole, role); err != nil {
					item.Error = err.Error()
					item.Code = "forbidden"
					items = append(items, item)
					targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "forbidden", "old_role": oldRole, "old_status": oldStatus})
					continue
				}
				targetUser.Set("role", role)
				targetUser.Set("custom_role_id", customRoleIDFor(txApp, role))
				roleChanged = role != oldRole
			}
			if status != "" {
				targetUser.Set("status", status)
			}

			// PocketBase validates the ENTIRE record on Save — repair stale
			// required fields so a role change is never blocked by old data.
			if strings.TrimSpace(targetUser.GetString("status")) == "" {
				targetUser.Set("status", string(auth.StatusActive))
			}
			if len(targetUser.GetString("tokenKey")) < 30 {
				targetUser.RefreshTokenKey()
			}
			if err := txApp.Save(targetUser); err != nil {
				return 0, nil, internalError("failed to update user", err)
			}

			if roleChanged && notifyRoleChange {
				newRole := targetUser.GetString("role")
				if _, err := createNotification(txApp, id, e.Auth.Id, "role_change",
					"Your role has been changed",
					map[string]any{
						"target_id":     id,
						"old_role":      oldRole,
						"old_role_name": roleDisplayName(txApp, oldRole),
						"new_role":      newRole,
						"new_role_name": roleDisplayName(txApp, newRole),
						"changed_by":    e.Auth.Id,
					},
				); err != nil {
					txApp.Logger().Warn("bulk role change notification failed",
						"error", err, "targetId", id, "actorId", e.Auth.Id)
				}
			}

			item.OK = true
			item.Role = targetUser.GetString("role")
			item.Status = targetUser.GetString("status")
			item.PreviousStatus = oldStatus
			succeeded++
			items = append(items, item)
			targets = append(targets, map[string]any{
				"id":         id,
				"nickname":   nickname,
				"ok":         true,
				"old_role":   oldRole,
				"old_status": oldStatus,
			})
		}

		// Ban/unban moves accounts in and out of the online composition:
		// freshly banned members must vanish from "online now" immediately,
		// and other browsers must hear about it through the presence
		// signal. Evicted per succeeded target whose status actually
		// changed; refused targets were never touched.
		if hasStatus && succeeded > 0 {
			for _, item := range items {
				if item.OK && item.PreviousStatus != status {
					evictOnlineMember(item.ID)
				}
			}
			publishPresenceSignal(e.App)
		}

		// THE audit event of this bulk command (§9.7 of the spec): one row
		// carries the admin's action AND the full nickname list of the
		// targets, with each account's previous role/status beside it. There
		// is deliberately NO per-target audit row here — the single-target
		// PATCH writes those, and a bulk pass would only duplicate this
		// summary into N fragments beside it. The row is written even when
		// every target was refused: an all-failure attempt is exactly what
		// an auditor looks for.
		_ = recordAuditLog(txApp, "admin_users_bulk_update", e.Auth.Id, map[string]any{
			"role":               role,
			"status":             status,
			"notify_role_change": notifyRoleChange,
			"processed":          len(form.IDs),
			"succeeded":          succeeded,
			"failed":             len(form.IDs) - succeeded,
			"targets":            targets,
		})

		return http.StatusOK, map[string]any{
			"processed":  len(form.IDs),
			"succeeded":  succeeded,
			"failed":     len(form.IDs) - succeeded,
			"items":      items,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// adminBulkDeleteUsersHandler soft-deletes a list of users in a single
// transaction, target by target, with the same per-target error contract as
// adminBulkUpdateUsersHandler.
func adminBulkDeleteUsersHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	acc := AccessFrom(e)

	raw, err := readBodyLimited(e, adminBulkBodyBytes)
	if err != nil {
		return err
	}
	var form adminBulkDeleteForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	form.IDs, err = bulkIDsFromForm(form.IDs)
	if err != nil {
		return err
	}
	if !auth.Has(acc.Permissions, auth.PermDeleteUsers) {
		return router.NewForbiddenError("you are not allowed to delete users", nil)
	}

	deletePosts := false
	if form.DeletePosts != nil {
		deletePosts = *form.DeletePosts
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		var items []bulkItem
		// targets feeds THE audit event of this command (§9.7 of the spec):
		// a bulk delete writes exactly ONE audit row, and it must name every
		// processed account by nickname — including the refused ones — so
		// the log reader sees the FULL list the admin attempted.
		var targets []map[string]any
		succeeded := 0

		for _, id := range form.IDs {
			item := bulkItem{ID: id}

			targetUser, err := txApp.FindRecordById(usersCollectionName, id)
			if err != nil || targetUser == nil {
				item.Error = "user not found"
				item.Code = "not_found"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "ok": false, "code": "not_found"})
				continue
			}
			// The nickname is captured at load: every later branch (refusal
			// included) can name the account in the audit summary, and the
			// success path reads it before the row is taken out of
			// circulation.
			nickname := targetUser.GetString("nickname")
			if isUserDeleted(targetUser) {
				item.Error = "user is already deleted"
				item.Code = "already_deleted"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "already_deleted"})
				continue
			}
			// An actor cannot delete their own account through bulk either.
			if id == claim.Actor {
				item.Error = "cannot act on your own account"
				item.Code = "self_action"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "self_action"})
				continue
			}

			// A delete is the most destructive account action: the target
			// must pass the destructive-action authority matrix — strictly
			// below the actor, and the chief admin is untouchable at all
			// (owner ruling, §9.5 of the spec).
			if err := checkUserTargetAuthority(txApp, acc.Role, targetUser.GetString("role")); err != nil {
				item.Error = err.Error()
				item.Code = "forbidden"
				items = append(items, item)
				targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": false, "code": "forbidden"})
				continue
			}

			if deletePosts {
				if err := purgeUserContent(txApp, id, e.Auth.Id); err != nil {
					return 0, nil, err
				}
			}

			targetUser.Set(userIsDeletedField, true)
			targetUser.Set("status", string(auth.StatusDeleted))
			targetUser.Set("nickname_normalized", "")
			targetUser.Set("email", "")
			targetUser.RefreshTokenKey()
			if err := txApp.Save(targetUser); err != nil {
				return 0, nil, internalError("failed to delete user", err)
			}

			if err := markUserDMErasesForever(txApp, id); err != nil {
				return 0, nil, err
			}

			item.OK = true
			succeeded++
			items = append(items, item)
			targets = append(targets, map[string]any{"id": id, "nickname": nickname, "ok": true})
		}

		// THE audit event of this bulk command (§9.7 of the spec): one row
		// carries the admin's action AND the full nickname list of the
		// targets. There is deliberately NO per-target audit row here — the
		// single-target DELETE writes those, and a bulk pass would only
		// duplicate this summary into N fragments beside it. The row is
		// written even when every target was refused: an all-failure attempt
		// is exactly what an auditor looks for.
		_ = recordAuditLog(txApp, "admin_users_bulk_delete", e.Auth.Id, map[string]any{
			"delete_posts": deletePosts,
			"processed":    len(form.IDs),
			"succeeded":    succeeded,
			"failed":       len(form.IDs) - succeeded,
			"targets":      targets,
		})

		// Deleted accounts must vanish from "online now" immediately, and
		// every other browser must hear about it through the presence
		// signal. Evicted per succeeded target; refused targets were never
		// touched, so their presence (if any) correctly survives.
		for _, item := range items {
			if item.OK {
				evictOnlineMember(item.ID)
			}
		}
		if succeeded > 0 {
			publishPresenceSignal(e.App)
		}

		return http.StatusOK, map[string]any{
			"processed":  len(form.IDs),
			"succeeded":  succeeded,
			"failed":     len(form.IDs) - succeeded,
			"items":      items,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// adminUsersContentCountsHandler answers POST /admin/users/content-counts:
// how much authored content the "delete all their content" option would
// destroy for each named account — owned topics and owned posts, the same
// rows purgeUserContent removes. Read-only (no runCommand, no idempotency
// key), but gated like every other admin users route: the counts leak
// authorship volume to whoever could reach them.
func adminUsersContentCountsHandler(e *core.RequestEvent) error {
	raw, err := readBodyLimited(e, adminBulkBodyBytes)
	if err != nil {
		return err
	}
	var form adminBulkUpdateForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	form.IDs, err = bulkIDsFromForm(form.IDs)
	if err != nil {
		return err
	}

	items := make([]map[string]any, 0, len(form.IDs))
	for _, id := range form.IDs {
		topics, err := e.App.CountRecords(topicsCollectionName, dbx.HashExp{"author_id": id})
		if err != nil {
			return internalError("failed to count topics", err)
		}
		posts, err := e.App.CountRecords(postsCollectionName, dbx.HashExp{"author_id": id})
		if err != nil {
			return internalError("failed to count posts", err)
		}
		items = append(items, map[string]any{
			"id":     id,
			"topics": topics,
			"posts":  posts,
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
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
