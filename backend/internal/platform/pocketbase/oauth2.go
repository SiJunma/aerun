package pocketbase

import (
	"fmt"
	"reflect"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

// configureOAuth2 reconciles the Google login on the users collection with the
// database secrets (forum_settings) and deployment environment on startup.
//
// Precedence:
//  1. Complete GoogleClientID + GoogleClientSecret stored in `forum_settings` (DB).
//  2. Complete GoogleClientID + GoogleClientSecret in `cfg` (env fallback/seed).
//  3. Neither set -> leave `users.OAuth2` untouched (PocketBase Admin UI ownership).
func configureOAuth2(app core.App, cfg config.Config) error {
	var dbID, dbSecret string
	if rec, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID); err == nil && rec != nil {
		dbID = strings.TrimSpace(rec.GetString("google_client_id"))
		dbSecret = strings.TrimSpace(rec.GetString("google_client_secret"))
	}

	if dbID != "" && dbSecret != "" {
		return applyGoogleOAuth2(app, dbID, dbSecret, "database")
	}

	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" {
		return applyGoogleOAuth2(app, cfg.GoogleClientID, cfg.GoogleClientSecret, "environment")
	}

	return nil
}

func applyGoogleOAuth2(app core.App, clientID, clientSecret, source string) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("load users collection: %w", err)
	}

	providers := []core.OAuth2ProviderConfig{{
		Name:         "google",
		ClientId:     clientID,
		ClientSecret: clientSecret,
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
	app.Logger().Info("users google login reconciled", "enabled", true, "source", source)
	return nil
}

func clearGoogleOAuth2(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("load users collection: %w", err)
	}
	if !users.OAuth2.Enabled && len(users.OAuth2.Providers) == 0 {
		return nil
	}
	users.OAuth2.Enabled = false
	users.OAuth2.Providers = nil
	if err := app.Save(users); err != nil {
		return fmt.Errorf("save users collection: %w", err)
	}
	app.Logger().Info("users google login disabled", "source", "database")
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
