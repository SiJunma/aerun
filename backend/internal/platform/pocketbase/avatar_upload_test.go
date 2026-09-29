package pocketbase

// Tests for PUT /api/aerun/me/avatar.
//
// The property that matters is the one the old client-side uploader violated:
// a stored avatar must be a FILE the record owns, referenced by a short
// host-agnostic path. A 512-character text column can never hold image bytes,
// so the regression to guard is any path that puts base64 (or a raw blob) back
// into avatar_url.

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// uploadPNGBytes is the smallest valid 1x1 PNG. The format is sniffed from the
// magic bytes on the server, so a real header is required for the upload to be
// accepted. (avatar_import_test.go already defines pngBytes for the importer,
// so this file uses a sibling name rather than shadowing it.)
var uploadPNGBytes = []byte{
	0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A,
	0x00, 0x00, 0x00, 0x0D, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
	0x89,
}

// multipartBody wraps payload in a multipart/form-data body with the given
// field name. CreateFormFile sets a generic application/octet-stream part
// header, so nothing here can tell the server what the payload is — which is
// the point.
func multipartBody(t testing.TB, field, filename string, payload []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, w.FormDataContentType()
}

// uploadAvatarOnce performs one authenticated upload against a live test server
// and returns the avatar_url the command reported.
func uploadAvatarOnce(t testing.TB, serverURL, token string, payload []byte) string {
	t.Helper()
	body, contentType := multipartBody(t, avatarFormField, "avatar.png", payload)
	req, err := http.NewRequest(http.MethodPut, serverURL+"/api/aerun/me/avatar", body)
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
		t.Fatalf("upload failed: %d %s", res.StatusCode, raw)
	}
	return responseAvatarURL(t, raw)
}

// responseAvatarURL pulls avatar_url out of a command response.
func responseAvatarURL(t testing.TB, raw []byte) string {
	t.Helper()
	var parsed struct {
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("decode response %s: %v", raw, err)
	}
	return parsed.AvatarURL
}

// TestUploadMyAvatarStoresAFile pins the whole point: the response is a short
// /api/files path, the record owns a real file, and avatar_url is a reference —
// never the bytes.
func TestUploadMyAvatarStoresAFile(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "player uploads an avatar and gets a file path back",
		Method:         http.MethodPut,
		URL:            "/api/aerun/me/avatar",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"avatar_url":"/api/files/`,
			// PocketBase prefixes the stored name with a random id, so the
			// extension is the stable part of it.
			`.png"`,
		},
		NotExpectedContent: []string{
			// The bug this replaces: an inline image never belongs in the
			// response, and a base64 blob is far past 512 characters.
			`data:image`,
			`base64,`,
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			body, contentType := multipartBody(t, avatarFormField, "avatar.txt", uploadPNGBytes)
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": seedIdentityFixtures(t, app)["player"],
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
			if err != nil {
				t.Fatal(err)
			}
			if got := user.GetString(avatarFieldName); got == "" {
				t.Error("users.avatar must hold a stored file after an upload")
			}
			url := user.GetString(avatarURLFieldName)
			if !strings.HasPrefix(url, "/api/files/") {
				t.Errorf("avatar_url = %q, want a host-agnostic /api/files path", url)
			}
			// The column is TextField Max 512; a data URL could never fit, and
			// this is the assertion that keeps that from coming back.
			if len(url) > 512 {
				t.Errorf("avatar_url is %d characters; the column caps at 512", len(url))
			}
		},
	}
	scenario.Test(t)
}

// TestUploadMyAvatarRejectsNonImage proves the format is decided by the bytes.
// The client sends a .png filename, but the payload is plain text: trusting
// the client would store a broken image.
func TestUploadMyAvatarRejectsNonImage(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "a non-image payload is refused",
		Method:         http.MethodPut,
		URL:            "/api/aerun/me/avatar",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusBadRequest,
		ExpectedContent: []string{
			"PNG, JPEG, WebP or GIF",
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			body, contentType := multipartBody(t, avatarFormField, "avatar.png", []byte("not an image at all"))
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": seedIdentityFixtures(t, app)["player"],
			}
		},
	}
	scenario.Test(t)
}

// TestUploadMyAvatarRejectsOversized proves the 2 MB ceiling is enforced
// server-side. The client cap is a courtesy that spares the user a round trip,
// not the control: a direct client must be stopped here.
func TestUploadMyAvatarRejectsOversized(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:           "an oversized avatar is refused",
		Method:         http.MethodPut,
		URL:            "/api/aerun/me/avatar",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusBadRequest,
		ExpectedContent: []string{
			"exceeds the maximum allowed size",
		},
		NotExpectedContent: []string{
			// A size problem must not be reported as a content-type problem:
			// the client did send multipart.
			"multipart/form-data",
		},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			// Valid PNG magic followed by padding past the cap, so the format is
			// fine and only the size is wrong.
			oversized := append(append([]byte{}, uploadPNGBytes...),
				make([]byte, avatarUploadMaxBytes+1024)...)
			tokens := seedIdentityFixtures(t, app)
			body, contentType := multipartBody(t, avatarFormField, "avatar.png", oversized)
			scenario.Body = body
			scenario.Headers = map[string]string{
				"Content-Type":  contentType,
				"Authorization": tokens["player"],
			}
		},
	}
	scenario.Test(t)
}

// TestUploadMyAvatarAccessMatrix pins the access rules: guests cannot upload,
// a banned account is refused even with a valid token, and a pending account
// keeps the legacy self-service right.
func TestUploadMyAvatarAccessMatrix(t *testing.T) {
	cases := []struct {
		name        string
		actor       string
		wantStatus  int
		wantContent []string
	}{
		{
			name:        "guest is unauthenticated",
			actor:       "",
			wantStatus:  http.StatusUnauthorized,
			wantContent: []string{"Authentication is required"},
		},
		{
			name:        "banned account is forbidden",
			actor:       "banned",
			wantStatus:  http.StatusForbidden,
			wantContent: []string{"Banned accounts cannot change their avatar"},
		},
		{
			name:        "pending account keeps self-service",
			actor:       "pending",
			wantStatus:  http.StatusOK,
			wantContent: []string{`"avatar_url":"/api/files/`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var scenario tests.ApiScenario
			scenario = tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPut,
				URL:             "/api/aerun/me/avatar",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.wantStatus,
				ExpectedContent: tc.wantContent,
				BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
					// Seeded once and reused: the headers are read from the same
					// fixture map below, and seeding twice would trip the
					// unique nickname index.
					tokens := seedIdentityFixtures(t, app)
					body, contentType := multipartBody(t, avatarFormField, "avatar.png", uploadPNGBytes)
					scenario.Body = body
					scenario.Headers = map[string]string{
						"Content-Type":  contentType,
						"Authorization": tokens[tc.actor],
					}
				},
			}
			scenario.Test(t)
		})
	}
}

// TestUploadMyAvatarReplacesPreviousFile pins that a second upload leaves
// exactly ONE file on disk for the record.
//
// The name is deliberately not asserted to be stable: PocketBase prefixes every
// stored file with a fresh random id (that is what keeps names unique), so
// re-uploading the same bytes yields a different filename. What must hold is
// that the previous file is deleted — otherwise every upload would leak a copy
// of the avatar into the data dir forever, and this is the property that lets
// the route skip the idempotency envelope (which cannot hold a multipart body).
func TestUploadMyAvatarReplacesPreviousFile(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	firstURL := uploadAvatarOnce(t, server.URL, tokens["player"], uploadPNGBytes)
	if !strings.HasPrefix(firstURL, "/api/files/") {
		t.Fatalf("first upload returned %q", firstURL)
	}
	firstName := path.Base(firstURL)

	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	storedDir := filepath.Join(app.DataDir(), "storage", users.Id, fixPlayerID)
	// Drain the async delete queue PocketBase schedules for replaced files.
	waitForSingleAvatarFile(t, storedDir, firstName)

	uploadAvatarOnce(t, server.URL, tokens["player"], uploadPNGBytes)
	after, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	secondName := after.GetString(avatarFieldName)
	if secondName == "" {
		t.Fatal("the second upload stored no file")
	}
	waitForSingleAvatarFile(t, storedDir, secondName)
}

// waitForSingleAvatarFile asserts the record's storage dir holds exactly the
// expected file, retrying briefly: PocketBase deletes a replaced file from a
// background queue, so the assertion must not race it.
//
// PocketBase keeps a `<name>.attrs` sidecar next to every stored file (it holds
// the served Content-Type). Only the avatar itself is counted.
func waitForSingleAvatarFile(t testing.TB, dir, expected string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var entries []string
	for time.Now().Before(deadline) {
		entries = entries[:0]
		items, err := os.ReadDir(dir)
		if err == nil {
			for _, item := range items {
				if item.IsDir() || strings.HasSuffix(item.Name(), ".attrs") {
					continue
				}
				entries = append(entries, item.Name())
			}
			if len(entries) == 1 && entries[0] == expected {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("storage dir %s holds %v, want exactly [%s]", dir, entries, expected)
}
