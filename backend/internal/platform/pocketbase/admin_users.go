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
)

func adminListUsersHandler(e *core.RequestEvent) error {
	query := e.Request.URL.Query()
	page, perPage := parseAdminPagination(query.Get("page"), query.Get("perPage"))

	var where []dbx.Expression
	status := strings.TrimSpace(query.Get("status"))
	if status != "" {
		if !slices.Contains(auth.AllStatusValues(), status) {
			return e.BadRequestError("unknown status filter", nil)
		}
		where = append(where, dbx.HashExp{"status": status})
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
			"id":         record.Id,
			"nickname":   record.GetString("nickname"),
			"role":       record.GetString("role"),
			"status":     record.GetString("status"),
			"verified":   record.GetBool("verified"),
			"avatar_url": record.GetString("avatar_url"),
			"created":    record.GetDateTime("created"),
			"updated":    record.GetDateTime("updated"),
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
		}

		if form.Status != nil {
			status := strings.TrimSpace(*form.Status)
			if !slices.Contains(auth.AllStatusValues(), status) {
				return 0, nil, validationError("invalid status value")
			}
			targetUser.Set("status", status)
		}

		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to update user", err)
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
func adminDeleteUserHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	userID := e.Request.PathValue("id")
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		targetUser, err := txApp.FindRecordById(usersCollectionName, userID)
		if err != nil || targetUser == nil {
			return 0, nil, notFoundError("user not found")
		}

		if err := txApp.Delete(targetUser); err != nil {
			return 0, nil, internalError("failed to delete user", err)
		}

		_ = recordAuditLog(txApp, "admin_user_delete", e.Auth.Id, map[string]any{
			"target_id": userID,
		})

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"id":         userID,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}
