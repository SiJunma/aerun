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

func auditLogPayload(record *core.Record, performerNicknames map[string]string) map[string]any {
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
		// The staff table used to name performers by scanning its own
		// (unpaginated) user list client-side; the list is paged now, so the
		// nickname travels with the row. Only the NICKNAME — the email stays
		// a credential and never enters an audit payload.
		"performer_nickname": performerNicknames[record.GetString("performer_id")],
		"details":            details,
		"created":            record.GetDateTime("created").String(),
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

	// The panel renders the performer column by NAME, but the row carries
	// only the id. Resolve this page's performers in ONE batched read rather
	// than one lookup per row; a performer whose account is gone (or a read
	// that fails) answers empty, and the client keeps its raw-id fallback.
	performerIDs := make([]string, 0, len(records))
	seen := make(map[string]bool, len(records))
	for _, r := range records {
		pid := r.GetString("performer_id")
		if pid != "" && !seen[pid] {
			seen[pid] = true
			performerIDs = append(performerIDs, pid)
		}
	}
	performerNicknames := make(map[string]string, len(performerIDs))
	if len(performerIDs) > 0 {
		values := make([]any, len(performerIDs))
		for i, pid := range performerIDs {
			values[i] = pid
		}
		var performers []*core.Record
		if err := e.App.RecordQuery(usersCollectionName).
			AndWhere(dbx.In("id", values...)).
			All(&performers); err == nil {
			for _, p := range performers {
				performerNicknames[p.Id] = p.GetString("nickname")
			}
		}
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = auditLogPayload(r, performerNicknames)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}
