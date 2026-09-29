package pocketbase

import (
	"fmt"
	"reflect"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// configureOAuth2 reconciles the Google login on the users collection with the
// deployment configuration on every startup, mirroring the SMTP settings reset
// in Run's OnBootstrap: credentials are environment state, not schema. A
// migration runs exactly once, so credentials that arrive after a first
// credential-less boot would never enable the provider and a rotated secret
// would strand a stale clientSecret in pb_data until the next schema change —
// a serve-time reconcile has neither problem.
//
// With no (or an incomplete) credential pair the provider stays switched off
// exactly like the 1766000000 migration baseline and password login keeps
// working; with both values set the google provider appears in
// GET /api/collections/users/auth-methods (endpoints, PKCE and scopes come
// from PocketBase's own Google defaults — only the client id/secret are
// stored, everything else is left empty on purpose).
//
// Once enabled, the client secret lives in the collection JSON inside pb_data
// (gitignored): keep pb_data out of repositories and shared backups.
func configureOAuth2(app core.App, cfg config.Config) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("load users collection: %w", err)
	}

	enabled := cfg.GoogleClientID != "" && cfg.GoogleClientSecret != ""
	var providers []core.OAuth2ProviderConfig
	if enabled {
		providers = []core.OAuth2ProviderConfig{{
			Name:         "google",
			ClientId:     cfg.GoogleClientID,
			ClientSecret: cfg.GoogleClientSecret,
		}}
	}

	if users.OAuth2.Enabled == enabled && oauth2ProvidersEqual(users.OAuth2.Providers, providers) {
		return nil // already in the configured state; no write, no churn
	}

	users.OAuth2.Enabled = enabled
	users.OAuth2.Providers = providers
	if err := app.Save(users); err != nil {
		return fmt.Errorf("save users collection: %w", err)
	}
	// Only the resulting state is logged — never the client id or secret.
	app.Logger().Info("users google login reconciled", "enabled", enabled)
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
