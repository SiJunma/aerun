package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestAuditGeneration_CharacterRules(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. Player updates their own mask -> succeeds, NO character_updated audit log.
	status, body, _ := categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/characters/charplayer00001",
		`{"name":"Player Mask Renamed","status_line":"New status"}`,
		tokens["player"], "idem-player-patch-own")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	ownLogs := auditLogsFor(t, app, "character_updated")
	if len(ownLogs) != 0 {
		t.Fatalf("expected 0 audit logs for self mask edit, got %d: %v", len(ownLogs), ownLogs)
	}

	// 2. Root updates player's mask -> succeeds, character_updated audit log IS recorded with changes diff.
	status, body, _ = categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/characters/charplayer00001",
		`{"name":"Staff Renamed Mask"}`,
		tokens["root"], "idem-root-patch-other")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	staffLogs := auditLogsFor(t, app, "character_updated")
	if len(staffLogs) != 1 {
		t.Fatalf("expected 1 audit log for staff mask edit, got %d: %v", len(staffLogs), staffLogs)
	}

	entry := staffLogs[0]
	if entry["performer"] != fixRootID {
		t.Errorf("performer = %v, want root id %s", entry["performer"], fixRootID)
	}
	details, _ := entry["details"].(map[string]any)
	if details == nil {
		t.Fatalf("details missing in audit entry: %v", entry)
	}
	if details["target_id"] != "charplayer00001" {
		t.Errorf("target_id = %v, want charplayer00001", details["target_id"])
	}
	if details["owner_id"] != fixPlayerID {
		t.Errorf("owner_id = %v, want %s", details["owner_id"], fixPlayerID)
	}
	changes, _ := details["changes"].(map[string]any)
	if changes == nil {
		t.Fatalf("changes diff missing: %v", details)
	}
	nameChange, _ := changes["name"].(map[string]any)
	if nameChange == nil || nameChange["from"] != "Player Mask Renamed" || nameChange["to"] != "Staff Renamed Mask" {
		t.Errorf("unexpected name changes diff: %v", nameChange)
	}
}

func TestAuditGeneration_PurgeUserPostDeletePerformer(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Seed topic in general category by fixAdminID
	catID := getGeneralCategoryID(t, app)
	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", fixAdminID)
	topic.Set("title", "Purge Test Topic")
	topic.Set("posts_count", 2)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	// Post by fixPendingID
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", topic.Id)
	post.Set("author_id", fixPendingID)
	post.Set("content", "Pending author post that will be purged")
	post.Set("is_draft", false)
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}

	// Root deletes the pending user with delete_posts=true
	status, body, _ := categoryCall(t, http.MethodDelete,
		fmt.Sprintf("%s/api/aerun/admin/users/%s?delete_posts=true", ts.URL, fixPendingID),
		"", tokens["root"], "idem-root-purge-user")
	if status != http.StatusOK {
		t.Fatalf("delete user failed: %d: %s", status, body)
	}

	// Check post_delete audit log
	logs := auditLogsFor(t, app, "post_delete")
	var found bool
	for _, l := range logs {
		details, _ := l["details"].(map[string]any)
		if details == nil {
			continue
		}
		if details["author_id"] == fixPendingID && strings.Contains(details["content"].(string), "Pending author post") {
			found = true
			if l["performer"] != fixRootID {
				t.Errorf("performer = %v, want root id %s", l["performer"], fixRootID)
			}
			if details["category_id"] != catID {
				t.Errorf("category_id = %v, want %s", details["category_id"], catID)
			}
			if details["category_title"] == "" {
				t.Errorf("category_title must not be empty in post_delete details")
			}
			break
		}
	}
	if !found {
		t.Fatalf("expected purged post_delete audit log, entries: %v", logs)
	}
}
