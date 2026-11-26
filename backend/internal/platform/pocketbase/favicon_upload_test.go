package pocketbase

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

var (
	// Minimal valid 1-entry 1x1 ICO header + bitmap payload recognized by mimetype.
	uploadICOBytes = []byte{
		0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
		0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
	}
	uploadSVGBytes = []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>`)
)

func putFaviconMultipart(t testing.TB, url, token, filename string, payload []byte) (int, []byte) {
	t.Helper()
	body, contentType := multipartBody(t, avatarFormField, filename, payload)
	req, err := http.NewRequest(http.MethodPut, url, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, raw
}

func TestUploadSettingsFaviconFormatsAndRejections(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	endpoint := server.URL + "/api/aerun/admin/settings/favicon"

	// Access control checks
	if status, _ := putFaviconMultipart(t, endpoint, "", "favicon.png", uploadPNGBytes); status != http.StatusUnauthorized {
		t.Fatalf("guest upload status = %d, want 401", status)
	}
	if status, _ := putFaviconMultipart(t, endpoint, tokens["player"], "favicon.png", uploadPNGBytes); status != http.StatusForbidden {
		t.Fatalf("player upload status = %d, want 403", status)
	}

	// Reject plain text masquerading as .ico
	if status, _ := putFaviconMultipart(t, endpoint, tokens["root"], "fake.ico", []byte("not an icon")); status != http.StatusBadRequest {
		t.Fatalf("invalid payload status = %d, want 400", status)
	}

	// Accept PNG, ICO and SVG
	for _, tc := range []struct {
		name    string
		file    string
		payload []byte
		wantExt string
	}{
		{name: "png", file: "icon.png", payload: uploadPNGBytes, wantExt: ".png"},
		{name: "ico", file: "icon.ico", payload: uploadICOBytes, wantExt: ".ico"},
		{name: "svg", file: "icon.svg", payload: uploadSVGBytes, wantExt: ".svg"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, raw := putFaviconMultipart(t, endpoint, tokens["root"], tc.file, tc.payload)
			if status != http.StatusOK {
				t.Fatalf("upload %s status = %d: %s", tc.name, status, raw)
			}
			var parsed struct {
				FaviconURL string `json:"favicon_url"`
			}
			if err := json.Unmarshal(raw, &parsed); err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(parsed.FaviconURL, "/api/files/") || !strings.HasSuffix(parsed.FaviconURL, tc.wantExt) {
				t.Fatalf("favicon_url = %q, want /api/files/...%s", parsed.FaviconURL, tc.wantExt)
			}

			// Verify public settings snapshot exposes it to guests
			st, snap := getAerun(t, server.URL+"/api/aerun/settings")
			if st != http.StatusOK {
				t.Fatalf("GET /settings = %d: %s", st, snap)
			}
			if !bytes.Contains(snap, []byte(`"faviconUrl":"`+parsed.FaviconURL+`"`)) {
				t.Errorf("settings snapshot missing faviconUrl=%q: %s", parsed.FaviconURL, snap)
			}
		})
	}
}

func TestUploadDesignFaviconAccessAndPersistence(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// Create a design as root
	status, body := postAerunWithHeaders(t, server.URL+"/api/aerun/designs", `{"name":"Favicon Test Design"}`, map[string]string{
		"Authorization":   tokens["root"],
		"Idempotency-Key": "test-idem-design-favicon-create",
	})
	if status != http.StatusCreated {
		t.Fatalf("POST /designs = %d: %s", status, body)
	}
	var created map[string]any
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	designID := created["id"].(string)

	endpoint := server.URL + "/api/aerun/designs/" + designID + "/favicon"

	if st, _ := putFaviconMultipart(t, endpoint, "", "icon.png", uploadPNGBytes); st != http.StatusUnauthorized {
		t.Fatalf("guest upload status = %d, want 401", st)
	}
	if st, _ := putFaviconMultipart(t, endpoint, tokens["player"], "icon.png", uploadPNGBytes); st != http.StatusForbidden {
		t.Fatalf("player upload status = %d, want 403", st)
	}

	st, raw := putFaviconMultipart(t, endpoint, tokens["root"], "icon.svg", uploadSVGBytes)
	if st != http.StatusOK {
		t.Fatalf("root upload status = %d: %s", st, raw)
	}
	var parsed struct {
		FaviconURL string         `json:"favicon_url"`
		Design     map[string]any `json:"design"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parsed.FaviconURL, "/api/files/") || !strings.HasSuffix(parsed.FaviconURL, ".svg") {
		t.Fatalf("favicon_url = %q, want /api/files/....svg", parsed.FaviconURL)
	}
	if got, _ := parsed.Design["favicon_url"].(string); got != parsed.FaviconURL {
		t.Errorf("design.favicon_url = %q, want %q", got, parsed.FaviconURL)
	}

	// Verify GET /designs/{id} reflects the uploaded favicon_url
	getSt, getBody := getAerun(t, server.URL+"/api/aerun/designs/"+designID)
	if getSt != http.StatusOK {
		t.Fatalf("GET /designs/%s = %d: %s", designID, getSt, getBody)
	}
	if !bytes.Contains(getBody, []byte(parsed.FaviconURL)) {
		t.Errorf("GET design missing favicon_url %q: %s", parsed.FaviconURL, getBody)
	}
}
