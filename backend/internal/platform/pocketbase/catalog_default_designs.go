package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const defaultDesignsCollectionName = "default_designs"

// defaultDesignRecordPayload is the snake_case shape the frontend's
// surface-3 cards read: the same fields a custom design card carries, plus
// `key`, and with neither is_active nor base_theme — a default design IS the
// base and has no activation.
func defaultDesignRecordPayload(r *core.Record) map[string]any {
	payload := map[string]any{
		"id":                      r.Id,
		"key":                     r.GetString("key"),
		"name":                    r.GetString("name"),
		"description":             r.GetString("description"),
		"css":                     r.GetString("css"),
		"js":                      r.GetString("js"),
		"forum_title":             r.GetString("forum_title"),
		"favicon_url":             r.GetString("favicon_url"),
		"show_in_list":            r.GetBool("show_in_list"),
		"header_html":             r.Get("header_html"),
		"custom_footer_html":      r.Get("custom_footer_html"),
		"bg_default_url":          r.GetString("bg_default_url"),
		"bg_tablet_url":           r.GetString("bg_tablet_url"),
		"bg_mobile_url":           r.GetString("bg_mobile_url"),
		"bg_opacity":              r.GetFloat("bg_opacity"),
		"placeholder_deleted_url": r.GetString("placeholder_deleted_url"),
		"placeholder_guest_url":   r.GetString("placeholder_guest_url"),
		"created_at":              r.GetDateTime("created_at").String(),
		"updated_at":              r.GetDateTime("updated_at").String(),
	}
	for _, name := range overwriteFieldNames {
		payload[name] = r.GetBool(name)
	}
	return payload
}

func findDefaultDesignByKey(app core.App, key string) (*core.Record, error) {
	col, err := app.FindCollectionByNameOrId(defaultDesignsCollectionName)
	if err != nil {
		return nil, err
	}
	return app.FindFirstRecordByFilter(col, "key = {:key}", dbx.Params{"key": key})
}

// defaultDesignSummaryPayload is the lightweight list shape for
// GET /api/aerun/default-designs: the same minimal card fields as the custom
// design summary, plus `key`, and with neither is_active nor base_theme —
// a default design IS the base and has no activation. The heavy fields
// (css, js, header_html, custom_footer_html, forum_title, favicon_url,
// placeholders, overwrite_* toggles, description, breakpoint backgrounds,
// opacity) stay out of lists — the single GET returns the full record.
// bg_default_url is the raw stored relative /api/files/... path.
func defaultDesignSummaryPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":             r.Id,
		"key":            r.GetString("key"),
		"name":           r.GetString("name"),
		"show_in_list":   r.GetBool("show_in_list"),
		"bg_default_url": r.GetString("bg_default_url"),
	}
}

// listDefaultDesignsHandler serves GET /api/aerun/default-designs.
// Public read, like GET /api/aerun/designs: the theme picker and the
// providers need the cards before anyone signs in. Ordered by key, which is
// the seeded dark / light / neutral order.
func listDefaultDesignsHandler(e *core.RequestEvent) error {
	col, err := e.App.FindCachedCollectionByNameOrId(defaultDesignsCollectionName)
	if err != nil {
		return internalError("default designs collection unavailable", err)
	}

	records, err := e.App.FindRecordsByFilter(col, "", "key", 0, 0)
	if err != nil {
		return internalError("failed to query default designs", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		items = append(items, defaultDesignSummaryPayload(r))
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

func getDefaultDesignHandler(e *core.RequestEvent) error {
	key := strings.TrimSpace(e.Request.PathValue("key"))
	if key == "" {
		return validationError("default design key is required")
	}

	rec, err := findDefaultDesignByKey(e.App, key)
	if err != nil || rec == nil {
		return notFoundError("default design not found")
	}

	return e.JSON(http.StatusOK, defaultDesignRecordPayload(rec))
}

// updateDefaultDesignHandler serves PATCH /api/aerun/default-designs/{key}.
//
// Only whitelisted fields are applied. `key` is the card's identity and is
// never patchable; is_active and base_theme do not exist on a default design
// and are ignored like any other unknown key. bg_*_url is upload-only, as on
// custom designs.
func updateDefaultDesignHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	key := strings.TrimSpace(e.Request.PathValue("key"))
	if key == "" {
		return validationError("default design key is required")
	}

	raw, err := readBodyLimited(e, 512*1024)
	if err != nil {
		return err
	}
	var form map[string]any
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed default design payload")
	}
	if _, hasLegacyWelcome := form["welcome_message"]; hasLegacyWelcome {
		return validationError("welcome_message is no longer supported; use header_html")
	}

	now := time.Now()
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := findDefaultDesignByKey(txApp, key)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("default design not found")
		}

		if nameRaw, ok := form["name"]; ok {
			if s, ok := nameRaw.(string); ok {
				s = strings.TrimSpace(s)
				if s == "" || len(s) > 128 {
					return 0, nil, validationError("name must be 1-128 characters")
				}
				rec.Set("name", s)
			}
		}
		if descRaw, ok := form["description"]; ok {
			rec.Set("description", descRaw)
		}
		if cssRaw, ok := form["css"]; ok {
			rec.Set("css", cssRaw)
		}
		if jsRaw, ok := form["js"]; ok {
			rec.Set("js", jsRaw)
		}
		if ftRaw, ok := form["forum_title"]; ok {
			rec.Set("forum_title", ftRaw)
		}
		if faviconRaw, ok := form["favicon_url"]; ok {
			rec.Set("favicon_url", faviconRaw)
		}
		if showRaw, ok := form["show_in_list"]; ok {
			rec.Set("show_in_list", showRaw)
		}
		if headerRaw, ok := form["header_html"]; ok {
			rec.Set("header_html", headerRaw)
		}
		if footerRaw, ok := form["custom_footer_html"]; ok {
			rec.Set("custom_footer_html", footerRaw)
		}
		for _, name := range overwriteFieldNames {
			if raw, ok := form[name]; ok {
				rec.Set(name, raw)
			}
		}
		if opacityRaw, ok := form["bg_opacity"]; ok {
			if v, ok := opacityRaw.(float64); ok {
				if v < 0 || v > 1 {
					return 0, nil, validationError("bg_opacity must be between 0 and 1")
				}
				rec.Set("bg_opacity", v)
			}
		}
		if deletedRaw, ok := form["placeholder_deleted_url"]; ok {
			rec.Set("placeholder_deleted_url", deletedRaw)
		}
		if guestRaw, ok := form["placeholder_guest_url"]; ok {
			rec.Set("placeholder_guest_url", guestRaw)
		}
		rec.Set("updated_at", now)

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update default design", err)
		}

		_ = recordAuditLog(txApp, "default_design_updated", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"key":       rec.GetString("key"),
			"name":      rec.GetString("name"),
		})

		return http.StatusOK, defaultDesignRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// createDefaultDesignHandler refuses POST /api/aerun/default-designs: the
// three cards are seeded by migration and new built-ins arrive as records,
// never through the API.
func createDefaultDesignHandler(e *core.RequestEvent) error {
	return newContractError(http.StatusMethodNotAllowed, errKindUnknown, "default designs cannot be created", nil)
}

// deleteDefaultDesignHandler refuses DELETE /api/aerun/default-designs/{key}:
// default cards are undeletable by design.
func deleteDefaultDesignHandler(e *core.RequestEvent) error {
	return newContractError(http.StatusMethodNotAllowed, errKindUnknown, "default designs cannot be deleted", nil)
}
