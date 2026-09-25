package pocketbase

import (
	"encoding/json"
	"net/http"
	"slices"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// canViewCategory checks whether the given AccessContext has permission to view
// the specified category.
//
// Root and admin roles can view all categories. Banned accounts are denied everything.
// If the category has explicit permissions configured (e.g. view_forum: ["admin", "moderator"]),
// only users whose role is in that list can view it.
// Otherwise, any user with the global view_forum permission (including active guests) can view it.
func canViewCategory(app core.App, acc AccessContext, categoryID string) (bool, error) {
	if categoryID == "" {
		return false, nil
	}
	if acc.Status == auth.StatusBanned {
		return false, nil
	}
	if acc.Role == auth.RoleRoot || acc.Role == auth.RoleAdmin {
		return true, nil
	}

	category, err := app.FindRecordById(categoriesCollectionName, categoryID)
	if err != nil || category == nil {
		return false, err
	}

	rawPerms := category.Get("permissions")
	if rawPerms == nil {
		return auth.Has(acc.Permissions, auth.PermViewForum), nil
	}

	var permsMap map[string]any
	switch v := rawPerms.(type) {
	case string:
		if v == "" || v == "{}" {
			return auth.Has(acc.Permissions, auth.PermViewForum), nil
		}
		if err := json.Unmarshal([]byte(v), &permsMap); err != nil {
			return false, err
		}
	case map[string]any:
		permsMap = v
	default:
		// Attempt JSON round-trip for custom types
		data, err := json.Marshal(v)
		if err != nil {
			return auth.Has(acc.Permissions, auth.PermViewForum), nil
		}
		if err := json.Unmarshal(data, &permsMap); err != nil {
			return auth.Has(acc.Permissions, auth.PermViewForum), nil
		}
	}

	allowedRolesRaw, ok := permsMap["view_forum"]
	if !ok || allowedRolesRaw == nil {
		return auth.Has(acc.Permissions, auth.PermViewForum), nil
	}

	var allowedRoles []string
	switch roles := allowedRolesRaw.(type) {
	case []any:
		for _, r := range roles {
			if s, ok := r.(string); ok {
				allowedRoles = append(allowedRoles, s)
			}
		}
	case []string:
		allowedRoles = roles
	}

	if len(allowedRoles) == 0 {
		return auth.Has(acc.Permissions, auth.PermViewForum), nil
	}

	return slices.Contains(allowedRoles, string(acc.Role)), nil
}

// canViewTopic checks whether the given AccessContext has permission to view
// the topic (and its parent category).
func canViewTopic(app core.App, acc AccessContext, topicID string) (bool, *core.Record, error) {
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil || topic.GetBool("deleted") {
		return false, nil, err
	}

	allowed, err := canViewCategory(app, acc, topic.GetString("category_id"))
	if err != nil || !allowed {
		return false, topic, err
	}

	return true, topic, nil
}

// listCategoriesHandler returns all categories that the caller is permitted to view.
func listCategoriesHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return internalError("failed to query categories", err)
	}

	var visible []map[string]any
	for _, c := range cats {
		allowed, err := canViewCategory(e.App, acc, c.Id)
		if err == nil && allowed {
			visible = append(visible, map[string]any{
				"id":          c.Id,
				"name":        c.GetString("name"),
				"slug":        c.GetString("slug"),
				"description": c.GetString("description"),
				"sort_order":  c.GetInt("sort_order"),
				"created":     c.GetDateTime("created").String(),
				"updated":     c.GetDateTime("updated").String(),
			})
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      visible,
		"request_id": requestIDFrom(e),
	})
}
