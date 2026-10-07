package pocketbase

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// TestConfigureOAuth2ReconcilesGoogleLogin pins the serve-time contract: the
// migration baseline keeps OAuth2 disabled, a complete credential pair enables
// exactly the google provider without disturbing password auth or the mapped
// fields, and — the ownership rule shared with the mail modes — an absent or
// incomplete pair means the ADMIN UI owns the provider, so the reconcile must
// not touch the collection at all.
func TestConfigureOAuth2ReconcilesGoogleLogin(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	// NewTestApp applies RunAllMigrations, so this is exactly the state the
	// production process starts from.
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	if users.OAuth2.Enabled {
		t.Fatal("migration baseline must keep OAuth2 disabled")
	}

	pair := config.Config{
		GoogleClientID:     "test-client-id.apps.googleusercontent.com",
		GoogleClientSecret: "GOCSPX-test-secret",
	}

	// An empty environment is the DEFAULT-INSTALL path: the admin UI owns the
	// provider, and the reconcile must leave the collection exactly as the
	// operator configured it — enabling Google there must survive restarts.
	if err := configureOAuth2(app, config.Config{}); err != nil {
		t.Fatalf("credential-less reconcile must succeed: %v", err)
	}
	users.OAuth2.Enabled = true
	users.OAuth2.Providers = []core.OAuth2ProviderConfig{{
		Name:         "google",
		ClientId:     "dashboard-client-id.apps.googleusercontent.com",
		ClientSecret: "dashboard-secret",
	}}
	if err := app.Save(users); err != nil {
		t.Fatal(err)
	}
	if err := configureOAuth2(app, config.Config{}); err != nil {
		t.Fatalf("credential-less reconcile after a dashboard config must succeed: %v", err)
	}
	users = reloadUsers(t, app)
	if !users.OAuth2.Enabled || len(users.OAuth2.Providers) != 1 ||
		users.OAuth2.Providers[0].ClientId != "dashboard-client-id.apps.googleusercontent.com" {
		t.Fatalf("dashboard configuration must survive a credential-less restart, got %+v", users.OAuth2)
	}

	if err := configureOAuth2(app, pair); err != nil {
		t.Fatalf("enabling reconcile must succeed: %v", err)
	}
	users = reloadUsers(t, app)
	if !users.OAuth2.Enabled {
		t.Fatal("a complete credential pair must enable OAuth2")
	}
	if len(users.OAuth2.Providers) != 1 {
		t.Fatalf("exactly one provider must be configured, got %d", len(users.OAuth2.Providers))
	}
	provider := users.OAuth2.Providers[0]
	if provider.Name != "google" ||
		provider.ClientId != pair.GoogleClientID ||
		provider.ClientSecret != pair.GoogleClientSecret {
		t.Fatalf("unexpected provider config: %+v", provider)
	}
	// Everything else stays at the PocketBase Google defaults.
	if provider.AuthURL != "" || provider.TokenURL != "" || provider.UserInfoURL != "" {
		t.Fatalf("custom endpoints must not be set, got %+v", provider)
	}
	if !users.PasswordAuth.Enabled {
		t.Fatal("password auth must stay enabled alongside the provider")
	}
	if users.OAuth2.MappedFields.Name != "" || users.OAuth2.MappedFields.AvatarURL != "" {
		t.Fatalf("the migration's unmapped fields must survive the reconcile: %+v", users.OAuth2.MappedFields)
	}

	// A second run with the same state must be a no-op, not a failure.
	if err := configureOAuth2(app, pair); err != nil {
		t.Fatalf("idempotent reconcile must succeed: %v", err)
	}

	// A half pair is rejected by config.Load before this point; the reconcile
	// treats it as unconfigured — the admin UI keeps ownership — rather than
	// enabling a broken provider or wiping the env-configured one.
	if err := configureOAuth2(app, config.Config{GoogleClientID: pair.GoogleClientID}); err != nil {
		t.Fatalf("half pair reconcile must succeed: %v", err)
	}
	users = reloadUsers(t, app)
	if !users.OAuth2.Enabled || len(users.OAuth2.Providers) != 1 ||
		users.OAuth2.Providers[0].ClientSecret != pair.GoogleClientSecret {
		t.Fatalf("a half pair must leave the env-configured provider alone, got %+v", users.OAuth2)
	}
}

func reloadUsers(t *testing.T, app *tests.TestApp) *core.Collection {
	t.Helper()
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("reload users collection: %v", err)
	}
	return users
}
