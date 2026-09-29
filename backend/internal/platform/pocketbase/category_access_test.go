package pocketbase

// Tests for the ADR-1/ADR-2 category visibility contract.
//
// The matrix below is deliberately about the *reader*, not the handler: the bug
// this replaced was "empty list means public", which cannot be observed through
// a happy-path request. Each case states a rule a reader could plausibly get
// wrong, and the assertion is on the answer rather than on the code path.

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// newTestCategory creates a category row with an explicit allowed_roles list.
// `nil` writes no list at all, which is the "absent" case ADR-1 denies.
func newTestCategory(t testing.TB, app *tests.TestApp, slug string, roles []string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		t.Fatalf("categories collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("name", slug)
	rec.Set("slug", slug)
	if roles == nil {
		rec.Set("allowed_roles", nil)
	} else {
		rec.Set("allowed_roles", roles)
	}
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to create category %s: %v", slug, err)
	}
	return rec
}

func TestCanViewCategoryMatrix(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	emptyList := newTestCategory(t, app, "root-only", nil)
	restricted := newTestCategory(t, app, "restricted", []string{"admin", "moderator"})
	publicCat := newTestCategory(t, app, "public", []string{"guest", "player", "moderator", "admin", "root"})
	customOnly := newTestCategory(t, app, "custom-only", []string{"demon"})

	cases := []struct {
		name  string
		acc   AccessContext
		catID string
		want  bool
		why   string
	}{
		{
			name:  "root bypasses an empty list",
			acc:   AccessContext{Role: auth.RoleRoot, Status: auth.StatusActive},
			catID: emptyList.Id,
			want:  true,
			why:   "ADR-1 grants root the only bypass, including on root-only categories",
		},
		{
			name:  "banned root is denied",
			acc:   AccessContext{Role: auth.RoleRoot, Status: auth.StatusBanned},
			catID: emptyList.Id,
			want:  false,
			why:   "status outranks authority; the bypass is checked after the ban",
		},
		{
			name:  "empty list denies admin",
			acc:   AccessContext{Role: auth.RoleAdmin, Status: auth.StatusActive},
			catID: emptyList.Id,
			want:  false,
			why:   "ADR-1 reversed the pre-audit admin bypass; empty means root-only",
		},
		{
			name:  "empty list denies a player",
			acc:   AccessContext{Role: auth.RolePlayer, Status: auth.StatusActive},
			catID: emptyList.Id,
			want:  false,
			why:   "an absent list grants nobody",
		},
		{
			name:  "a listed admin is allowed",
			acc:   AccessContext{Role: auth.RoleAdmin, Status: auth.StatusActive},
			catID: restricted.Id,
			want:  true,
			why:   "membership is the whole rule; the resolved permission set is never consulted",
		},
		{
			name:  "a role outside the list is denied even with view_forum",
			acc:   AccessContext{Role: auth.RoleSpectator, Status: auth.StatusActive},
			catID: restricted.Id,
			want:  false,
			why:   "holding view_forum globally does not grant a category that does not name the role",
		},
		{
			name:  "moderator inside the restricted list is allowed",
			acc:   AccessContext{Role: auth.RoleModerator, Status: auth.StatusActive},
			catID: restricted.Id,
			want:  true,
			why:   "membership is tested against users.role",
		},
		{
			name:  "guest denied on a restricted category",
			acc:   AccessContext{Role: auth.RoleGuest, Status: auth.StatusActive},
			catID: restricted.Id,
			want:  false,
			why:   "guest is not listed",
		},
		{
			name:  "guest allowed on a public category",
			acc:   AccessContext{Role: auth.RoleGuest, Status: auth.StatusActive},
			catID: publicCat.Id,
			want:  true,
			why:   "a public category names every role, guest included",
		},
		{
			name:  "player allowed on a public category",
			acc:   AccessContext{Role: auth.RolePlayer, Status: auth.StatusActive},
			catID: publicCat.Id,
			want:  true,
			why:   "listed role",
		},
		{
			name:  "custom role denied when not listed",
			acc:   AccessContext{Role: auth.Role("demon"), Status: auth.StatusActive},
			catID: restricted.Id,
			want:  false,
			why:   "ADR-2: a custom role derives from a base but inherits nothing",
		},
		{
			name:  "custom role allowed when listed",
			acc:   AccessContext{Role: auth.Role("demon"), Status: auth.StatusActive},
			catID: customOnly.Id,
			want:  true,
			why:   "the admin names the custom role id directly, as the legacy data does",
		},
		{
			name:  "banned account denied even when listed",
			acc:   AccessContext{Role: auth.RoleGuest, Status: auth.StatusBanned},
			catID: publicCat.Id,
			want:  false,
			why:   "a ban cannot be argued around with a role list",
		},
		{
			name:  "missing category id is denied",
			acc:   AccessContext{Role: auth.RoleRoot, Status: auth.StatusActive},
			catID: "",
			want:  false,
			why:   "an empty id must never match a row",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canViewCategory(app, tc.acc, tc.catID)
			if err != nil {
				t.Fatalf("canViewCategory: %v", err)
			}
			if got != tc.want {
				t.Fatalf("canViewCategory = %v, want %v (%s)", got, tc.want, tc.why)
			}
		})
	}
}

func TestListCategoriesHidesUnreadable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secret := newTestCategory(t, app, "secret-section", nil)
	open := newTestCategory(t, app, "open-section", []string{"guest", "player", "admin", "root"})

	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("guest sees only the public category", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/categories")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		if bytes.Contains(body, []byte(secret.GetString("slug"))) {
			t.Fatalf("guest payload must not contain the root-only category: %s", body)
		}
		if !bytes.Contains(body, []byte(open.GetString("slug"))) {
			t.Fatalf("guest payload must contain the public category: %s", body)
		}
	})

	t.Run("root sees both", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/categories", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		for _, slug := range []string{secret.GetString("slug"), open.GetString("slug")} {
			if !bytes.Contains(body, []byte(slug)) {
				t.Fatalf("root payload must contain %s: %s", slug, body)
			}
		}
	})
}

// TestListCategoriesCarriesAllowedRoles pins the two fields the admin board needs
// to re-submit a category unchanged. Without them, opening a category for editing
// shows an empty role list and saving silently wipes the real one.
func TestListCategoriesCarriesAllowedRoles(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	cat := newTestCategory(t, app, "audited", []string{"admin", "moderator"})

	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/categories", tokens["root"])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	for _, expected := range []string{
		`"allowed_roles":["admin","moderator"]`,
		`"slug":"` + cat.GetString("slug") + `"`,
		`"group_id":""`,
	} {
		if !bytes.Contains(body, []byte(expected)) {
			t.Fatalf("category payload missing %s: %s", expected, body)
		}
	}
}
