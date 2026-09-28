package pocketbase

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

const categoryGroupsCollectionName = "category_groups"

// listCategoryGroupsHandler serves GET /api/aerun/category-groups.
//
// Honest reader: If the table does not exist yet in the database, it returns
// an honest 200 with items: [] and available: false, suppressing client 404/403
// noise until the target schema lands. Once the table exists, it returns the rows
// sorted by sort_order.
func listCategoryGroupsHandler(e *core.RequestEvent) error {
	col, err := e.App.FindCachedCollectionByNameOrId(categoryGroupsCollectionName)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "missing") {
			return e.JSON(http.StatusOK, map[string]any{
				"items":      []any{},
				"available":  false,
				"request_id": requestIDFrom(e),
			})
		}
		return internalError("category_groups lookup failed", err)
	}

	records, err := e.App.FindRecordsByFilter(col, "", "sort_order", 0, 0)
	if err != nil {
		return internalError("failed to query category_groups", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		items = append(items, map[string]any{
			"id":         r.Id,
			"title":      r.Get("title"),
			"sort_order": r.GetInt("sort_order"),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"available":  true,
		"request_id": requestIDFrom(e),
	})
}
