package pocketbase

// Baking: what a mask becomes when the account behind it is deleted.
//
// A soft delete takes an account out of circulation but leaves its posts on
// the forum. The posts that were written under a mask must keep showing THAT
// mask — its name, status, avatar and signature — because that is the
// identity the message was published under.
//
// The mask is frozen at that moment, and the freeze is what makes the
// display honest:
//   - the deleted account cannot change it any more (every mutating route
//     refuses a deleted account);
//   - it cannot be deleted either, because the delete command refuses a mask
//     that posts reference (409), and staff cannot rename it or replace its
//     avatar (403);
//   - so the row behind the id still holds exactly the data the post was
//     published with.
//
// A mask of a deleted account that NO post references is deliberately not
// frozen - nothing displays it, so nothing can be rewritten, and freezing it
// would strand a row nobody could ever remove.
//
// Without this, a post that said "Rough" would silently become "Deleted
// user" the moment its author was removed, and the forum would rewrite
// history on the way out.

import (
	"fmt"
	"net/http"
	"testing"
)

// TestDeletedAccountKeepsItsMaskInPosts is the display half: the post still
// renders under the mask.
func TestDeletedAccountKeepsItsMaskInPosts(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")

	// The rule names four fields, so the fixture must carry all four: the
	// mask's name, status, avatar and signature are what the post keeps
	// showing.
	maskRec, err := app.FindRecordById(charactersCollectionName, fixRoughMaskID)
	if err != nil || maskRec == nil {
		t.Fatalf("seeded mask missing: %v", err)
	}
	maskRec.Set("status_line", "Wanderer of the North")
	maskRec.Set("signature", "A signature that belongs to the mask")
	maskRec.Set(avatarURLFieldName, "/api/files/mask-avatar.png")
	if err := app.Save(maskRec); err != nil {
		t.Fatalf("dress the seeded mask: %v", err)
	}

	topicID, _ := createTopicVia(t, server.URL, tokens["player"], catID,
		"idem-baked-mask-1", fmt.Sprintf(`,"character_id":%q`, fixRoughMaskID))

	// The account goes; the post stays.
	softDeleteUserDirectly(t, app, fixPlayerID)

	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/posts", tokens["moderator"], "baked-mask-posts-1", "")
	if status != http.StatusOK {
		t.Fatalf("list posts of a deleted author = %d: %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) == 0 {
		t.Fatal("the topic's posts are missing from the feed")
	}

	var found bool
	for _, item := range items {
		p, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if got, _ := p["author_name"].(string); got != "Rough" {
			t.Errorf("author_name = %q, want the mask name %q — a deleted account must not erase the mask", got, "Rough")
		}
		if isChar, _ := p["is_character"].(bool); !isChar {
			t.Error("is_character must stay true — the post was published under the mask")
		}
		if got, _ := p["author_character_id"].(string); got != fixRoughMaskID {
			t.Errorf("author_character_id = %q, want %q", got, fixRoughMaskID)
		}
		// The other three fields of the mask travel with the name: the status
		// line, the avatar and the signature.
		if got, _ := p["author_status_line"].(string); got != "Wanderer of the North" {
			t.Errorf("author_status_line = %q, want the mask's status line", got)
		}
		if got, _ := p["author_avatar"].(string); got != "/api/files/mask-avatar.png" {
			t.Errorf("author_avatar = %q, want the mask's avatar", got)
		}
		if got, _ := p["author_signature"].(string); got != "A signature that belongs to the mask" {
			t.Errorf("author_signature = %q, want the mask's signature", got)
		}
		// The ACCOUNT is still gone: the mask is a display layer, not a
		// resurrection.
		if got, _ := p["author_deleted"].(bool); !got {
			t.Error("author_deleted must be true — the account is still deleted")
		}
		if got, _ := p["author_role_id"].(string); got != "Deleted" {
			t.Errorf("author_role_id = %q, want Deleted", got)
		}
		if author, ok := p["author"].(map[string]any); ok {
			if got, _ := author["user_id"].(string); got != fixPlayerID {
				t.Errorf("author.user_id = %q, want the deleted account %q", got, fixPlayerID)
			}
			if got, _ := author["deleted"].(bool); !got {
				t.Error("the author DTO must carry deleted=true")
			}
			if got, _ := author["display_name"].(string); got != "Rough" {
				t.Errorf("author.display_name = %q, want the mask name %q", got, "Rough")
			}
			if got, _ := author["is_character"].(bool); !got {
				t.Error("author.is_character must be true")
			}
			// The DTO carries the baked status/signature too — that is what
			// the post card reads, so the page needs no separate
			// per-character fetch to render them.
			if got, _ := author["status_line"].(string); got != "Wanderer of the North" {
				t.Errorf("author.status_line = %q, want the mask's status line", got)
			}
			if got, _ := author["signature"].(string); got != "A signature that belongs to the mask" {
				t.Errorf("author.signature = %q, want the mask's signature", got)
			}
		}
		found = true
	}
	if !found {
		t.Fatal("the masked post of the deleted author is missing from the feed")
	}
}

// TestFrozenMaskOfDeletedAccountCannotBeChanged is the freeze half: the data
// the post renders cannot be rewritten after the fact.
//
// The mask is baked only when posts REFERENCE it — a mask nobody used with
// a post displays nothing, so freezing it would strand the row with no way
// to clean it up.
func TestFrozenMaskOfDeletedAccountCannotBeChanged(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")

	// A post under the mask: this is what bakes it.
	createTopicVia(t, server.URL, tokens["player"], catID,
		"idem-baked-freeze-1", fmt.Sprintf(`,"character_id":%q`, fixRoughMaskID))

	softDeleteUserDirectly(t, app, fixPlayerID)

	// A staff member holds edit_others_mask and delete_others_mask, so without
	// the freeze they could rewrite the identity of a post that is already on
	// the forum.
	status, payload := doJSON(t, server.URL, http.MethodPatch,
		"/api/aerun/characters/"+fixRoughMaskID, tokens["root"], "baked-mask-edit-1",
		`{"name":"Renamed"}`)
	if status != http.StatusForbidden {
		t.Fatalf("editing a baked mask = %d, want 403: %v", status, payload)
	}

	// Deleting it is refused too, by the guard that predates the freeze: a
	// mask that posts reference cannot be deleted (409).
	status, payload = doJSON(t, server.URL, http.MethodDelete,
		"/api/aerun/characters/"+fixRoughMaskID, tokens["root"], "baked-mask-delete-1", "")
	if status != http.StatusConflict {
		t.Fatalf("deleting a baked mask = %d, want 409: %v", status, payload)
	}

	// And the row is untouched.
	rec, err := app.FindRecordById(charactersCollectionName, fixRoughMaskID)
	if err != nil || rec == nil {
		t.Fatalf("the frozen mask must still exist: %v", err)
	}
	if got := rec.GetString("name"); got != "Rough" {
		t.Errorf("the frozen mask's name = %q, want %q", got, "Rough")
	}
}

// TestUnusedMaskOfDeletedAccountCanBeCleanedUp is the other half of the
// freeze rule.
//
// A mask no post references displays nothing, so nothing can be rewritten by
// changing it — and freezing it would leave a row nobody can ever remove: the
// owner is gone and staff would be the only ones who could, for a row that
// does not matter.
func TestUnusedMaskOfDeletedAccountCanBeCleanedUp(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, fixRoughMaskID, fixPlayerID, "Rough")
	softDeleteUserDirectly(t, app, fixPlayerID)

	status, payload := doJSON(t, server.URL, http.MethodDelete,
		"/api/aerun/characters/"+fixRoughMaskID, tokens["root"], "unused-mask-delete-1", "")
	if status != http.StatusOK {
		t.Fatalf("deleting an unused mask of a deleted account = %d, want 200: %v", status, payload)
	}
	if _, err := app.FindRecordById(charactersCollectionName, fixRoughMaskID); err == nil {
		t.Error("the mask must be gone after the delete")
	}
}
