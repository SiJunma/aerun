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
// The `available` flag survives from the era when the collection did not exist
// at all: migration 1767500000 created it, so the answer is always true now, but
// the frontend already reads the flag and removing it would be a second,
// unrelated change. The honest-degradation branch stays as a safety net for a
// database that predates the migration (an operator pointing the binary at an
// old pb_data before its first serve).
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
		items = append(items, categoryGroupPayload(r))
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"available":  true,
		"request_id": requestIDFrom(e),
	})
}
