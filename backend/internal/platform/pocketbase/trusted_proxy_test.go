package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// TestConfigureTrustedProxy_RealIP covers the production proxy chain:
// without TrustedProxy configured, RealIP() falls back to the direct TCP
// peer (Caddy on 127.0.0.1), so every visit recorded ip 127.0.0.1 and GeoIP
// returned XX / Local Network for real visitors (observed 2026-11-25).
//
// The cases use TEST-NET documentation addresses (RFC 5737), which never
// belong to a real visitor.
func TestConfigureTrustedProxy_RealIP(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	if err := configureTrustedProxy(app); err != nil {
		t.Fatalf("configureTrustedProxy: %v", err)
	}
	settings := app.Settings()
	if len(settings.TrustedProxy.Headers) != 2 ||
		settings.TrustedProxy.Headers[0] != "CF-Connecting-IP" ||
		settings.TrustedProxy.Headers[1] != "X-Forwarded-For" {
		t.Fatalf("trusted headers = %v, want [CF-Connecting-IP X-Forwarded-For]", settings.TrustedProxy.Headers)
	}
	if settings.TrustedProxy.UseLeftmostIP {
		t.Fatal("UseLeftmostIP must stay false: the leftmost X-Forwarded-For entry can be client-supplied")
	}
	// Second call must be a no-op (no write, no churn).
	if err := configureTrustedProxy(app); err != nil {
		t.Fatalf("configureTrustedProxy (second call): %v", err)
	}

	cases := []struct {
		name      string
		sessionID string
		headers   map[string]string
		wantIP    string
	}{
		{
			// The normal production path: Cloudflare sets CF-Connecting-IP
			// to the real visitor IP; the X-Forwarded-For chain behind it
			// (visitor, Cloudflare edge) must NOT win.
			name:      "CF-Connecting-IP wins over X-Forwarded-For",
			sessionID: "sesscf000000001",
			headers: map[string]string{
				"CF-Connecting-IP": "203.0.113.7",
				"X-Forwarded-For":  "198.51.100.9, 203.0.113.1",
			},
			wantIP: "203.0.113.7",
		},
		{
			// Direct-to-Caddy fallback (no Cloudflare): Caddy appends the
			// real peer IP last, so the rightmost entry is the client.
			name:      "X-Forwarded-For rightmost without Cloudflare",
			sessionID: "sessxff00000001",
			headers: map[string]string{
				"X-Forwarded-For": "198.51.100.9, 203.0.113.1",
			},
			wantIP: "203.0.113.1",
		},
		{
			// No proxy headers at all: the direct peer (the test server
			// client on loopback) is the only IP there is.
			name:      "no proxy headers falls back to RemoteIP",
			sessionID: "sessnohdr000001",
			headers:   nil,
			wantIP:    "127.0.0.1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(
				`{"session_id":%q,"guest_id":%q,"entry_path":"/","referrer":""}`,
				tc.sessionID, "guest"+tc.sessionID[4:],
			)
			req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/telemetry/visit", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != http.StatusOK {
				t.Fatalf("expected 200, got %d", res.StatusCode)
			}

			records, err := app.FindRecordsByFilter(visitsCollectionName, "session_id = '"+tc.sessionID+"'", "", 1, 0)
			if err != nil {
				t.Fatalf("query visits: %v", err)
			}
			if len(records) != 1 {
				t.Fatalf("expected 1 visit record, got %d", len(records))
			}
			if got := records[0].GetString("ip"); got != tc.wantIP {
				t.Fatalf("visit ip = %q, want %q", got, tc.wantIP)
			}
		})
	}
}
