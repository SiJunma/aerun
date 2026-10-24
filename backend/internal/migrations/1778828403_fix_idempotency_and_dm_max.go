// 1778828403_fix_idempotency_and_dm_max.go fixes two TextField Max limits that
// were silently capping content length at 5000 and 1024 characters.
//
//  1. idempotency_keys.response_json — PocketBase's idempotency system stores the
//     full command response envelope (including post content) in this column.
//     Max=0 was interpreted by PocketBase as a 5000-character cap, which caused
//     editPostHandler/createPostHandler to fail with validation_max_text_constraint
//     for any post longer than 5000 characters, even though posts.content itself
//     allows 65536.
//
//  2. dm_conversations.last_message — Max=1024 capped direct message conversation
//     last_message at 1024 characters, causing validation failures for longer DMs.
//
// Both fields are changed to Max=1000000 (effectively unlimited).
//
// Idempotent: safe to re-run.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(fixIdempotencyAndDmMax, revertFixIdempotencyAndDmMax)
}

func fixIdempotencyAndDmMax(app core.App) error {
	changed := 0

	// Fix idempotency_keys.response_json
	idempotency, err := app.FindCollectionByNameOrId("idempotency_keys")
	if err != nil {
		return fmt.Errorf("find idempotency_keys collection: %w", err)
	}
	if field := idempotency.Fields.GetByName("response_json"); field != nil {
		if textField, ok := field.(*core.TextField); ok && textField.Max != 1000000 {
			textField.Max = 1000000
			changed++
		}
	}
	if err := app.Save(idempotency); err != nil {
		return fmt.Errorf("save idempotency_keys collection: %w", err)
	}

	// Fix dm_conversations.last_message
	dm, err := app.FindCollectionByNameOrId("dm_conversations")
	if err != nil {
		return fmt.Errorf("find dm_conversations collection: %w", err)
	}
	if field := dm.Fields.GetByName("last_message"); field != nil {
		if textField, ok := field.(*core.TextField); ok && textField.Max != 1000000 {
			textField.Max = 1000000
			changed++
		}
	}
	if err := app.Save(dm); err != nil {
		return fmt.Errorf("save dm_conversations collection: %w", err)
	}

	app.Logger().Info("fixed text field Max limits", "collections", "idempotency_keys+dm_conversations", "fields_changed", changed)
	return nil
}

func revertFixIdempotencyAndDmMax(app core.App) error {
	return nil
}
