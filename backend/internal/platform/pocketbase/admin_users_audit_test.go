package pocketbase

// admin_users_audit_test.go pins the audit contract of the admin user
// commands (§9.7 of markdowns/SPEC_BULK_USER_MANAGEMENT.md):
//
//   - every destructive account action — ban/unban, role change, soft
//     delete — reaches audit_logs with the target's NICKNAME, not just the
//     opaque id, and with the previous role/status next to the new ones, so
//     a ban is distinguishable from an unban in the log;
//   - each bulk command writes exactly ONE audit row — the summary carrying
//     the admin's action and the FULL nickname list of the attempted
//     targets, including the refused ones, with each account's previous
//     role/status beside it. There are NO per-target audit rows from a
//     bulk command: one operation, one log entry.
//
// The actor is root throughout: the point of this file is the audit trail,
// not the rank matrix (that lives in admin_users_rank_test.go and
// commands_test.go).

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAdminUserAuditCarriesNicknames(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	do := func(method, path, body, idemKey string) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", tokens["root"])
		req.Header.Set("Idempotency-Key", idemKey)
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		payload, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s %s = %d, want 200: %s", method, path, res.StatusCode, payload)
		}
		var out map[string]any
		if err := json.Unmarshal(payload, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	assertDetails := func(entry map[string]any) map[string]any {
		t.Helper()
		details, ok := entry["details"].(map[string]any)
		if !ok {
			t.Fatalf("audit entry has no object details: %v", entry)
		}
		return details
	}

	// 1. Single ban through PATCH: the entry names the target by nickname
	// and carries the previous status next to the new one.
	do(http.MethodPatch, "/api/aerun/admin/users/"+fixPlayerID, `{"status":"banned"}`, "audit-single-ban")
	updates := auditLogsFor(t, app, "admin_user_update")
	if len(updates) != 1 {
		t.Fatalf("single ban must write exactly one admin_user_update, got %d", len(updates))
	}
	details := assertDetails(updates[0])
	if details["target_nickname"] != "PlayerOne" {
		t.Errorf("target_nickname = %v, want PlayerOne", details["target_nickname"])
	}
	if details["old_status"] != "active" {
		t.Errorf("old_status = %v, want active", details["old_status"])
	}
	if details["status"] != "banned" {
		t.Errorf("status = %v, want banned", details["status"])
	}

	// 2. Single delete with a content purge.
	do(http.MethodDelete, "/api/aerun/admin/users/"+fixModeratorID, `{"delete_posts":true}`, "audit-single-delete")
	deletes := auditLogsFor(t, app, "admin_user_delete")
	if len(deletes) != 1 {
		t.Fatalf("single delete must write exactly one admin_user_delete, got %d", len(deletes))
	}
	details = assertDetails(deletes[0])
	if details["target_nickname"] != "ModOne" {
		t.Errorf("target_nickname = %v, want ModOne", details["target_nickname"])
	}
	if details["delete_posts"] != true {
		t.Errorf("delete_posts = %v, want true", details["delete_posts"])
	}

	// 3. Bulk role change: one summary event carries the FULL target list —
	// two successful nicknames plus the refused unknown id — and each
	// per-target entry carries the nickname too.
	do(http.MethodPatch, "/api/aerun/admin/users/bulk",
		`{"ids":["`+fixPlayerID+`","`+fixSpectatorID+`","does-not-exist"],"role":"moderator"}`,
		"audit-bulk-role")
	summaries := auditLogsFor(t, app, "admin_users_bulk_update")
	if len(summaries) != 1 {
		t.Fatalf("bulk role change must write exactly one summary, got %d", len(summaries))
	}
	details = assertDetails(summaries[0])
	if details["role"] != "moderator" {
		t.Errorf("summary role = %v, want moderator", details["role"])
	}
	if details["succeeded"] != float64(2) || details["failed"] != float64(1) {
		t.Errorf("summary counts = succeeded %v, failed %v; want 2/1", details["succeeded"], details["failed"])
	}
	targets, ok := details["targets"].([]any)
	if !ok || len(targets) != 3 {
		t.Fatalf("summary targets = %v, want 3 entries", details["targets"])
	}
	byID := map[string]map[string]any{}
	for _, raw := range targets {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("summary target entry is not an object: %v", raw)
		}
		byID[entry["id"].(string)] = entry
	}
	if player := byID[fixPlayerID]; player == nil || player["nickname"] != "PlayerOne" || player["ok"] != true {
		t.Errorf("summary entry for the player = %v, want nickname PlayerOne ok true", player)
	}
	if spectator := byID[fixSpectatorID]; spectator == nil || spectator["nickname"] != "SpecOne" || spectator["ok"] != true {
		t.Errorf("summary entry for the spectator = %v, want nickname SpecOne ok true", spectator)
	}
	if unknown := byID["does-not-exist"]; unknown == nil || unknown["ok"] != false || unknown["code"] != "not_found" {
		t.Errorf("summary entry for the unknown id = %v, want ok false code not_found", unknown)
	}

	// Each summary target entry carries the account's previous role/status
	// next to the command's action, refusals included.
	if player := byID[fixPlayerID]; player["old_role"] != "player" || player["old_status"] != "banned" {
		t.Errorf("summary entry for the player = %v, want old_role player old_status banned", player)
	}
	if spectator := byID[fixSpectatorID]; spectator["old_role"] != "spectator" || spectator["old_status"] != "active" {
		t.Errorf("summary entry for the spectator = %v, want old_role spectator old_status active", spectator)
	}

	// A bulk command writes NO per-target admin_user_update rows: the only
	// admin_user_update entry in the log is the single ban from step 1.
	updates = auditLogsFor(t, app, "admin_user_update")
	if len(updates) != 1 {
		t.Fatalf("a bulk pass must not write per-target admin_user_update rows; want 1 entry (the single ban), got %d", len(updates))
	}
	if d := assertDetails(updates[0]); d["target_nickname"] != "PlayerOne" {
		t.Errorf("the only admin_user_update entry = %v, want the single PlayerOne ban", d)
	}

	// 4. Bulk ban: a second summary records the status write with the
	// target's nickname. The two summaries are told apart by content, not
	// by row order — FindAllRecords does not promise one.
	do(http.MethodPatch, "/api/aerun/admin/users/bulk", `{"ids":["`+fixPendingID+`"],"status":"banned"}`, "audit-bulk-ban")
	summaries = auditLogsFor(t, app, "admin_users_bulk_update")
	if len(summaries) != 2 {
		t.Fatalf("two bulk update commands must leave 2 summaries, got %d", len(summaries))
	}
	var banSummary map[string]any
	for _, entry := range summaries {
		if d := assertDetails(entry); d["status"] == "banned" {
			banSummary = d
		}
	}
	if banSummary == nil {
		t.Fatal("no ban summary among the admin_users_bulk_update entries")
	}
	if banSummary["succeeded"] != float64(1) || banSummary["failed"] != float64(0) {
		t.Errorf("ban summary counts = succeeded %v, failed %v; want 1/0", banSummary["succeeded"], banSummary["failed"])
	}
	targets, ok = banSummary["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("ban summary targets = %v, want 1 entry", banSummary["targets"])
	}
	if entry, _ := targets[0].(map[string]any); entry["nickname"] != "PendingOne" || entry["old_status"] != "pending" {
		t.Errorf("ban summary entry = %v, want nickname PendingOne old_status pending", entry)
	}

	// 5. Bulk delete with a content purge: the summary lists the nickname
	// of the deleted account, and the per-target entry repeats it. Again
	// matched by content, because row order is not promised.
	do(http.MethodDelete, "/api/aerun/admin/users/bulk", `{"ids":["`+fixSpectatorID+`"],"delete_posts":true}`, "audit-bulk-delete")
	deleteSummaries := auditLogsFor(t, app, "admin_users_bulk_delete")
	if len(deleteSummaries) != 1 {
		t.Fatalf("bulk delete must write exactly one summary, got %d", len(deleteSummaries))
	}
	details = assertDetails(deleteSummaries[0])
	if details["delete_posts"] != true || details["succeeded"] != float64(1) {
		t.Errorf("delete summary = %v, want delete_posts true with 1 success", details)
	}
	targets, ok = details["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("delete summary targets = %v, want 1 entry", details["targets"])
	}
	if entry, _ := targets[0].(map[string]any); entry["nickname"] != "SpecOne" || entry["ok"] != true {
		t.Errorf("delete summary entry = %v, want SpecOne ok true", entry)
	}
	// A bulk delete writes NO per-target admin_user_delete rows: the only
	// entry in the log is the single delete from step 2.
	deletes = auditLogsFor(t, app, "admin_user_delete")
	if len(deletes) != 1 {
		t.Fatalf("a bulk delete must not write per-target admin_user_delete rows; want 1 entry (the single delete), got %d", len(deletes))
	}
	if d := assertDetails(deletes[0]); d["target_nickname"] != "ModOne" {
		t.Errorf("the only admin_user_delete entry = %v, want the single ModOne delete", d)
	}
}
