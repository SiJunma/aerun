package pocketbase

// Tests for PUT /api/aerun/admin/settings/placeholder/{kind} — the admin upload
// for the two identity placeholder images (plan I5/D2): "deleted" (shown for a
// removed account) and "guest" (shown for an anonymous visitor).
//
// The properties that matter mirror the user-avatar command this endpoint
// reuses (readAvatarUpload -> avatarFileName -> FileField + *_avatar_url):
//   - the stored image is a FILE the forum_settings singleton owns, referenced
//     by a short host-agnostic /api/files path, never inline bytes;
//   - the reference rides the PUBLIC settings snapshot, so every visitor — a
//     guest included — resolves the same placeholder;
//   - only an administrator may change it; the format is decided by the bytes,
//     not the client; an unknown kind is refused rather than silently defaulted;
//   - clearing the reference through the ordinary settings PATCH resets to the
//     neutral default.

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// uploadPlaceholderOnce performs one authenticated placeholder upload against a
// live test server and returns the avatar_url the command reported.
func uploadPlaceholderOnce(t testing.TB, serverURL, token, kind string, payload []byte) string {
	t.Helper()
	body, contentType := multipartBody(t, avatarFormField, kind+".png", payload)
	req, err := http.NewRequest(http.MethodPut, serverURL+"/api/aerun/admin/settings/placeholder/"+kind, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("placeholder upload failed: %d %s", res.StatusCode, raw)
	}
	return responseAvatarURL(t, raw)
}

// TestUploadIdentityPlaceholderStoresAFile pins the whole point: an admin upload
// yields a short /api/files path on the singleton, and the URL column holds the
// reference — never the bytes.
func TestUploadIdentityPlaceholderStoresAFile(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "root uploads the deleted placeholder and gets a file path back",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/settings/placeholder/deleted",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"avatar_url":"/api/files/`,
			`.png"`,
		},
		NotExpectedContent: []string{
			`data:image`,
			`base64,`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			body, contentType := multipartBody(t, avatarFormField, "deleted.png", uploadPNGBytes)
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": seedIdentityFixtures(t, app)["root"],
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
			if err != nil {
				t.Fatal(err)
			}
			if got := record.GetString("deleted_avatar"); got == "" {
				t.Error("forum_settings.deleted_avatar must hold a stored file after an upload")
			}
			url := record.GetString("deleted_avatar_url")
			if !strings.HasPrefix(url, "/api/files/") {
				t.Errorf("deleted_avatar_url = %q, want a host-agnostic /api/files path", url)
			}
			if len(url) > 512 {
				t.Errorf("deleted_avatar_url is %d characters; the column caps at 512", len(url))
			}
		},
	}
	scenario.Test(t)
}

// TestIdentityPlaceholderRidesPublicSnapshot proves the reference is served on
// the public settings snapshot the whole forum reads — a guest included — so the
// custom placeholder never needs a second round trip or an authenticated read.
func TestIdentityPlaceholderRidesPublicSnapshot(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	url := uploadPlaceholderOnce(t, server.URL, tokens["root"], "guest", uploadPNGBytes)
	if !strings.HasPrefix(url, "/api/files/") {
		t.Fatalf("upload returned %q", url)
	}

	// A guest (no token) must see the same reference as a signed-in member.
	for _, who := range []string{"", "player", "root"} {
		status, body := getAerunAuthed(t, server.URL+"/api/aerun/settings", tokens[who])
		if status != http.StatusOK {
			t.Fatalf("%q: settings read must be 200, got %d: %s", who, status, body)
		}
		if !bytes.Contains(body, []byte(`"guestAvatar":"`+url+`"`)) {
			t.Errorf("%q: public snapshot must carry guestAvatar=%q, got %s", who, url, body)
		}
	}
}

// TestUploadIdentityPlaceholderAccessMatrix pins the access rules: a guest is
// unauthenticated, an ordinary member is forbidden, only an admin uploads.
func TestUploadIdentityPlaceholderAccessMatrix(t *testing.T) {
	cases := []struct {
		name        string
		actor       string
		wantStatus  int
		wantContent []string
	}{
		{name: "guest is unauthenticated", actor: "", wantStatus: http.StatusUnauthorized, wantContent: []string{"Authentication is required"}},
		{name: "player is forbidden", actor: "player", wantStatus: http.StatusForbidden, wantContent: []string{"You are not allowed"}},
		{name: "root uploads", actor: "root", wantStatus: http.StatusOK, wantContent: []string{`"avatar_url":"/api/files/`}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var scenario tests.ApiScenario
			scenario = tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPut,
				URL:             "/api/aerun/admin/settings/placeholder/deleted",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.wantStatus,
				ExpectedContent: tc.wantContent,
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					body, contentType := multipartBody(t, avatarFormField, "deleted.png", uploadPNGBytes)
					scenario.Body = body
					scenario.Headers = map[string]string{
						"Content-Type":  contentType,
						"Authorization": seedIdentityFixtures(t, app)[tc.actor],
					}
				},
			}
			scenario.Test(t)
		})
	}
}

// TestUploadIdentityPlaceholderRejectsNonImage proves the format is decided by
// the bytes: a .png filename over plain text is refused, not stored as a broken
// image the browser would render.
func TestUploadIdentityPlaceholderRejectsNonImage(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "a non-image payload is refused",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/settings/placeholder/deleted",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusBadRequest,
		ExpectedContent: []string{
			"PNG, JPEG, WebP or GIF",
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			body, contentType := multipartBody(t, avatarFormField, "deleted.png", []byte("not an image at all"))
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": seedIdentityFixtures(t, app)["root"],
			}
		},
	}
	scenario.Test(t)
}

// TestUploadIdentityPlaceholderRejectsUnknownKind proves a typo in the path
// segment is refused rather than silently defaulted, so a bad client can never
// overwrite the wrong placeholder.
func TestUploadIdentityPlaceholderRejectsUnknownKind(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "an unknown placeholder kind is refused",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/settings/placeholder/banned",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusBadRequest,
		ExpectedContent: []string{
			`Placeholder kind must be`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			body, contentType := multipartBody(t, avatarFormField, "banned.png", uploadPNGBytes)
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": seedIdentityFixtures(t, app)["root"],
			}
		},
	}
	scenario.Test(t)
}

// TestResetIdentityPlaceholderClearsReference pins the reset affordance: an
// empty reference sent through the ordinary settings PATCH drops the custom
// image back to the neutral default on the public snapshot, exactly like
// clearing faviconUrl.
func TestResetIdentityPlaceholderClearsReference(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	uploadPlaceholderOnce(t, server.URL, tokens["root"], "deleted", uploadPNGBytes)

	// The reference is present before the reset.
	status, body := getAerunAuthed(t, server.URL+"/api/aerun/settings", tokens["root"])
	if status != http.StatusOK {
		t.Fatalf("settings read: %d %s", status, body)
	}
	if !bytes.Contains(body, []byte(`"deletedAvatar":"/api/files/`)) {
		t.Fatalf("deletedAvatar must carry the uploaded reference before reset, got %s", body)
	}

	// Clear it the same way the admin panel resets a placeholder: an empty string.
	status, body, _ = categoryCall(t, http.MethodPatch,
		server.URL+"/api/aerun/admin/settings", `{"deletedAvatar":""}`,
		tokens["root"], "test-idem-placeholder-reset")
	if status != http.StatusOK {
		t.Fatalf("reset PATCH must succeed, got %d: %s", status, body)
	}

	status, body = getAerunAuthed(t, server.URL+"/api/aerun/settings", tokens["root"])
	if status != http.StatusOK {
		t.Fatalf("settings read after reset: %d %s", status, body)
	}
	if !bytes.Contains(body, []byte(`"deletedAvatar":""`)) {
		t.Errorf("deletedAvatar must be empty after reset, got %s", body)
	}
}
