package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const designsCollectionName = "designs"

// overwriteFieldNames is the one toggle per value that can fall back to
// surface 1 (PLAN_DESIGNS_TAB_SURFACES.md §3.4), shared by custom and
// default design cards. There is deliberately no toggle for the background:
// it lives only on the card.
var overwriteFieldNames = []string{
	"overwrite_header",
	"overwrite_footer",
	"overwrite_title",
	"overwrite_favicon",
	"overwrite_css",
	"overwrite_js",
	"overwrite_placeholder_deleted",
	"overwrite_placeholder_guest",
}

// cardBgOpacity reads a card's background opacity.
//
// The stored value is clamped to 0..1. Only an UNSET value reads as 0.5:
// a fresh card must not render its background fully transparent just
// because nobody touched the slider yet. An explicit 0 is a real value
// (fully transparent) and reads back as 0 — unlike the old per-theme
// opacities, whose clampOpacity could not tell unset from 0.
func cardBgOpacity(r *core.Record) float64 {
	if r.Get("bg_opacity") == nil {
		return 0.5
	}
	v := r.GetFloat("bg_opacity")
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func designRecordPayload(r *core.Record) map[string]any {
	payload := map[string]any{
		"id":                      r.Id,
		"name":                    r.GetString("name"),
		"description":             r.GetString("description"),
		"css":                     r.GetString("css"),
		"js":                      r.GetString("js"),
		"forum_title":             r.GetString("forum_title"),
		"favicon_url":             r.GetString("favicon_url"),
		"base_theme":              r.GetString("base_theme"),
		"is_active":               r.GetBool("is_active"),
		"show_in_list":            r.GetBool("show_in_list"),
		"header_html":             r.Get("header_html"),
		"custom_footer_html":      r.Get("custom_footer_html"),
		"bg_default_url":          r.GetString("bg_default_url"),
		"bg_tablet_url":           r.GetString("bg_tablet_url"),
		"bg_mobile_url":           r.GetString("bg_mobile_url"),
		"bg_opacity":              cardBgOpacity(r),
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

// listDesignsHandler serves GET /api/aerun/designs.
// Public read: mirrors legacy Firestore `designs` collection (`allow read: if true;`).
func listDesignsHandler(e *core.RequestEvent) error {
	col, err := e.App.FindCachedCollectionByNameOrId(designsCollectionName)
	if err != nil {
		return internalError("designs collection unavailable", err)
	}

	records, err := e.App.FindRecordsByFilter(col, "", "-created_at", 0, 0)
	if err != nil {
		return internalError("failed to query designs", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		items = append(items, designRecordPayload(r))
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

func getDesignHandler(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("design id is required")
	}

	rec, err := e.App.FindRecordById(designsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("design not found")
	}

	return e.JSON(http.StatusOK, designRecordPayload(rec))
}

type designMutationForm struct {
	Name                        string   `json:"name"`
	Description                 string   `json:"description"`
	CSS                         string   `json:"css"`
	JS                          string   `json:"js"`
	ForumTitle                  string   `json:"forum_title"`
	FaviconURL                  string   `json:"favicon_url"`
	BaseTheme                   string   `json:"base_theme"`
	IsActive                    *bool    `json:"is_active"`
	ShowInList                  *bool    `json:"show_in_list"`
	HeaderHtml                  any      `json:"header_html"`
	CustomFooterHtml            any      `json:"custom_footer_html"`
	OverwriteHeader             *bool    `json:"overwrite_header"`
	OverwriteFooter             *bool    `json:"overwrite_footer"`
	OverwriteTitle              *bool    `json:"overwrite_title"`
	OverwriteFavicon            *bool    `json:"overwrite_favicon"`
	OverwriteCSS                *bool    `json:"overwrite_css"`
	OverwriteJS                 *bool    `json:"overwrite_js"`
	OverwritePlaceholderDeleted *bool    `json:"overwrite_placeholder_deleted"`
	OverwritePlaceholderGuest   *bool    `json:"overwrite_placeholder_guest"`
	BgOpacity                   *float64 `json:"bg_opacity"`
	PlaceholderDeletedURL       *string  `json:"placeholder_deleted_url"`
	PlaceholderGuestURL         *string  `json:"placeholder_guest_url"`
}

// setOverwriteToggles applies the eight overwrite_* toggles from a parsed
// form onto the record when present.
func setOverwriteToggles(rec *core.Record, toggles map[string]*bool) {
	for _, name := range overwriteFieldNames {
		if v, ok := toggles[name]; ok && v != nil {
			rec.Set(name, *v)
		}
	}
}

// designFormToggles collects the overwrite_* pointers of a create form into
// the map setOverwriteToggles reads.
func (f designMutationForm) toggles() map[string]*bool {
	return map[string]*bool{
		"overwrite_header":              f.OverwriteHeader,
		"overwrite_footer":              f.OverwriteFooter,
		"overwrite_title":               f.OverwriteTitle,
		"overwrite_favicon":             f.OverwriteFavicon,
		"overwrite_css":                 f.OverwriteCSS,
		"overwrite_js":                  f.OverwriteJS,
		"overwrite_placeholder_deleted": f.OverwritePlaceholderDeleted,
		"overwrite_placeholder_guest":   f.OverwritePlaceholderGuest,
	}
}

// validateBgOpacity refuses an out-of-range card opacity the same way the
// field-level Min/Max would, but as a 400 rather than a 500 from Save.
func validateBgOpacity(v *float64) error {
	if v != nil && (*v < 0 || *v > 1) {
		return validationError("bg_opacity must be between 0 and 1")
	}
	return nil
}

// isBuiltinTheme reports whether value is one of the three built-in themes a
// custom design can be layered on.
func isBuiltinTheme(value string) bool {
	return value == "light" || value == "dark" || value == "neutral"
}

func createDesignHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	raw, err := readBodyLimited(e, 512*1024)
	if err != nil {
		return err
	}
	var rawMap map[string]any
	if err := json.Unmarshal(raw, &rawMap); err != nil {
		return validationError("malformed design payload")
	}
	if _, hasLegacyLogo := rawMap["logo_url"]; hasLegacyLogo {
		return validationError("logo_url is no longer supported; use favicon_url")
	}
	if _, hasLegacyWelcome := rawMap["welcome_message"]; hasLegacyWelcome {
		return validationError("welcome_message is no longer supported; use header_html")
	}
	var form designMutationForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed design payload")
	}
	if err := validateBgOpacity(form.BgOpacity); err != nil {
		return err
	}

	form.Name = strings.TrimSpace(form.Name)
	if form.Name == "" || len(form.Name) > 128 {
		return validationError("design name is required and must not exceed 128 characters")
	}
	if form.BaseTheme == "" {
		form.BaseTheme = "dark"
	}
	if !isBuiltinTheme(form.BaseTheme) {
		return validationError("base_theme must be one of light, dark, neutral")
	}

	now := time.Now()
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		col, err := txApp.FindCollectionByNameOrId(designsCollectionName)
		if err != nil {
			return 0, nil, internalError("designs collection unavailable", err)
		}

		rec := core.NewRecord(col)
		rec.Set("name", form.Name)
		rec.Set("description", form.Description)
		rec.Set("css", form.CSS)
		rec.Set("js", form.JS)
		rec.Set("forum_title", form.ForumTitle)
		rec.Set("favicon_url", form.FaviconURL)
		rec.Set("base_theme", form.BaseTheme)
		if form.IsActive != nil {
			rec.Set("is_active", *form.IsActive)
		}
		if form.ShowInList != nil {
			rec.Set("show_in_list", *form.ShowInList)
		}
		if form.HeaderHtml != nil {
			rec.Set("header_html", form.HeaderHtml)
		}
		if form.CustomFooterHtml != nil {
			rec.Set("custom_footer_html", form.CustomFooterHtml)
		}
		setOverwriteToggles(rec, form.toggles())
		if form.BgOpacity != nil {
			rec.Set("bg_opacity", *form.BgOpacity)
		} else {
			// A fresh card defaults to 0.5: without this the create response
			// (built from the in-memory record, whose unset number field
			// reads as 0) would disagree with a later GET (NULL in the
			// row reads as the 0.5 default in cardBgOpacity).
			rec.Set("bg_opacity", 0.5)
		}
		if form.PlaceholderDeletedURL != nil {
			rec.Set("placeholder_deleted_url", *form.PlaceholderDeletedURL)
		}
		if form.PlaceholderGuestURL != nil {
			rec.Set("placeholder_guest_url", *form.PlaceholderGuestURL)
		}
		rec.Set("created_at", now)
		rec.Set("updated_at", now)

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to create design", err)
		}

		_ = recordAuditLog(txApp, "design_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"name":      form.Name,
		})

		return http.StatusCreated, designRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

func updateDesignHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("design id is required")
	}

	raw, err := readBodyLimited(e, 512*1024)
	if err != nil {
		return err
	}
	var form map[string]any
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed design payload")
	}
	if _, hasLegacyLogo := form["logo_url"]; hasLegacyLogo {
		return validationError("logo_url is no longer supported; use favicon_url")
	}
	if _, hasLegacyWelcome := form["welcome_message"]; hasLegacyWelcome {
		return validationError("welcome_message is no longer supported; use header_html")
	}

	now := time.Now()
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(designsCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("design not found")
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
		if baseRaw, ok := form["base_theme"]; ok {
			if s, ok := baseRaw.(string); ok {
				if !isBuiltinTheme(s) {
					return 0, nil, validationError("base_theme must be one of light, dark, neutral")
				}
				rec.Set("base_theme", s)
			}
		}
		if activeRaw, ok := form["is_active"]; ok {
			rec.Set("is_active", activeRaw)
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
		// bg_*_url is upload-only: a PATCH carrying one is ignored, the
		// reference is written only by the background upload endpoint.
		rec.Set("updated_at", now)

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update design", err)
		}

		_ = recordAuditLog(txApp, "design_updated", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"name":      rec.GetString("name"),
		})

		return http.StatusOK, designRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

func deleteDesignHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	if id == "" {
		return validationError("design id is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(designsCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("design not found")
		}

		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete design", err)
		}

		_ = recordAuditLog(txApp, "design_deleted", e.Auth.Id, map[string]any{
			"target_id": id,
		})

		return http.StatusOK, map[string]any{"ok": true, "target_id": id}, nil
	})
	return writeCommandResult(e, outcome, err)
}
