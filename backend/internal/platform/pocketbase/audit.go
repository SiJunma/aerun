package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

const (
	auditLogsCollectionName = "audit_logs"
	auditDefaultPageLimit   = 50
	auditMaxScanLimit       = 2000
)

// normalizeAuditAction maps legacy human-readable audit strings into current
// snake_case types (§3.3 of SPEC_REFACTOR_AUDIT_LOGS.md). Legacy records
// written before the PocketBase migration stay stored as-is for history, but
// read paths serve the canonical type.
func normalizeAuditAction(raw string) string {
	switch raw {
	case "topic deleted":
		return "topic_delete"
	case "topic locked":
		return "topic_lock"
	case "user deleted":
		return "admin_user_delete"
	case "user profile edited by admin", "user role updated":
		return "admin_user_update"
	default:
		return raw
	}
}

// auditActionFilterValues maps a filter type to possible stored values,
// allowing canonical filters to match legacy rows.
func auditActionFilterValues(actionType string) []any {
	switch actionType {
	case "topic_delete":
		return []any{"topic_delete", "topic deleted"}
	case "topic_lock":
		return []any{"topic_lock", "topic locked"}
	case "admin_user_delete":
		return []any{"admin_user_delete", "user deleted"}
	case "admin_user_update":
		return []any{"admin_user_update", "user profile edited by admin", "user role updated"}
	default:
		return []any{actionType}
	}
}

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

func parseRecordDetails(record *core.Record) any {
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
	return details
}

func auditLogPayload(record *core.Record, userNicknames map[string]string) map[string]any {
	details := parseRecordDetails(record)

	// Resolve primary target nickname if identifiable from details
	var targetNickname string
	if dMap, ok := details.(map[string]any); ok && dMap != nil {
		for _, key := range []string{"author_id", "owner_id", "target_id", "user_id"} {
			if uid, _ := dMap[key].(string); uid != "" {
				if nick := userNicknames[uid]; nick != "" {
					targetNickname = nick
					break
				}
			}
		}
	}

	return map[string]any{
		"id":                 record.Id,
		"action_type":        normalizeAuditAction(record.GetString("action_type")),
		"performer_id":       record.GetString("performer_id"),
		"performer_nickname": userNicknames[record.GetString("performer_id")],
		"target_nickname":    targetNickname,
		"details":            details,
		"created":            record.GetDateTime("created").String(),
	}
}

// collectRecordUserIDs gathers all distinct user IDs from records to batch-resolve nicknames.
func collectRecordUserIDs(records []*core.Record) []any {
	seen := make(map[string]bool)
	var ids []any
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}

	for _, r := range records {
		add(r.GetString("performer_id"))
		details := parseRecordDetails(r)
		if dMap, ok := details.(map[string]any); ok && dMap != nil {
			for _, key := range []string{"author_id", "owner_id", "target_id", "user_id", "voter_id"} {
				if uid, _ := dMap[key].(string); uid != "" {
					add(uid)
				}
			}
		}
	}
	return ids
}

// resolveUserNicknames queries the users collection for the given IDs in a single read.
func resolveUserNicknames(app core.App, userIDs []any) map[string]string {
	nicknames := make(map[string]string, len(userIDs))
	if len(userIDs) == 0 {
		return nicknames
	}
	var users []*core.Record
	if err := app.RecordQuery(usersCollectionName).
		AndWhere(dbx.In("id", userIDs...)).
		All(&users); err == nil {
		for _, u := range users {
			nicknames[u.Id] = u.GetString("nickname")
		}
	}
	return nicknames
}

// matchAuditRecord checks whether a record matches the search query qLower.
func matchAuditRecord(r *core.Record, qLower string, userNicknames map[string]string) bool {
	if strings.Contains(strings.ToLower(r.Id), qLower) {
		return true
	}

	if pNick := userNicknames[r.GetString("performer_id")]; pNick != "" {
		if strings.Contains(strings.ToLower(pNick), qLower) {
			return true
		}
	}

	details := parseRecordDetails(r)
	dMap, ok := details.(map[string]any)
	if !ok || dMap == nil {
		return false
	}

	// Target nicknames (author, owner, target, user)
	for _, key := range []string{"author_id", "owner_id", "target_id", "user_id"} {
		if uid, _ := dMap[key].(string); uid != "" {
			if nick := userNicknames[uid]; nick != "" {
				if strings.Contains(strings.ToLower(nick), qLower) {
					return true
				}
			}
		}
	}

	// Guest display name
	if guest, _ := dMap["guest_display_name"].(string); guest != "" {
		if strings.Contains(strings.ToLower(guest), qLower) {
			return true
		}
	}

	// Post content
	if content, _ := dMap["content"].(string); content != "" {
		if strings.Contains(strings.ToLower(content), qLower) {
			return true
		}
	}

	// Titles
	for _, key := range []string{"topic_title", "category_title"} {
		if title, _ := dMap[key].(string); title != "" {
			if strings.Contains(strings.ToLower(title), qLower) {
				return true
			}
		}
	}

	// Name or title (string or {en, ru} object)
	for _, key := range []string{"name", "title"} {
		if val, exists := dMap[key]; exists && val != nil {
			switch v := val.(type) {
			case string:
				if strings.Contains(strings.ToLower(v), qLower) {
					return true
				}
			case map[string]any:
				for _, sub := range v {
					if s, ok := sub.(string); ok && strings.Contains(strings.ToLower(s), qLower) {
						return true
					}
				}
			}
		}
	}

	return false
}

// adminListAuditLogsHandler returns offset-paginated audit logs with search and filter.
// Gated by PermViewAuditLog.
func adminListAuditLogsHandler(e *core.RequestEvent) error {
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), auditDefaultPageLimit), auditDefaultPageLimit)
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}

	performerID := strings.TrimSpace(e.Request.URL.Query().Get("performer_id"))
	actionType := strings.TrimSpace(e.Request.URL.Query().Get("action_type"))
	q := strings.TrimSpace(e.Request.URL.Query().Get("q"))

	var where []dbx.Expression
	if performerID != "" {
		where = append(where, dbx.HashExp{"performer_id": performerID})
	}
	if actionType != "" && actionType != "all" {
		vals := auditActionFilterValues(actionType)
		if len(vals) == 1 {
			where = append(where, dbx.HashExp{"action_type": vals[0]})
		} else {
			where = append(where, dbx.In("action_type", vals...))
		}
	}

	if q != "" {
		// Server-side Unicode-aware search (scan limit up to auditMaxScanLimit rows)
		scanQuery := e.App.RecordQuery(auditLogsCollectionName)
		for _, expr := range where {
			scanQuery.AndWhere(expr)
		}
		scanQuery.OrderBy("created DESC", "id DESC").Limit(int64(auditMaxScanLimit))

		var candidateRecords []*core.Record
		if err := scanQuery.All(&candidateRecords); err != nil {
			return internalError("failed to query audit logs for search", err)
		}

		userIDs := collectRecordUserIDs(candidateRecords)
		userNicknames := resolveUserNicknames(e.App, userIDs)

		qLower := strings.ToLower(q)
		var matchedRecords []*core.Record
		for _, r := range candidateRecords {
			if matchAuditRecord(r, qLower, userNicknames) {
				matchedRecords = append(matchedRecords, r)
			}
		}

		total := len(matchedRecords)
		totalPages := (total + limit - 1) / limit
		if totalPages < 1 {
			totalPages = 1
		}

		start := (page - 1) * limit
		if start > total {
			start = total
		}
		end := start + limit
		if end > total {
			end = total
		}
		pageRecords := matchedRecords[start:end]

		items := make([]map[string]any, len(pageRecords))
		for i, r := range pageRecords {
			items[i] = auditLogPayload(r, userNicknames)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"items":       items,
			"total":       total,
			"total_items": total,
			"page":        page,
			"total_pages": totalPages,
			"totalPages":  totalPages,
			"request_id":  requestIDFrom(e),
		})
	}

	// No search query: direct offset-based database pagination
	totalCount, err := e.App.CountRecords(auditLogsCollectionName, where...)
	if err != nil {
		return internalError("failed to count audit logs", err)
	}
	total := int(totalCount)
	totalPages := (total + limit - 1) / limit
	if totalPages < 1 {
		totalPages = 1
	}

	listQuery := e.App.RecordQuery(auditLogsCollectionName)
	for _, expr := range where {
		listQuery.AndWhere(expr)
	}
	offset := int64((page - 1) * limit)
	listQuery.OrderBy("created DESC", "id DESC").
		Limit(int64(limit)).
		Offset(offset)

	var records []*core.Record
	if err := listQuery.All(&records); err != nil {
		return internalError("failed to query audit logs", err)
	}

	userIDs := collectRecordUserIDs(records)
	userNicknames := resolveUserNicknames(e.App, userIDs)

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = auditLogPayload(r, userNicknames)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"total":       total,
		"total_items": total,
		"page":        page,
		"total_pages": totalPages,
		"totalPages":  totalPages,
		"request_id":  requestIDFrom(e),
	})
}
