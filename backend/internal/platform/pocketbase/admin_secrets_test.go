package pocketbase

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// buildMinimalTestMMDB constructs a tiny valid MaxMind DB v2.0 binary that
// geoip2.Open accepts without requiring an external .mmdb fixture in the repo.
func buildMinimalTestMMDB() []byte {
	var buf bytes.Buffer
	// Search tree: 1 node * 6 bytes (record_size 24 => 2 * 3 bytes), pointing to data section (node_count = 1).
	buf.Write([]byte{0, 0, 1, 0, 0, 1})
	// 16-byte null separator between search tree and data section.
	buf.Write(make([]byte, 16))
	// Metadata marker.
	buf.Write([]byte{0xab, 0xcd, 0xef})
	buf.WriteString("MaxMind.com")

	// Encode metadata map with 6 entries in MaxMind DB binary format:
	// type 7 (map), size 6 => 0xe6 (7<<5 | 6)
	writeUTF8 := func(s string) {
		b := []byte(s)
		if len(b) < 29 {
			buf.WriteByte(byte((2 << 5) | len(b)))
		} else {
			buf.WriteByte(byte((2 << 5) | 29))
			buf.WriteByte(byte(len(b) - 29))
		}
		buf.Write(b)
	}
	writeUint16 := func(v uint16) {
		if v == 0 {
			buf.WriteByte(byte(5 << 5))
			return
		}
		if v <= 0xff {
			buf.WriteByte(byte((5 << 5) | 1))
			buf.WriteByte(byte(v))
			return
		}
		buf.WriteByte(byte((5 << 5) | 2))
		buf.WriteByte(byte(v >> 8))
		buf.WriteByte(byte(v & 0xff))
	}

	buf.WriteByte(byte((7 << 5) | 6))
	writeUTF8("node_count")
	buf.WriteByte(byte((6 << 5) | 1)) // uint32 len 1
	buf.WriteByte(1)
	writeUTF8("record_size")
	writeUint16(24)
	writeUTF8("ip_version")
	writeUint16(4)
	writeUTF8("binary_format_major_version")
	writeUint16(2)
	writeUTF8("binary_format_minor_version")
	writeUint16(0)
	writeUTF8("database_type")
	writeUTF8("GeoLite2-City")

	return buf.Bytes()
}

func buildTestMMDBTarGz(t *testing.T, mmdbBytes []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{
		Name: "GeoLite2-City_20261124/GeoLite2-City.mmdb",
		Mode: 0o644,
		Size: int64(len(mmdbBytes)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(mmdbBytes); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gz close: %v", err)
	}
	return out.Bytes()
}

func TestAdminSecretsRBACAndPublicIsolation(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// 1. Access control: guest -> 401, player -> 403
	status, _ := getAerunAuthed(t, ts.URL+"/api/aerun/admin/secrets", "")
	if status != http.StatusUnauthorized {
		t.Fatalf("guest GET /admin/secrets expected 401, got %d", status)
	}
	status, _ = getAerunAuthed(t, ts.URL+"/api/aerun/admin/secrets", tokens["player"])
	if status != http.StatusForbidden {
		t.Fatalf("player GET /admin/secrets expected 403, got %d", status)
	}
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/secrets",
		`{"maxmind_license_key":"secret123"}`, tokens["player"], "idem-sec-player")
	if status != http.StatusForbidden {
		t.Fatalf("player PATCH /admin/secrets expected 403, got %d", status)
	}

	// 2. Root saves secrets into DB (MaxMind, Google OAuth2, SMTP, IP salt)
	payload := `{
		"maxmind_license_key": "mm_test_key_98765",
		"google_client_id": "client-id-123.apps.googleusercontent.com",
		"google_client_secret": "GOCSPX-super-secret-xyz",
		"smtp_enabled": true,
		"smtp_host": "smtp.example.org",
		"smtp_port": 587,
		"smtp_username": "mailer@example.org",
		"smtp_password": "smtp-secret-password",
		"smtp_auth_method": "LOGIN",
		"smtp_tls": true,
		"mail_sender_address": "noreply@example.org",
		"mail_sender_name": "Aerun Mailer",
		"ip_hash_salt": "custom-db-salt-value"
	}`
	status, body, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/secrets",
		payload, tokens["root"], "idem-sec-save-1")
	if status != http.StatusOK {
		t.Fatalf("root PATCH /admin/secrets expected 200, got %d: %s", status, body)
	}

	var saveResp struct {
		Secrets map[string]any `json:"secrets"`
	}
	if err := json.Unmarshal(body, &saveResp); err != nil {
		t.Fatalf("decode save resp: %v", err)
	}
	if saveResp.Secrets["has_maxmind_license_key"] != true || saveResp.Secrets["maxmind_license_key_masked"] != "****8765" {
		t.Fatalf("unexpected masked maxmind status: %#v", saveResp.Secrets)
	}
	if strings.Contains(string(body), "mm_test_key_98765") ||
		strings.Contains(string(body), "GOCSPX-super-secret-xyz") ||
		strings.Contains(string(body), "smtp-secret-password") ||
		strings.Contains(string(body), "custom-db-salt-value") {
		t.Fatalf("raw secret leaked in GET/PATCH response: %s", body)
	}

	// 3. Public settings endpoint must NEVER contain any secret keys or values.
	pubStatus, pubBody := getAerunAuthed(t, ts.URL+"/api/aerun/settings", "")
	if pubStatus != http.StatusOK {
		t.Fatalf("GET /settings expected 200, got %d", pubStatus)
	}
	for _, forbidden := range []string{
		"maxmind", "mm_test_key_98765",
		"google_client_secret", "GOCSPX-super-secret-xyz",
		"smtp_password", "smtp-secret-password",
		"ip_hash_salt", "custom-db-salt-value",
	} {
		if strings.Contains(string(pubBody), forbidden) {
			t.Fatalf("public /settings leaked %q: %s", forbidden, pubBody)
		}
	}

	// 4. Google OAuth2 survives startup reconcile from DB even with empty env config!
	if err := configureOAuth2(app, config.Config{}); err != nil {
		t.Fatalf("configureOAuth2 failed: %v", err)
	}
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("load users: %v", err)
	}
	if !usersCol.OAuth2.Enabled || len(usersCol.OAuth2.Providers) != 1 ||
		usersCol.OAuth2.Providers[0].ClientId != "client-id-123.apps.googleusercontent.com" ||
		usersCol.OAuth2.Providers[0].ClientSecret != "GOCSPX-super-secret-xyz" {
		t.Fatalf("expected DB-configured Google OAuth2 to survive restart, got %+v", usersCol.OAuth2)
	}

	// 5. DB ip_hash_salt is honored by hashIPWithApp
	if hashIPWithApp(app, "198.51.100.1") == hashIP("198.51.100.1") {
		t.Fatal("expected DB ip_hash_salt to override fallback salt")
	}
}

func TestDownloadGeoIPFromDBKey(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	setGeoIPDataDir(app.DataDir())
	defer CloseGeoIP()

	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// Without key -> 400
	status, body, _ := categoryCall(t, http.MethodPost, ts.URL+"/api/aerun/admin/geoip/download",
		`{}`, tokens["root"], "idem-geoip-no-key")
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 when maxmind key missing, got %d: %s", status, body)
	}

	// Store key in DB
	const testKey = "db_maxmind_key_xyz"
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/secrets",
		`{"maxmind_license_key":"`+testKey+`"}`, tokens["root"], "idem-geoip-set-key")
	if status != http.StatusOK {
		t.Fatalf("save maxmind key failed: %d", status)
	}

	tarGzBytes := buildTestMMDBTarGz(t, buildMinimalTestMMDB())
	var receivedKey string
	mockMaxMind := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedKey = r.URL.Query().Get("license_key")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(tarGzBytes)
	}))
	defer mockMaxMind.Close()

	prevBaseURL := geoIPDownloadBaseURL
	geoIPDownloadBaseURL = mockMaxMind.URL
	defer func() { geoIPDownloadBaseURL = prevBaseURL }()

	status, body, _ = categoryCall(t, http.MethodPost, ts.URL+"/api/aerun/admin/geoip/download",
		`{}`, tokens["root"], "idem-geoip-dl-1")
	if status != http.StatusOK {
		t.Fatalf("expected 200 downloading geoip, got %d: %s", status, body)
	}
	if receivedKey != testKey {
		t.Fatalf("expected downloader to send DB key %q, got %q", testKey, receivedKey)
	}

	expectedPath := filepath.Join(app.DataDir(), "geoip", "GeoLite2-City.mmdb")
	if !geoIPDatabaseExists(app.DataDir()) {
		t.Fatalf("expected GeoIP DB to exist at %s", expectedPath)
	}
}
