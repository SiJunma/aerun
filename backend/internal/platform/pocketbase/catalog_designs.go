package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const designsCollectionName = "designs"

func designRecordPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":              r.Id,
		"name":            r.GetString("name"),
		"description":     r.GetString("description"),
		"css":             r.GetString("css"),
		"js":              r.GetString("js"),
		"forum_title":     r.GetString("forum_title"),
		"logo_url":        r.GetString("logo_url"),
		"is_active":       r.GetBool("is_active"),
		"show_in_list":    r.GetBool("show_in_list"),
		"welcome_message": r.Get("welcome_message"),
		"created_at":      r.GetDateTime("created_at").String(),
		"updated_at":      r.GetDateTime("updated_at").String(),
	}
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
	Name           string `json:"name"`
	Description    string `json:"description"`
	CSS            string `json:"css"`
	JS             string `json:"js"`
	ForumTitle     string `json:"forum_title"`
	LogoURL        string `json:"logo_url"`
	IsActive       *bool  `json:"is_active"`
	ShowInList     *bool  `json:"show_in_list"`
	WelcomeMessage any    `json:"welcome_message"`
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
	var form designMutationForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed design payload")
	}

	form.Name = strings.TrimSpace(form.Name)
	if form.Name == "" || len(form.Name) > 128 {
		return validationError("design name is required and must not exceed 128 characters")
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
		rec.Set("logo_url", form.LogoURL)
		if form.IsActive != nil {
			rec.Set("is_active", *form.IsActive)
		}
		if form.ShowInList != nil {
			rec.Set("show_in_list", *form.ShowInList)
		}
		if form.WelcomeMessage != nil {
			rec.Set("welcome_message", form.WelcomeMessage)
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
		if logoRaw, ok := form["logo_url"]; ok {
			rec.Set("logo_url", logoRaw)
		}
		if activeRaw, ok := form["is_active"]; ok {
			rec.Set("is_active", activeRaw)
		}
		if showRaw, ok := form["show_in_list"]; ok {
			rec.Set("show_in_list", showRaw)
		}
		if wmRaw, ok := form["welcome_message"]; ok {
			rec.Set("welcome_message", wmRaw)
		}
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

