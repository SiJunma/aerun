package migrations

// 1768100000_profiles_visible_regardless_of_status.go makes a profile readable
// regardless of the account status.
//
// THE FAILURE. The profile page loads its subject through the PocketBase SDK
// directly — `pb.collection('users').getOne(uid)` in subscribeToUser — and that
// path is governed by the collection's ViewRule, not by the /api/aerun command
// layer. 1766000000 set that rule to
//
//	status = "active" || id = @request.auth.id
//
// so a suspended account failed both branches and PocketBase answered 404.
// After a ban the admin's profile screen came back empty: no nickname, no role,
// no counters, and a Characters tab that read "no characters yet" rather than
// "suspended".
//
// THE PRODUCT RULE. A restriction is a restriction ON THE ACCOUNT, not on what
// other people may see of it. An operator bans somebody precisely so they can
// go on reading what they wrote; making the record vanish at the same moment
// removes the evidence the ban was decided on. So visibility is deliberately
// decoupled from status here: everyone reads every profile, exactly as they read
// an active one.
//
// Only the READ rules move. Create/Update/Delete stay nil (deny-by-default,
// server-only commands) — a wider view rule must not become a wider write
// rule, which is the whole point of 1766000000.
//
// An intermediate version of this migration granted the exemption to STAFF only,
// which was wrong: it treated the ban as a privacy change instead of an action
// limit, and left every ordinary reader still unable to open the profile. Both
// the intermediate and the original rule are accepted as the "before" value so
// this converges on an already-migrated database as well as a fresh one.
import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		return widenUsersReadRules(app)
	}, func(app core.App) error {
		return restoreUsersReadRules(app)
	})
}

// openReadRule is an empty filter, which PocketBase reads as "allow every
// request". Profiles are public by design — the members page lists them, and
// nickname/avatar/counters are already served to guests for active accounts.
// Email, password and tokenKey are not part of that exposure: the first is
// withheld by emailVisibility=false, the others are protected fields the API
// never serialises.
const openReadRule = ``

// The rules this migration replaces: the original status-narrowed one, and the
// staff-only intermediate.
const (
	previousPublicProfileRule = `status = "active" || id = @request.auth.id`
	staffExemptReadRule       = `status = "active" || id = @request.auth.id || ` +
		`@request.auth.role = "root" || @request.auth.role = "admin" || @request.auth.role = "moderator"`
)

// supersededReadRules is what an already-migrated database may still carry.
var supersededReadRules = map[string]bool{
	previousPublicProfileRule: true,
	staffExemptReadRule:       true,
}

func widenUsersReadRules(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("users: %w", err)
	}

	if users.ViewRule == nil || supersededReadRules[*users.ViewRule] {
		users.ViewRule = types.Pointer(openReadRule)
	}
	if users.ListRule == nil || supersededReadRules[*users.ListRule] {
		users.ListRule = types.Pointer(openReadRule)
	}
	// A rule that is none of the above was set deliberately by an operator and is
	// left alone rather than silently overwritten; the mismatch stays visible in
	// the collection editor.
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users read rules: %w", err)
	}
	return nil
}

func restoreUsersReadRules(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return fmt.Errorf("users: %w", err)
	}
	if users.ViewRule != nil && *users.ViewRule == openReadRule {
		users.ViewRule = types.Pointer(previousPublicProfileRule)
	}
	if users.ListRule != nil && *users.ListRule == openReadRule {
		users.ListRule = types.Pointer(previousPublicProfileRule)
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users read rules: %w", err)
	}
	return nil
}
