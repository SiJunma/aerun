package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// 1770000013_lock_users_read_rules.go closes direct browser reads of the
// `users` collection (SEC-03).
//
// THE FAILURE. Migration 1768100000 widened the read rules to the empty filter
// so a banned account's profile stayed readable, and it left TWO doors open:
//
//   - `GET /api/collections/users/records` and `/records/{id}` answered every
//     caller with the WHOLE auth record — `settings` included, where a
//     member's private preferences live (sound volume, muted notification
//     types, mail preferences, theme, language), plus the `emailVisibility`
//     and `nickname_normalized` scaffolding. `emailVisibility=false` hides
//     only the email column; it does not narrow the JSON field.
//   - `GET /api/collections/users/records/{id}` is also the authorization
//     gate for `GET /api/files/users/{id}/{avatar}` (apis/file.go consults
//     the collection ViewRule), so closing the list and the view together is
//     what stops it.
//
// THE PRODUCT RULE. Nothing needs the collection door any more. Every read was
// already moved behind the command layer: the profile DTO
// (`GET /api/aerun/users/{id}`), the member board (`GET /api/aerun/users`),
// nickname search, the mention picker and the idempotency of the profile page
// all go through `/api/aerun` now, and `scripts/check-forum-read-contract.mjs`
// forbids a `pb.collection('users')` read in the browser. Authentication does
// NOT go through the read rules — it is governed by the auth endpoints
// (authWithPassword / authWithOAuth2 / authRefresh), which resolve the record
// directly, so locking the reads does not break sign-in.
//
// THE DOWNSIDE, priced in. A nil ViewRule also makes a pending or banned
// account's avatar file unreachable through `/api/files/...`. That was already
// the documented trade-off while the rule was `status = "active"`: such an
// avatar is stored but not publicly served. The list board never renders it,
// and the profile DTO still reports its `avatar_url` reference.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(lockUsersReadRules, restoreLockedUsersReadRules)
}

// lockUsersReadRules sets both read rules to nil (locked, superuser-only).
func lockUsersReadRules(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("users: %w", err)
	}
	users.ListRule = nil
	users.ViewRule = nil
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users read rules: %w", err)
	}
	return nil
}

// restoreLockedUsersReadRules is the down path: it returns the empty (public)
// rule this migration replaced, matching 1768100000's openReadRule.
func restoreLockedUsersReadRules(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("users: %w", err)
	}
	if users.ViewRule == nil {
		users.ViewRule = types.Pointer(openReadRule)
	}
	if users.ListRule == nil {
		users.ListRule = types.Pointer(openReadRule)
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users read rules: %w", err)
	}
	return nil
}
