package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// testIdemHeaders returns an Idempotency-Key header map for mutating test
// requests, matching the enforceIdempotency middleware requirement.
func testIdemHeaders() map[string]string {
	return map[string]string{idempotencyHeader: "test_idem_" + strings.Repeat("x", 20)}
}

// mergeHeaders merges two string maps, with b overriding a.
func mergeHeaders(a, b map[string]string) map[string]string {
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}


// TestAdminEmailTemplatesGetAccessMatrix pins the permission gate for the
// GET /api/aerun/admin/email-templates endpoint: only admin_access holders
// (root, admin) may read the wrapper; every other actor is refused.
func TestAdminEmailTemplatesGetAccessMatrix(t *testing.T) {
	cases := []struct {
		name          string
		actor         string
		expectStatus  int
		expectContent []string
	}{
		{"guest is unauthenticated", "", http.StatusUnauthorized, []string{`Authentication is required`}},
		{"player is forbidden", "player", http.StatusForbidden, []string{`You are not allowed`}},
		{"moderator is forbidden", "moderator", http.StatusForbidden, []string{`You are not allowed`}},
		{"root can read", "root", http.StatusOK, []string{`"wrapper":`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodGet,
				URL:             "/api/aerun/admin/email-templates",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: tc.expectContent,
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				tokens := seedIdentityFixtures(t, app)
				scenario.Headers = authHeader(tokens[tc.actor])
			}
			scenario.Test(t)
		})
	}
}

// TestAdminEmailTemplatesGetReturnsDefaultWrapper verifies that a fresh forum
// returns the built-in default wrapper and is_custom=false.
func TestAdminEmailTemplatesGetReturnsDefaultWrapper(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "GET returns default wrapper for a fresh forum",
		Method:         http.MethodGet,
		URL:            "/api/aerun/admin/email-templates",
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"is_custom":false`,
			`"wrapper":"`,
			`"default_wrapper":"`,
			`top-accent`,
			`brand-title`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		scenario.Headers = authHeader(seedIdentityFixtures(t, app)["root"])
	}
	scenario.Test(t)
}

// TestAdminEmailTemplatesPutSavesCustomWrapper verifies the PUT endpoint
// saves a custom wrapper, and the subsequent GET returns it with is_custom=true.
func TestAdminEmailTemplatesPutSavesCustomWrapper(t *testing.T) {
	customWrapper := `<html><head><title>{TITLE}</title></head><body><h1>{APP_NAME}</h1><div>{CONTENT}</div></body></html>`

	scenario := tests.ApiScenario{
		Name:           "PUT saves a custom wrapper",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/email-templates",
		Body:           strings.NewReader(`{"wrapper":"` + strings.ReplaceAll(customWrapper, `"`, `\"`) + `"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"is_custom":true`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		tokens := seedIdentityFixtures(t, app)
		scenario.Headers = mergeHeaders(authHeader(tokens["root"]), testIdemHeaders())
	}
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		// Verify the wrapper was actually persisted by reading it back.
		wrapper := loadEmailWrapper(app)
		if wrapper != customWrapper {
			t.Fatalf("loadEmailWrapper after PUT returned unexpected value:\ngot:  %s\nwant: %s", wrapper, customWrapper)
		}
	}
	scenario.Test(t)
}

// TestAdminEmailTemplatesPutRejectsWithoutContent verifies that a wrapper
// missing {CONTENT} is rejected.
func TestAdminEmailTemplatesPutRejectsWithoutContent(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "PUT rejects wrapper without {CONTENT}",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/email-templates",
		Body:           strings.NewReader(`{"wrapper":"<html><body>no content placeholder here</body></html>"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusBadRequest,
		ExpectedContent: []string{
			`{CONTENT}`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		tokens := seedIdentityFixtures(t, app)
		scenario.Headers = mergeHeaders(authHeader(tokens["root"]), testIdemHeaders())
	}
	scenario.Test(t)
}

// TestAdminEmailTemplatesPutResetToDefault verifies that sending an empty
// wrapper resets to the built-in default.
func TestAdminEmailTemplatesPutResetToDefault(t *testing.T) {
	customWrapper := `<html><head><title>{TITLE}</title></head><body><h1>{APP_NAME}</h1><div>{CONTENT}</div></body></html>`

	scenario := tests.ApiScenario{
		Name:           "PUT with empty wrapper resets to default",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/email-templates",
		Body:           strings.NewReader(`{"wrapper":""}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"is_custom":false`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		tokens := seedIdentityFixtures(t, app)
		scenario.Headers = mergeHeaders(authHeader(tokens["root"]), testIdemHeaders())

		// First, store a custom wrapper so there is something to reset.
		record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil {
			t.Fatalf("forum_settings row missing: %v", err)
		}
		stored := map[string]any{
			emailTemplateWrapper: map[string]any{
				"subject": "",
				"body":    customWrapper,
			},
		}
		raw, _ := json.Marshal(stored)
		record.Set("email_templates", types.JSONRaw(raw))
		if err := app.Save(record); err != nil {
			t.Fatalf("failed to seed custom wrapper: %v", err)
		}
		// Verify the custom wrapper is in effect before the reset.
		if w := loadEmailWrapper(app); w != customWrapper {
			t.Fatalf("pre-reset wrapper is not the custom one: %s", w)
		}
	}
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		// After reset, loadEmailWrapper must return the built-in default.
		wrapper := loadEmailWrapper(app)
		if wrapper != defaultEmailWrapper {
			t.Fatalf("wrapper after reset is not the default:\ngot length:  %d\nwant length: %d", len(wrapper), len(defaultEmailWrapper))
		}
	}
	scenario.Test(t)
}

// TestAdminEmailTemplatesPutPreservesOtherKeys verifies that saving a wrapper
// does not clobber other email_templates keys (dm, topic_reply).
func TestAdminEmailTemplatesPutPreservesOtherKeys(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:           "PUT preserves other email_templates keys",
		Method:         http.MethodPut,
		URL:            "/api/aerun/admin/email-templates",
		Body:           strings.NewReader(`{"wrapper":"<html>{CONTENT}</html>"}`),
		TestAppFactory: newAerunTestApp,
		ExpectedStatus: http.StatusOK,
		ExpectedContent: []string{
			`"is_custom":true`,
		},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		tokens := seedIdentityFixtures(t, app)
		scenario.Headers = mergeHeaders(authHeader(tokens["root"]), testIdemHeaders())

		// Seed existing dm and topic_reply entries.
		record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil {
			t.Fatalf("forum_settings row missing: %v", err)
		}
		stored := map[string]any{
			"dm": map[string]any{
				"subject": "Custom DM subject",
				"body":    "Custom DM body",
			},
		}
		raw, _ := json.Marshal(stored)
		record.Set("email_templates", types.JSONRaw(raw))
		if err := app.Save(record); err != nil {
			t.Fatalf("failed to seed existing templates: %v", err)
		}
	}
	scenario.AfterTestFunc = func(t testing.TB, app *tests.TestApp, res *http.Response) {
		// Read the raw stored JSON and verify the "dm" key survived.
		record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil {
			t.Fatalf("forum_settings row missing after PUT: %v", err)
		}
		rawVal := record.Get("email_templates")
		var rawStr string
		switch v := rawVal.(type) {
		case string:
			rawStr = v
		case types.JSONRaw:
			rawStr = string(v)
		case []byte:
			rawStr = string(v)
		}

		var stored map[string]any
		if err := json.Unmarshal([]byte(rawStr), &stored); err != nil {
			t.Fatalf("stored email_templates is not valid JSON: %v", err)
		}
		if _, ok := stored["dm"]; !ok {
			t.Fatal("PUT clobbered the existing 'dm' key in email_templates")
		}
		if _, ok := stored[emailTemplateWrapper]; !ok {
			t.Fatal("PUT did not write the 'wrapper' key in email_templates")
		}
	}
	scenario.Test(t)
}

// TestAdminEmailTemplatesTestEndpointAccessMatrix verifies that only admins
// can use the test endpoint.
func TestAdminEmailTemplatesTestEndpointAccessMatrix(t *testing.T) {
	cases := []struct {
		name          string
		actor         string
		expectStatus  int
		expectContent []string
	}{
		{"guest is unauthenticated", "", http.StatusUnauthorized, []string{`Authentication is required`}},
		{"player is forbidden", "player", http.StatusForbidden, []string{`You are not allowed`}},
		{"moderator is forbidden", "moderator", http.StatusForbidden, []string{`You are not allowed`}},
		// Root should be able to call the test endpoint, but in test mode
		// mail is disabled (MailHardDisableGuard), so it will return 500.
		// That is correct — the permission gate passed, only the send failed.
		{"root passes the gate", "root", http.StatusInternalServerError, []string{`Test email could not be sent`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          http.MethodPost,
				URL:             "/api/aerun/admin/email-templates/test",
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: tc.expectContent,
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				tokens := seedIdentityFixtures(t, app)
				scenario.Headers = mergeHeaders(authHeader(tokens[tc.actor]), testIdemHeaders())
			}
			scenario.Test(t)
		})
	}
}

// TestAdminEmailTemplatesPutAccessForbiddenForNonAdmin verifies a non-admin
// cannot save email templates.
func TestAdminEmailTemplatesPutAccessForbiddenForNonAdmin(t *testing.T) {
	scenario := tests.ApiScenario{
		Name:            "player cannot PUT email templates",
		Method:          http.MethodPut,
		URL:             "/api/aerun/admin/email-templates",
		Body:            strings.NewReader(`{"wrapper":"<html>{CONTENT}</html>"}`),
		TestAppFactory:  newAerunTestApp,
		ExpectedStatus:  http.StatusForbidden,
		ExpectedContent: []string{`You are not allowed`},
	}
	scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
		tokens := seedIdentityFixtures(t, app)
		scenario.Headers = mergeHeaders(authHeader(tokens["player"]), testIdemHeaders())
	}
	scenario.Test(t)
}
