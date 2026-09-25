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

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Sprint 2 command (plan §4 Sprint 2 task 5): GET /api/aerun/admin/users —
// the staff-only admin read model. It is gated by the admin_access
// permission (root and admin roles only: moderators deliberately do not have
// it), and email is included because staff account management needs it —
// this is not a public response, so the Sprint 2 DoD ("email never appears
// in a public response") is not affected.
//
// tokenKey, password and legacy_firebase_uid are never part of the payload:
// the map is assembled field by field so private columns cannot leak.
const adminListMaxPerPage = 100

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
			"email":      record.Email(),
			"nickname":   record.GetString("nickname"),
			"role":       record.GetString("role"),
			"status":     record.GetString("status"),
			"verified":   record.GetBool("verified"),
			"avatar_url": record.GetString("avatar_url"),
			"created":    record.GetDateTime("created"),
			"updated":    record.GetDateTime("updated"),
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

// parseAdminPagination normalises the page/perPage query parameters.
// Invalid or non-positive values fall back to the defaults; perPage is
// capped so one caller cannot pull the whole table in a single response.
func parseAdminPagination(pageRaw, perPageRaw string) (int, int) {
	page, err := strconv.Atoi(pageRaw)
	if err != nil || page < 1 {
		page = 1
	}
	perPage, err := strconv.Atoi(perPageRaw)
	if err != nil || perPage < 1 {
		perPage = 30
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
			if !slices.Contains(auth.AllRoleValues(), role) {
				return 0, nil, validationError("invalid role value")
			}
			targetUser.Set("role", role)
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
