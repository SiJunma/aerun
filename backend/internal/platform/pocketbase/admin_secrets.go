package pocketbase

import (
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/config"
)

func maskSecret(val string) string {
	clean := strings.TrimSpace(val)
	if clean == "" {
		return ""
	}
	if len(clean) <= 4 {
		return "****"
	}
	return "****" + clean[len(clean)-4:]
}

func adminSecretsSnapshot(app core.App, cfg config.Config) map[string]any {
	var maxmindKey, geoipUpdatedAt, googleID, googleSecret, ipSalt string
	if rec, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID); err == nil && rec != nil {
		maxmindKey = strings.TrimSpace(rec.GetString("maxmind_license_key"))
		geoipUpdatedAt = strings.TrimSpace(rec.GetString("geoip_updated_at"))
		googleID = strings.TrimSpace(rec.GetString("google_client_id"))
		googleSecret = strings.TrimSpace(rec.GetString("google_client_secret"))
		ipSalt = strings.TrimSpace(rec.GetString("ip_hash_salt"))
	}

	// If Google OAuth was previously configured in PocketBase UI or env, reflect its Client ID.
	if googleID == "" || googleSecret == "" {
		if users, err := app.FindCollectionByNameOrId(usersCollectionName); err == nil && users != nil {
			for _, p := range users.OAuth2.Providers {
				if p.Name == "google" {
					if googleID == "" {
						googleID = strings.TrimSpace(p.ClientId)
					}
					if googleSecret == "" {
						googleSecret = strings.TrimSpace(p.ClientSecret)
					}
					break
				}
			}
		}
	}

	pbSettings := app.Settings()
	smtpHost := pbSettings.SMTP.Host
	if smtpHost == "smtp.example.com" && !pbSettings.SMTP.Enabled && pbSettings.SMTP.Username == "" {
		smtpHost = ""
	}
	senderAddr := pbSettings.Meta.SenderAddress
	if senderAddr == "support@example.com" || senderAddr == "no-reply@aerun.invalid" {
		senderAddr = ""
	}

	return map[string]any{
		"has_maxmind_license_key":     maxmindKey != "",
		"maxmind_license_key_masked":  maskSecret(maxmindKey),
		"geoip_db_exists":             geoIPDatabaseExists(app.DataDir()),
		"geoip_updated_at":            geoipUpdatedAt,
		"google_client_id":            googleID,
		"has_google_client_secret":    googleSecret != "",
		"google_client_secret_masked": maskSecret(googleSecret),
		"mail_mode":                   cfg.MailMode,
		"smtp_enabled":                pbSettings.SMTP.Enabled,
		"smtp_host":                   smtpHost,
		"smtp_port":                   pbSettings.SMTP.Port,
		"smtp_username":               pbSettings.SMTP.Username,
		"has_smtp_password":           strings.TrimSpace(pbSettings.SMTP.Password) != "",
		"smtp_password_masked":        maskSecret(pbSettings.SMTP.Password),
		"smtp_auth_method":            pbSettings.SMTP.AuthMethod,
		"smtp_tls":                    pbSettings.SMTP.TLS,
		"mail_sender_address":         senderAddr,
		"mail_sender_name":            pbSettings.Meta.SenderName,
		"has_ip_hash_salt":            ipSalt != "",
		"ip_hash_salt_masked":         maskSecret(ipSalt),
	}
}

// getAdminSecretsHandler returns the masked secrets & integrations state for admins.
// Requires PermManageForum; secrets never appear in the public GET /api/aerun/settings snapshot.
func getAdminSecretsHandler(cfg config.Config) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]any{
			"secrets":    adminSecretsSnapshot(e.App, cfg),
			"request_id": requestIDFrom(e),
		})
	}
}

// updateAdminSecretsHandler updates DB-stored API keys, OAuth2, and SMTP secrets.
// Requires PermManageForum and idempotency; audit logs record key names only, never values.
func updateAdminSecretsHandler(cfg config.Config) func(e *core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		claim, err := claimFrom(e)
		if err != nil {
			return err
		}

		body := struct {
			MaxMindLicenseKey  *string `json:"maxmind_license_key"`
			ClearMaxMindKey    *bool   `json:"clear_maxmind_license_key"`
			GoogleClientID     *string `json:"google_client_id"`
			GoogleClientSecret *string `json:"google_client_secret"`
			ClearGoogleOAuth   *bool   `json:"clear_google_oauth"`
			SMTPEnabled        *bool   `json:"smtp_enabled"`
			SMTPHost           *string `json:"smtp_host"`
			SMTPPort           *int    `json:"smtp_port"`
			SMTPUsername       *string `json:"smtp_username"`
			SMTPPassword       *string `json:"smtp_password"`
			ClearSMTPPassword  *bool   `json:"clear_smtp_password"`
			SMTPAuthMethod     *string `json:"smtp_auth_method"`
			SMTPTLS            *bool   `json:"smtp_tls"`
			MailSenderAddress  *string `json:"mail_sender_address"`
			MailSenderName     *string `json:"mail_sender_name"`
			IPHashSalt         *string `json:"ip_hash_salt"`
			ClearIPHashSalt    *bool   `json:"clear_ip_hash_salt"`
		}{}
		if err := e.BindBody(&body); err != nil {
			return validationError("invalid secrets payload")
		}

		smtpTouched := body.SMTPEnabled != nil || body.SMTPHost != nil || body.SMTPPort != nil ||
			body.SMTPUsername != nil || body.SMTPPassword != nil || body.ClearSMTPPassword != nil ||
			body.SMTPAuthMethod != nil || body.SMTPTLS != nil || body.MailSenderAddress != nil ||
			body.MailSenderName != nil

		if smtpTouched && cfg.MailMode == MailModeDisabled {
			return validationError("outgoing email is hard-disabled by AERUN_MAIL_MODE=disabled")
		}
		if body.SMTPPort != nil && (*body.SMTPPort < 0 || *body.SMTPPort > 65535) {
			return validationError("smtp_port must be between 0 and 65535")
		}
		if body.SMTPAuthMethod != nil {
			method := strings.ToUpper(strings.TrimSpace(*body.SMTPAuthMethod))
			if method != "" && method != "PLAIN" && method != "LOGIN" {
				return validationError("smtp_auth_method must be PLAIN or LOGIN")
			}
		}
		if body.MailSenderAddress != nil {
			addr := strings.TrimSpace(*body.MailSenderAddress)
			if addr != "" {
				if _, err := mail.ParseAddress(addr); err != nil {
					return validationError("mail_sender_address is invalid")
				}
			}
		}

		callerID := e.Auth.Id
		var nextGoogleID, nextGoogleSecret string
		var googleChanged bool

		outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
			changed := make([]string, 0, 12)

			record, err := txApp.FindRecordById(forumSettingsCollectionName, forumSettingsID)
			if err != nil || record == nil {
				return 0, nil, internalError("forum settings row is missing", err)
			}

			dbDirty := false
			if body.ClearMaxMindKey != nil && *body.ClearMaxMindKey {
				record.Set("maxmind_license_key", "")
				changed = append(changed, "maxmind_license_key")
				dbDirty = true
			} else if body.MaxMindLicenseKey != nil {
				if v := strings.TrimSpace(*body.MaxMindLicenseKey); v != "" {
					record.Set("maxmind_license_key", v)
					changed = append(changed, "maxmind_license_key")
					dbDirty = true
				}
			}

			if body.ClearGoogleOAuth != nil && *body.ClearGoogleOAuth {
				record.Set("google_client_id", "")
				record.Set("google_client_secret", "")
				changed = append(changed, "google_client_id", "google_client_secret")
				dbDirty = true
				googleChanged = true
			} else {
				if body.GoogleClientID != nil {
					record.Set("google_client_id", strings.TrimSpace(*body.GoogleClientID))
					changed = append(changed, "google_client_id")
					dbDirty = true
					googleChanged = true
				}
				if body.GoogleClientSecret != nil {
					if v := strings.TrimSpace(*body.GoogleClientSecret); v != "" {
						record.Set("google_client_secret", v)
						changed = append(changed, "google_client_secret")
						dbDirty = true
						googleChanged = true
					}
				}
			}
			nextGoogleID = strings.TrimSpace(record.GetString("google_client_id"))
			nextGoogleSecret = strings.TrimSpace(record.GetString("google_client_secret"))

			if body.ClearIPHashSalt != nil && *body.ClearIPHashSalt {
				record.Set("ip_hash_salt", "")
				changed = append(changed, "ip_hash_salt")
				dbDirty = true
			} else if body.IPHashSalt != nil {
				if v := strings.TrimSpace(*body.IPHashSalt); v != "" {
					record.Set("ip_hash_salt", v)
					changed = append(changed, "ip_hash_salt")
					dbDirty = true
				}
			}

			if dbDirty {
				if err := txApp.Save(record); err != nil {
					return 0, nil, internalError("failed to save secrets", err)
				}
			}

			if smtpTouched {
				pbSettings := txApp.Settings()
				if body.SMTPEnabled != nil {
					pbSettings.SMTP.Enabled = *body.SMTPEnabled
					changed = append(changed, "smtp_enabled")
				}
				if body.SMTPHost != nil {
					pbSettings.SMTP.Host = strings.TrimSpace(*body.SMTPHost)
					changed = append(changed, "smtp_host")
				}
				if body.SMTPPort != nil {
					pbSettings.SMTP.Port = *body.SMTPPort
					changed = append(changed, "smtp_port")
				}
				if body.SMTPUsername != nil {
					pbSettings.SMTP.Username = strings.TrimSpace(*body.SMTPUsername)
					changed = append(changed, "smtp_username")
				}
				if body.ClearSMTPPassword != nil && *body.ClearSMTPPassword {
					pbSettings.SMTP.Password = ""
					changed = append(changed, "smtp_password")
				} else if body.SMTPPassword != nil && *body.SMTPPassword != "" {
					pbSettings.SMTP.Password = *body.SMTPPassword
					changed = append(changed, "smtp_password")
				}
				if body.SMTPAuthMethod != nil {
					method := strings.ToUpper(strings.TrimSpace(*body.SMTPAuthMethod))
					if method == "" {
						method = "PLAIN"
					}
					pbSettings.SMTP.AuthMethod = method
					changed = append(changed, "smtp_auth_method")
				}
				if body.SMTPTLS != nil {
					pbSettings.SMTP.TLS = *body.SMTPTLS
					changed = append(changed, "smtp_tls")
				}
				if body.MailSenderAddress != nil {
					addr := strings.TrimSpace(*body.MailSenderAddress)
					if addr == "" {
						addr = "no-reply@aerun.invalid"
					}
					pbSettings.Meta.SenderAddress = addr
					changed = append(changed, "mail_sender_address")
				}
				if body.MailSenderName != nil {
					name := strings.TrimSpace(*body.MailSenderName)
					if name == "" {
						name = forumName(txApp, "en")
					}
					pbSettings.Meta.SenderName = name
					changed = append(changed, "mail_sender_name")
				}

				if pbSettings.SMTP.Enabled && (strings.TrimSpace(pbSettings.SMTP.Host) == "" || pbSettings.SMTP.Port < 1) {
					return 0, nil, validationError("smtp_host and smtp_port are required when SMTP is enabled")
				}

				if err := txApp.Save(pbSettings); err != nil {
					return 0, nil, internalError("failed to save SMTP settings", err)
				}
			}

			if len(changed) > 0 {
				if err := recordAuditLog(txApp, "secrets_updated", callerID, map[string]any{
					"keys": changed,
				}); err != nil {
					return 0, nil, err
				}
			}

			return http.StatusOK, map[string]any{
				"secrets": adminSecretsSnapshot(txApp, cfg),
			}, nil
		})
		if err != nil {
			return writeCommandResult(e, outcome, err)
		}

		// Live-apply Google OAuth2 outside txApp (users collection schema update).
		if googleChanged {
			if body.ClearGoogleOAuth != nil && *body.ClearGoogleOAuth {
				if err := clearGoogleOAuth2(e.App); err != nil {
					return internalError("secrets saved but failed to disable Google OAuth2", err)
				}
			} else if nextGoogleID != "" && nextGoogleSecret != "" {
				if err := applyGoogleOAuth2(e.App, nextGoogleID, nextGoogleSecret, "database"); err != nil {
					return internalError("secrets saved but failed to configure Google OAuth2", err)
				}
			}
		}

		return writeCommandResult(e, outcome, nil)
	}
}

// downloadGeoIPHandler downloads and hot-reloads GeoLite2-City.mmdb using the
// MaxMind license key stored in forum_settings (never from env or repo).
func downloadGeoIPHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	record, err := e.App.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return internalError("forum settings row is missing", err)
	}
	licenseKey := strings.TrimSpace(record.GetString("maxmind_license_key"))
	if licenseKey == "" {
		return validationError("MaxMind license key is not configured in Admin Settings")
	}

	callerID := e.Auth.Id
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		if _, err := downloadGeoLite2City(txApp, licenseKey); err != nil {
			return 0, nil, validationError(err.Error())
		}

		updatedAt := time.Now().UTC().Format(time.RFC3339)
		rec, err := txApp.FindRecordById(forumSettingsCollectionName, forumSettingsID)
		if err != nil || rec == nil {
			return 0, nil, internalError("forum settings row is missing", err)
		}
		rec.Set("geoip_updated_at", updatedAt)
		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to record GeoIP update timestamp", err)
		}

		if err := recordAuditLog(txApp, "geoip_database_updated", callerID, map[string]any{
			"updated_at": updatedAt,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"success":          true,
			"geoip_db_exists":  true,
			"geoip_updated_at": updatedAt,
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
