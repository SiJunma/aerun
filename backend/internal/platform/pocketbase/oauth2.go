package pocketbase

import (
	"fmt"
	"reflect"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// configureOAuth2 reconciles the Google login on the users collection with the
// deployment configuration on every startup.
//
// TWO OWNERSHIP MODES, mirroring the mail modes:
//
//   - A complete credential pair in the environment means the deployment opted
//     in explicitly: the google provider is FORCED on with those credentials on
//     every boot (a rotation in the env takes effect without touching pb_data).
//
//   - An empty (or incomplete) pair means the POCKETBASE ADMIN UI owns the
//     provider: the reconcile does nothing at all, so the operator can enable
//     and configure Google in the users collection's OAuth2 form and no
//     restart ever undoes it. This is the default-install path — no code, no
//     env edits. A migration runs exactly once, which is why the reconcile
//     exists at all: without it, credentials supplied after a credential-less
//     first boot would never enable the provider.
//
// With both values set the google provider appears in
// GET /api/collections/users/auth-methods (endpoints, PKCE and scopes come
// from PocketBase's own Google defaults — only the client id/secret are
// stored, everything else is left empty on purpose).
//
// Once enabled — by either owner — the client secret lives in the collection
// JSON inside pb_data (gitignored): keep pb_data out of repositories and
// shared backups.
func configureOAuth2(app core.App, cfg config.Config) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("load users collection: %w", err)
	}

	if cfg.GoogleClientID == "" || cfg.GoogleClientSecret == "" {
		// The admin UI owns the provider in this deployment. Touch nothing —
		// not even to read state into a log — so a dashboard configuration can
		// never be rolled back by a restart.
		return nil
	}

	providers := []core.OAuth2ProviderConfig{{
		Name:         "google",
		ClientId:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
	}}

	if users.OAuth2.Enabled && oauth2ProvidersEqual(users.OAuth2.Providers, providers) {
		return nil // already in the configured state; no write, no churn
	}

	users.OAuth2.Enabled = true
	users.OAuth2.Providers = providers
	if err := app.Save(users); err != nil {
		return fmt.Errorf("save users collection: %w", err)
	}
	// Only the resulting state is logged — never the client id or secret.
	app.Logger().Info("users google login reconciled", "enabled", true, "source", "environment")
	return nil
}

// oauth2ProvidersEqual compares the provider fields the reconcile owns; an
// empty slice and a nil slice count as equal so the disabled steady state does
// not rewrite the collection on every boot.
func oauth2ProvidersEqual(a, b []core.OAuth2ProviderConfig) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.Name != y.Name ||
			x.ClientId != y.ClientId ||
			x.ClientSecret != y.ClientSecret ||
			x.AuthURL != y.AuthURL ||
			x.TokenURL != y.TokenURL ||
			x.UserInfoURL != y.UserInfoURL ||
			x.DisplayName != y.DisplayName {
			return false
		}
		if (x.PKCE == nil) != (y.PKCE == nil) {
			return false
		}
		if x.PKCE != nil && *x.PKCE != *y.PKCE {
			return false
		}
		if !reflect.DeepEqual(x.Extra, y.Extra) {
			return false
		}
	}
	return true
}
