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
// fields, an incomplete pair counts as unconfigured, and withdrawing the pair
// switches the provider back off.
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
	// treats it as unconfigured rather than enabling a broken provider.
	if err := configureOAuth2(app, config.Config{GoogleClientID: pair.GoogleClientID}); err != nil {
		t.Fatalf("half pair reconcile must succeed: %v", err)
	}
	users = reloadUsers(t, app)
	if users.OAuth2.Enabled || len(users.OAuth2.Providers) != 0 {
		t.Fatalf("a half pair must keep OAuth2 disabled, got enabled=%v providers=%d",
			users.OAuth2.Enabled, len(users.OAuth2.Providers))
	}

	// Full pair again, then withdrawal restores the disabled baseline.
	if err := configureOAuth2(app, pair); err != nil {
		t.Fatal(err)
	}
	if err := configureOAuth2(app, config.Config{}); err != nil {
		t.Fatalf("withdrawing credentials must succeed: %v", err)
	}
	users = reloadUsers(t, app)
	if users.OAuth2.Enabled || len(users.OAuth2.Providers) != 0 {
		t.Fatalf("withdrawing credentials must disable OAuth2, got enabled=%v providers=%d",
			users.OAuth2.Enabled, len(users.OAuth2.Providers))
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
