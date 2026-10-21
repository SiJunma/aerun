package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// The direct-message contract for a PENDING account (owner ruling
// 2026-10-20).
//
// A pending member RECEIVES private messages and ANSWERS inside a dialogue
// somebody opened with them. What it may not do is OPEN one — the first word
// in a new dialogue is not an unapproved account's to write.
//
// The bug this pins: the recipient check read the RECIPIENT's status-narrowed
// permission set, and the narrowing took `use_direct_messages` away from every
// pending account. So a member could not write to a pending member at all —
// the server answered 403 "this account cannot receive direct messages (role
// player)", and the client printed that refusal three times for one request.
//
// The permission half of the rule is in internal/auth/status.go (pending KEEPS
// use_direct_messages); the status half — "may not OPEN" — is in the DM
// command layer, because a permission set cannot say "receive but do not
// initiate".
func TestPendingAccountReceivesAndAnswersButDoesNotOpen(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. A member opens a conversation WITH a pending member. The recipient
	//    check must pass: the pending account is a member of the forum.
	status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms",
		tokens["player"], "dm-pending-receive-1",
		fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello there"}`, fixPendingID))
	if status != http.StatusOK {
		t.Fatalf("a pending member must be able to RECEIVE a direct message, got %d: %v", status, payload)
	}
	convID, _ := payload["conversation_id"].(string)
	if convID == "" {
		t.Fatalf("no conversation id in the response: %v", payload)
	}

	// 2. The pending member ANSWERS inside that dialogue. This is the whole
	//    point of the ruling: they receive, and they reply.
	status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms/"+convID+"/messages",
		tokens["pending"], "dm-pending-reply-1", `{"text":"thanks, I am here"}`)
	if status != http.StatusOK {
		t.Fatalf("a pending member must be able to ANSWER in a dialogue opened with them, got %d: %v", status, payload)
	}

	// 3. The pending member may NOT open a conversation of their own. The peer
	//    is somebody they have no dialogue with, so this is an OPENING, not a
	//    reply.
	status, payload = doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms",
		tokens["pending"], "dm-pending-open-1",
		fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"may I start this?"}`, fixModeratorID))
	if status != http.StatusForbidden {
		t.Fatalf("a pending member must not be able to OPEN a conversation, got %d: %v", status, payload)
	}
	if msg, _ := payload["message"].(string); !strings.Contains(msg, "cannot start a conversation") {
		t.Fatalf("the refusal must name the rule, got %q", msg)
	}
}
