package pocketbase

// admin_users_rank_test.go pins the owner's authority ruling for the
// DESTRUCTIVE account actions — ban/unban (status writes) and soft-delete —
// on both the single and the bulk /admin/users endpoints:
//
//	the target must rank STRICTLY below the actor, and the chief admin
//	(root) is untouchable as a target: not for an admin, not even for root
//	itself. The role changes hands only through the transfer procedure.
//
// A refusal on a bulk target is a per-item "forbidden" that does not abort
// the other targets (§9.5 of SPEC_BULK_USER_MANAGEMENT.md).

import (
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// bulkAdminPeerTargetID is a second admin account created inline so the
// "strictly lower only" rule can be probed against an EQUAL rank.
const bulkAdminPeerTargetID = "userbulkadmin01"

// TestAdminBulkRankGuard pins the ruling on PATCH/DELETE /admin/users/bulk.
func TestAdminBulkRankGuard(t *testing.T) {
	cases := []struct {
		name          string
		actor         string
		method        string
		body          string
		expectStatus  int
		expectContent []string
	}{
		{
			name:          "admin bulk-bans root — the chief admin is untouchable",
			actor:         "admin",
			method:        http.MethodPatch,
			body:          `{"ids":["` + fixRootID + `"],"status":"banned"}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":0`, `"code":"forbidden"`},
		},
		{
			name:          "admin bulk-bans a peer admin — strictly lower only",
			actor:         "admin",
			method:        http.MethodPatch,
			body:          `{"ids":["` + bulkAdminPeerTargetID + `"],"status":"banned"}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":0`, `"code":"forbidden"`},
		},
		{
			name:          "admin bulk-deletes root — untouchable for delete too",
			actor:         "admin",
			method:        http.MethodDelete,
			body:          `{"ids":["` + fixRootID + `"]}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":0`, `"code":"forbidden"`},
		},
		{
			name:          "admin bulk-deletes a peer admin — refused",
			actor:         "admin",
			method:        http.MethodDelete,
			body:          `{"ids":["` + bulkAdminPeerTargetID + `"]}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":0`, `"code":"forbidden"`},
		},
		{
			name:          "root bulk-bans a moderator — strictly below, allowed",
			actor:         "root",
			method:        http.MethodPatch,
			body:          `{"ids":["` + fixModeratorID + `"],"status":"banned"}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":1`},
		},
		{
			name:          "root bulk-deletes a moderator — allowed",
			actor:         "root",
			method:        http.MethodDelete,
			body:          `{"ids":["` + fixModeratorID + `"]}`,
			expectStatus:  http.StatusOK,
			expectContent: []string{`"processed":1`, `"succeeded":1`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:            tc.name,
				Method:          tc.method,
				URL:             "/api/aerun/admin/users/bulk",
				Body:            strings.NewReader(tc.body),
				TestAppFactory:  newAerunTestApp,
				ExpectedStatus:  tc.expectStatus,
				ExpectedContent: tc.expectContent,
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				headers := map[string]string{}
				tokens := seedIdentityFixtures(t, app)
				// The admin ACTOR is not in the standard fixture matrix; the
				// peer-admin TARGET is created for every case that names it.
				headers["Authorization"] = createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
				createTestUser(t, app, bulkAdminPeerTargetID, "admin2@example.com", "AdminTwo", auth.RoleAdmin, auth.StatusActive)
				if tc.actor == "root" {
					headers["Authorization"] = tokens["root"]
				}
				headers["Idempotency-Key"] = "bulk-rank-guard-" + idempotencyKeyFromName(tc.name)
				scenario.Headers = headers
			}
			scenario.Test(t)
		})
	}
}

// TestAdminUserTargetAuthority pins the same ruling on the SINGLE
// /admin/users/{id} endpoints: an admin can neither ban nor delete the chief
// admin, and nobody can ban or delete their own account through the panel.
func TestAdminUserTargetAuthority(t *testing.T) {
	cases := []struct {
		name         string
		actor        string
		method       string
		targetID     string
		body         string
		expectStatus int
		content      string
	}{
		{
			name:         "admin cannot ban root via single PATCH",
			actor:        "admin",
			method:       http.MethodPatch,
			targetID:     fixRootID,
			body:         `{"status":"banned"}`,
			expectStatus: http.StatusForbidden,
			content:      "chief admin account cannot be banned",
		},
		{
			name:         "admin cannot delete root via single DELETE",
			actor:        "admin",
			method:       http.MethodDelete,
			targetID:     fixRootID,
			body:         ``,
			expectStatus: http.StatusForbidden,
			content:      "chief admin account cannot be banned",
		},
		{
			name:         "admin cannot ban own account via single PATCH",
			actor:        "admin",
			method:       http.MethodPatch,
			targetID:     fixAdminID,
			body:         `{"status":"banned"}`,
			expectStatus: http.StatusForbidden,
			content:      "cannot ban or unban your own account",
		},
		{
			name:         "admin cannot delete own account via single DELETE",
			actor:        "admin",
			method:       http.MethodDelete,
			targetID:     fixAdminID,
			body:         ``,
			expectStatus: http.StatusForbidden,
			content:      "cannot delete your own account",
		},
		{
			name:         "root cannot ban own account via single PATCH",
			actor:        "root",
			method:       http.MethodPatch,
			targetID:     fixRootID,
			body:         `{"status":"banned"}`,
			expectStatus: http.StatusForbidden,
			content:      "cannot ban or unban your own account",
		},
		{
			name:         "root cannot delete own account via single DELETE",
			actor:        "root",
			method:       http.MethodDelete,
			targetID:     fixRootID,
			body:         ``,
			expectStatus: http.StatusForbidden,
			content:      "cannot delete your own account",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scenario := tests.ApiScenario{
				Name:           tc.name,
				Method:         tc.method,
				URL:            "/api/aerun/admin/users/" + tc.targetID,
				Body:           strings.NewReader(tc.body),
				TestAppFactory: newAerunTestApp,
				ExpectedStatus: tc.expectStatus,
				ExpectedContent: func() []string {
					if tc.content == "" {
						return nil
					}
					return []string{tc.content}
				}(),
			}
			scenario.BeforeTestFunc = func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
				headers := map[string]string{}
				tokens := seedIdentityFixtures(t, app)
				headers["Authorization"] = createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
				if tc.actor == "root" {
					headers["Authorization"] = tokens["root"]
				}
				headers["Idempotency-Key"] = "single-rank-guard-" + idempotencyKeyFromName(tc.name)
				scenario.Headers = headers
			}
			scenario.Test(t)
		})
	}
}

// idempotencyKeyFromName turns a subtest name into a header-safe
// Idempotency-Key: only [A-Za-z0-9_.:-] is allowed, everything else
// (em dashes, commas) collapses to a dash.
func idempotencyKeyFromName(name string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '.', r == ':', r == '-':
			return r
		}
		return '-'
	}, strings.ReplaceAll(name, " ", "-"))
}
