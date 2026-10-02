package pocketbase

import (
	"encoding/json"
	"net/http"
	"slices"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// canViewCategory checks whether the given AccessContext may view a category.
//
// ADR-1: `categories.allowed_roles` is the ONLY visibility input. An empty or
// absent list means root-only — deny by default. A public category names every
// role explicitly, guest included, and the importer/backfill writes exactly that
// list, so "public" is a stored fact rather than a fallback the reader infers.
// The previous "empty = public" default was the showstopper this replaced: with
// the importer writing allowed_roles, every restricted category would have
// silently become world-readable.
//
// ADR-2: membership is tested against users.role only. custom_role_id is NOT
// consulted — a category granted to `player` does not implicitly include a user
// on a custom role derived from `player`; the admin lists the custom role
// explicitly (which is also how the legacy export behaves).
//
// `root` is the only bypass (ADR-1 reversed the pre-audit rule that also let
// `admin` through), and a banned account is refused before the bypass is even
// considered: status outranks authority.
func canViewCategory(app core.App, acc AccessContext, categoryID string) (bool, error) {
	if categoryID == "" {
		return false, nil
	}
	if acc.Status == auth.StatusBanned {
		return false, nil
	}
	if acc.Role == auth.RoleRoot {
		return true, nil
	}

	category, err := app.FindRecordById(categoriesCollectionName, categoryID)
	if err != nil || category == nil {
		return false, err
	}

	allowedRoles := decodeRoleIDList(category.Get("allowed_roles"))
	if len(allowedRoles) == 0 {
		return false, nil
	}
	return slices.Contains(allowedRoles, string(acc.Role)), nil
}

// canViewTopic checks whether the given AccessContext has permission to view
// the topic (and its parent category).
func canViewTopic(app core.App, acc AccessContext, topicID string) (bool, *core.Record, error) {
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		return false, nil, err
	}

	allowed, err := canViewCategory(app, acc, topic.GetString("category_id"))
	if err != nil || !allowed {
		return false, topic, err
	}

	return true, topic, nil
}

// decodeRoleIDList normalises a JSON value that should be a list of role ids.
//
// PocketBase stores JSON fields as types.JSONRaw, but the same value can reach
// the command layer as a plain []string (what record.Set writes in tests and in
// the importer) or as string-encoded JSON (what an older row may hold), so all
// three shapes are accepted. Anything else — including an object, which is what
// the retired `permissions` map looked like — decodes to no roles, which every
// caller reads as "not granted" (deny by default, ADR-1).
func decodeRoleIDList(raw any) []string {
	switch value := raw.(type) {
	case nil:
		return nil
	case types.JSONRaw:
		if len(value) == 0 {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil
		}
		return decoded
	case string:
		if value == "" || value == "[]" {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return nil
		}
		return decoded
	case []string:
		return value
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// listCategoriesHandler returns all categories that the caller is permitted to
// view.
//
// group_id and allowed_roles ride along because the admin board has to render and
// re-submit them: without them, opening a category for editing would show an
// empty permission list and saving would silently wipe the real one. Both are
// served only to callers who can already see the category, and neither is
// sensitive (a list of role ids), so this is not a widening of visibility.
func listCategoriesHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return internalError("failed to query categories", err)
	}

	items := make([]map[string]any, 0, len(cats))
	for _, c := range cats {
		allowed, err := canViewCategory(e.App, acc, c.Id)
		if err != nil || !allowed {
			continue
		}
		roles := decodeRoleIDList(c.Get("allowed_roles"))
		if roles == nil {
			roles = []string{}
		}
		items = append(items, map[string]any{
			"id":            c.Id,
			"name":          c.GetString("name"),
			"slug":          c.GetString("slug"),
			"description":   c.GetString("description"),
			"group_id":      c.GetString("group_id"),
			"sort_order":    c.GetInt("sort_order"),
			"allowed_roles": roles,
			"created":       c.GetDateTime("created").String(),
			"updated":       c.GetDateTime("updated").String(),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}
