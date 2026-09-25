package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

const auditLogsCollectionName = "audit_logs"

// recordAuditLog appends an audit log entry in the same transaction as the command.
// Browser writes to audit_logs are locked, so only the server can ever append to it.
func recordAuditLog(txApp core.App, actionType, performerID string, details any) error {
	col, err := txApp.FindCollectionByNameOrId(auditLogsCollectionName)
	if err != nil {
		return internalError("audit_logs collection unavailable", err)
	}

	record := core.NewRecord(col)
	record.Set("action_type", actionType)
	record.Set("performer_id", performerID)

	if details != nil {
		raw, err := json.Marshal(details)
		if err != nil {
			return internalError("failed to serialize audit details", err)
		}
		record.Set("details", types.JSONRaw(raw))
	}

	if err := txApp.Save(record); err != nil {
		return internalError("failed to save audit log", err)
	}

	return nil
}

func auditLogPayload(record *core.Record) map[string]any {
	var details any
	rawDetails := record.Get("details")
	if rawDetails != nil {
		switch d := rawDetails.(type) {
		case types.JSONRaw:
			_ = json.Unmarshal([]byte(d), &details)
		case string:
			_ = json.Unmarshal([]byte(d), &details)
		default:
			details = d
		}
	}

	return map[string]any{
		"id":           record.Id,
		"action_type":  record.GetString("action_type"),
		"performer_id": record.GetString("performer_id"),
		"details":      details,
		"created":      record.GetDateTime("created").String(),
	}
}

// adminListAuditLogsHandler returns keyset-paginated audit logs.
// Gated by PermViewAuditLog.
func adminListAuditLogsHandler(e *core.RequestEvent) error {
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), forum.DefaultPageLimit), forum.DefaultPageLimit)
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))
	performerID := strings.TrimSpace(e.Request.URL.Query().Get("performer_id"))
	actionType := strings.TrimSpace(e.Request.URL.Query().Get("action_type"))

	query := e.App.RecordQuery(auditLogsCollectionName)

	if performerID != "" {
		query = query.AndWhere(dbx.HashExp{"performer_id": performerID})
	}
	if actionType != "" {
		query = query.AndWhere(dbx.HashExp{"action_type": actionType})
	}

	// Keyset pagination cursor: created DESC, id DESC
	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			created := parts[0]
			id := parts[1]
			query = query.AndWhere(dbx.NewExp(
				"(created < {:created}) OR (created = {:created} AND id < {:id})",
				dbx.Params{
					"created": created,
					"id":      id,
				},
			))
		}
	}

	query = query.OrderBy("created DESC", "id DESC").
		Limit(int64(limit + 1))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to query audit logs", err)
	}

	var nextCursor string
	if len(records) > limit {
		lastRec := records[limit-1]
		records = records[:limit]
		nextCursor = fmt.Sprintf("%s|%s", lastRec.GetDateTime("created").String(), lastRec.Id)
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = auditLogPayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}
