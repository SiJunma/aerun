package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func TestAuditListAPI_PaginationAndFilters(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	col, err := app.FindCollectionByNameOrId(auditLogsCollectionName)
	if err != nil {
		t.Fatal(err)
	}

	// Seed 5 audit records with distinct created times
	for i := 1; i <= 5; i++ {
		r := core.NewRecord(col)
		r.Set("action_type", "settings_updated")
		r.Set("performer_id", fixRootID)
		r.Set("details", types.JSONRaw(fmt.Sprintf(`{"index":%d}`, i)))
		r.SetRaw("created", types.NowDateTime().Add(time.Duration(i)*time.Second))
		if err := app.Save(r); err != nil {
			t.Fatal(err)
		}
	}

	// Request page 1 with limit 2
	status, body, _ := categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?page=1&limit=2",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	var res struct {
		Items      []map[string]any `json:"items"`
		Total      int              `json:"total"`
		Page       int              `json:"page"`
		TotalPages int              `json:"total_pages"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}

	if res.Total < 5 {
		t.Errorf("total = %d, want at least 5", res.Total)
	}
	if res.Page != 1 {
		t.Errorf("page = %d, want 1", res.Page)
	}
	if len(res.Items) != 2 {
		t.Errorf("items count = %d, want 2", len(res.Items))
	}

	// Verify performer nickname is resolved
	if nick, _ := res.Items[0]["performer_nickname"].(string); nick == "" {
		t.Errorf("performer_nickname should be populated, got empty: %v", res.Items[0])
	}

	// Request page 2
	status, body, _ = categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?page=2&limit=2",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Page != 2 {
		t.Errorf("page = %d, want 2", res.Page)
	}
	if len(res.Items) != 2 {
		t.Errorf("items count = %d, want 2", len(res.Items))
	}
}

func TestAuditListAPI_SearchAndLegacyNormalization(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	col, err := app.FindCollectionByNameOrId(auditLogsCollectionName)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Seed a legacy record with action_type = "topic deleted"
	legacyRec := core.NewRecord(col)
	legacyRec.Set("action_type", "topic deleted")
	legacyRec.Set("performer_id", fixAdminID)
	legacyRec.Set("details", types.JSONRaw(`{"topic_title":"Старая тема с кириллицей"}`))
	if err := app.Save(legacyRec); err != nil {
		t.Fatal(err)
	}

	// 2. Seed a post_delete record with Cyrillic content and target author
	postRec := core.NewRecord(col)
	postRec.Set("action_type", "post_delete")
	postRec.Set("performer_id", fixAdminID)
	postRec.Set("details", types.JSONRaw(fmt.Sprintf(`{
		"author_id": "%s",
		"content": "Секретный текст удалённого сообщения от игрока",
		"topic_title": "Обсуждение правил",
		"category_title": "Основной раздел"
	}`, fixPlayerID)))
	if err := app.Save(postRec); err != nil {
		t.Fatal(err)
	}

	// Test 1: Filter by canonical action_type=topic_delete matches legacy "topic deleted"
	status, body, _ := categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?action_type=topic_delete",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	var res struct {
		Items []map[string]any `json:"items"`
		Total int              `json:"total"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Errorf("total = %d, want 1 for topic_delete filter", res.Total)
	}
	if len(res.Items) > 0 {
		if res.Items[0]["action_type"] != "topic_delete" {
			t.Errorf("action_type must be normalized to 'topic_delete', got %v", res.Items[0]["action_type"])
		}
	}

	// Test 2: Search by Cyrillic substring in content: "секретный" (lowercase)
	status, body, _ = categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?q=секретный",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Errorf("search for 'секретный': total = %d, want 1", res.Total)
	}

	// Test 3: Search by target user nickname (PlayerOne is fixPlayerID's nickname in seedIdentityFixtures)
	status, body, _ = categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?q=playerone",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Total < 1 {
		t.Errorf("search for target nickname 'playerone': total = %d, want >= 1", res.Total)
	}

	// Test 4: Search by category title "основной"
	status, body, _ = categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/admin/audit-logs?q=основной",
		"", tokens["root"], "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Errorf("search for category title 'основной': total = %d, want 1", res.Total)
	}
}
