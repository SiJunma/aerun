package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func postAerunWithHeaders(t testing.TB, path, body string, headers map[string]string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, payload
}

func TestCatalogAndBootstrapEndpointsAccess(t *testing.T) {

	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. GET /roles - anonymous caller must succeed (200 OK)
	t.Run("GET /roles anonymous access", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/roles")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("failed to decode /roles: %v", err)
		}
		if len(resp.Items) == 0 {
			t.Fatalf("expected seeded system roles in response, got 0")
		}
		foundPlayer := false
		for _, item := range resp.Items {
			if item["role_id"] == "player" {
				foundPlayer = true
				break
			}
		}
		if !foundPlayer {
			t.Fatalf("seeded roles must contain 'player'")
		}
	})

	// 2. GET /designs - anonymous caller must succeed (200 OK)
	t.Run("GET /designs anonymous access", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/designs")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp struct {
			Items []map[string]any `json:"items"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("failed to decode /designs: %v", err)
		}
		if resp.Items == nil {
			t.Fatalf("expected items array, got nil")
		}
	})

	// 3. GET /category-groups - anonymous caller must succeed (200 OK)
	t.Run("GET /category-groups honest 200", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/category-groups")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp struct {
			Items     []map[string]any `json:"items"`
			Available bool             `json:"available"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("failed to decode /category-groups: %v", err)
		}
		if resp.Items == nil {
			t.Fatalf("expected items array, got nil")
		}
	})
	// 4. Role mutation permissions
	t.Run("POST /roles permission check", func(t *testing.T) {
		payload := `{"role_id":"custom_role","name":"Custom Role","rank":100,"color":"secondary","permissions":["view_forum"]}`

		// Anonymous unauthorized
		status, _ := postAerun(t, ts.URL+"/api/aerun/roles", payload, "")
		if status != http.StatusUnauthorized {
			t.Fatalf("expected 401 for anonymous, got %d", status)
		}

		// Regular player forbidden
		status, _ = postAerun(t, ts.URL+"/api/aerun/roles", payload, tokens["player"])
		if status != http.StatusForbidden {
			t.Fatalf("expected 403 for player, got %d", status)
		}

		// Root admin creates successfully
		status, body := postAerunWithHeaders(t, ts.URL+"/api/aerun/roles", payload, map[string]string{
			"Authorization":   tokens["root"],
			"Idempotency-Key": "test-idem-role-create-1",
		})
		if status != http.StatusCreated {
			t.Fatalf("expected 201 for root, got %d: %s", status, body)
		}
	})

	// 5. Design creation & public retrieval
	t.Run("POST /designs and GET /designs", func(t *testing.T) {
		payload := `{"name":"Dark Cyberpunk","description":"Neon theme","css":".body { color: cyan; }","is_active":true}`

		// Player forbidden
		status, _ := postAerunWithHeaders(t, ts.URL+"/api/aerun/designs", payload, map[string]string{
			"Authorization":   tokens["player"],
			"Idempotency-Key": "test-idem-design-player-1",
		})
		if status != http.StatusForbidden {
			t.Fatalf("expected 403 for player, got %d", status)
		}

		// Root created
		status, body := postAerunWithHeaders(t, ts.URL+"/api/aerun/designs", payload, map[string]string{
			"Authorization":   tokens["root"],
			"Idempotency-Key": "test-idem-design-root-1",
		})
		if status != http.StatusCreated {
			t.Fatalf("expected 201 for root, got %d: %s", status, body)
		}
		var created map[string]any
		_ = json.Unmarshal(body, &created)
		designID := created["id"].(string)

		// Public get one design
		status, getBody := getAerun(t, ts.URL+"/api/aerun/designs/"+designID)
		if status != http.StatusOK {
			t.Fatalf("expected 200 for public GET design, got %d: %s", status, getBody)
		}

		// Public list designs includes new design
		status, listBody := getAerun(t, ts.URL+"/api/aerun/designs")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d", status)
		}
		if !strings.Contains(string(listBody), "Dark Cyberpunk") {
			t.Fatalf("list designs must include created design: %s", listBody)
		}
	})

	// 6. GET /status consolidation endpoint
	t.Run("GET /status consolidates health and presence", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/status")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var statusResp struct {
			Status   string `json:"status"`
			Presence struct {
				Users       []any `json:"users"`
				GuestsCount int   `json:"guests_count"`
				TotalOnline int   `json:"total_online"`
			} `json:"presence"`
		}
		if err := json.Unmarshal(body, &statusResp); err != nil {
			t.Fatalf("failed to decode /status: %v", err)
		}
		if statusResp.Status != "pass" {
			t.Fatalf("expected status 'pass', got %q", statusResp.Status)
		}

		// Heartbeat also returns presence state
		guestBeatStatus, guestBeatBody := postAerun(t, ts.URL+"/api/aerun/presence/heartbeat", `{"guest_id":"catalogtestguest1"}`, "")
		if guestBeatStatus != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", guestBeatStatus, guestBeatBody)
		}
		if !strings.Contains(string(guestBeatBody), `"presence"`) {
			t.Fatalf("heartbeat response must include presence snapshot: %s", guestBeatBody)
		}
	})
}

