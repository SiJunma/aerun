package migrations

// 1781000005_admin_secrets_settings.go adds secret and integration columns to the
// server-only `forum_settings` singleton collection so sensitive API keys (starting
// with the MaxMind license key, Google OAuth2 credentials, and optional IP hash
// salt) live in the database and are managed through the Admin Panel instead of
// internal env files.
//
// `forum_settings` already has ListRule = nil, ViewRule = nil, CreateRule = nil,
// UpdateRule = nil, DeleteRule = nil, and `globalSettingsSnapshot` uses an explicit
// allowlist — so guests and non-admin members can never read these columns.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyAdminSecretsSettings, revertAdminSecretsSettings)
}

func adminSecretsFields() []core.Field {
	return []core.Field{
		&core.TextField{Name: "maxmind_license_key", Max: 512},
		&core.TextField{Name: "geoip_updated_at", Max: 64},
		&core.TextField{Name: "google_client_id", Max: 512},
		&core.TextField{Name: "google_client_secret", Max: 512},
		&core.TextField{Name: "ip_hash_salt", Max: 256},
	}
}

func applyAdminSecretsSettings(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return err
	}

	added := false
	for _, field := range adminSecretsFields() {
		if col.Fields.GetByName(field.GetName()) == nil {
			col.Fields.Add(field)
			added = true
		}
	}
	if added {
		if err := app.Save(col); err != nil {
			return fmt.Errorf("add admin secrets fields to forum_settings: %w", err)
		}
	}
	return nil
}

func revertAdminSecretsSettings(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil || col == nil {
		return nil
	}

	removed := false
	for _, field := range adminSecretsFields() {
		if existing := col.Fields.GetByName(field.GetName()); existing != nil {
			col.Fields.RemoveById(existing.GetId())
			removed = true
		}
	}
	if removed {
		return app.Save(col)
	}
	return nil
}
