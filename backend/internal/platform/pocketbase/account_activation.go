package pocketbase

import (
	"fmt"
	"math/rand"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"

	pbauth "github.com/pocketbase/pocketbase/tools/auth"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Automatic account activation when the "require approval" gate is OFF.
//
// WHY THIS EXISTS. Registration (register.go) and the PocketBase OAuth sign-up
// both create an account, but neither consulted the admin's "Требовать одобрения
// регистрации" switch — and nothing on the login path did either. The switch was
// read and mirrored to the browser (global_settings.go) but was NEVER wired to
// the account lifecycle: the only route out of "pending" was a staff member
// approving by hand (admin_users.go). So a forum that had turned approval OFF
// still trapped every new member behind /pending, and the reported account
// (Test2) sat there forever after confirming its email — the setting had no
// server-side effect at all.
//
// The switch means exactly what its help text says: "если выключено — они
// становятся активными сразу после входа". So the moment a still-pending forum
// account authenticates — by password, by OAuth (where the provider already
// vouched for the address), or on a token refresh — it is promoted to active.
// When approval is ON the hook is a deliberate no-op and staff keep full control.
//
// The activation is intentionally method-independent: it keys off the account
// status alone, never off how the account was created or whether the address was
// verified through our own mail flow. An OAuth sign-up is verified by the
// provider, so it must not be gated on a confirmation email we never send it.
//
// Bound from run.go alongside the other identity hooks. OnRecordAuthRequest is
// the single choke point every PocketBase auth flow funnels through
// (recordAuthResponse), so one hook covers password, OAuth2 and auth-refresh.
func registerAccountActivationHook(app core.App) {
	app.OnRecordAuthRequest().BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if e.Record != nil && e.Record.Collection().Name == usersCollectionName && isUserDeleted(e.Record) {
			return router.NewForbiddenError("this account has been deleted", nil)
		}
		activateAccountIfApprovalDisabled(e.App, e.Record)
		return e.Next()
	})
}

// registerOAuth2RejectedDeletedHook makes the Google OAuth2 flow treat a
// soft-deleted account as if it never existed, so a fresh registration
// creates an absolute new record instead of resurrecting the deleted one.
//
// PocketBase's oauth2Submit, triggered from OnRecordAuthWithOAuth2Request,
// finds an existing record by email or by ExternalAuth provider+providerId.
// If that record is soft-deleted, oauth2Submit would rewrite it (re-set the
// email, re-link the provider) before OnRecordAuthRequest ever gets to refuse
// it — exactly the O9 symptom: the deleted account's email gets "added back"
// and the 403 arrives only after the damage.
//
// CRITICAL IMPLEMENTATION NOTE: we must NOT set e.Record = nil and let
// oauth2Submit create the record through sendOAuth2RecordCreateRequest.
// That function posts to /api/collections/users/records via an internal
// HTTP request, which is gated by CreateRule. CreateRule is nil on the
// users collection (superuser-only), so every OAuth2-created account would
// get 403 "Only superusers can perform this action."
//
// Instead we create the fresh record directly with e.App.Save() (which
// bypasses browser rules), seeding every Required field the same way
// register.go does for email/password registration. oauth2Submit then takes
// the update path: it marks the record verified, re-links the ExternalAuth
// provider id, and saves — all inside its own transaction.
//
// Registration via OAuth2 then proceeds exactly like a first-time sign-up.
func registerOAuth2RejectedDeletedHook(app core.App) {
	app.OnRecordAuthWithOAuth2Request().BindFunc(func(e *core.RecordAuthWithOAuth2RequestEvent) error {
		if e.Record != nil && e.Record.Collection().Name == usersCollectionName && isUserDeleted(e.Record) {
			oauth2Email := e.OAuth2User.Email

			// Release the provider link and the email on the deleted row so
			// they can be reclaimed by a fresh registration.
			if err := e.App.DeleteAllExternalAuthsByRecord(e.Record); err != nil {
				return err
			}
			if e.Record.Email() != "" {
				e.Record.SetEmail("")
			}
			if err := e.App.Save(e.Record); err != nil {
				return err
			}

			fresh, err := buildFreshOAuth2Record(app, e.Collection, e.OAuth2User, oauth2Email)
			if err != nil {
				return err
			}
			if err := e.App.Save(fresh); err != nil {
				return err
			}

			// oauth2Submit takes the update path from here: it sets
			// verified=true (because email matches the provider data),
			// creates the ExternalAuth link, and saves — all inside its own
			// transaction.
			e.Record = fresh
			return e.Next()
		}

		if e.Record == nil && e.Collection.Name == usersCollectionName {
			// No existing record found by email or providerId — this is a
			// brand-new OAuth2 sign-up. Create the record directly, bypassing
			// browser rules (CreateRule is nil on users, so PocketBase's own
			// internal POST /api/collections/users/records would answer 403
			// "Only superusers can perform this action.").
			fresh, err := buildFreshOAuth2Record(app, e.Collection, e.OAuth2User, e.OAuth2User.Email)
			if err != nil {
				return err
			}
			if err := e.App.Save(fresh); err != nil {
				return err
			}

			e.Record = fresh
			return e.Next()
		}

		return e.Next()
	})
}

func buildFreshOAuth2Record(app core.App, collection *core.Collection, oauth2User *pbauth.AuthUser, email string) (*core.Record, error) {
	fresh := core.NewRecord(collection)
	fresh.SetEmail(email)
	fresh.SetVerified(false)
	// PocketBase assigns a random password for OAuth2 sign-ups; we seed one
	// here because the users.password column is Required.
	fresh.SetPassword(security.RandomString(30))

	// Nickname is Required. Build a purely random one (adjective + animal +
	// number, like "LuckyBadger42") — never from the user's Google name or
	// email. The frontend will let the member replace it via PATCH
	// /me/profile after sign-in.
	nickname, err := generateOAuth2Nickname(app)
	if err != nil {
		return nil, err
	}
	fresh.Set("nickname", nickname)
	fresh.Set("nickname_normalized", auth.NormalizeNickname(nickname))

	fresh.Set("role", string(auth.RolePlayer))
	fresh.Set("status", string(initialAccountStatus(app)))
	fresh.Set("avatar_url", "")
	fresh.Set(userLastSeenField, time.Now())

	// Map OAuth2 profile fields the same way oauth2Submit would.
	if collection.OAuth2.MappedFields.Name != "" && oauth2User.Name != "" {
		if f := collection.Fields.GetByName(collection.OAuth2.MappedFields.Name); f != nil {
			fresh.Set(collection.OAuth2.MappedFields.Name, oauth2User.Name)
		}
	}
	if collection.OAuth2.MappedFields.AvatarURL != "" && oauth2User.AvatarURL != "" {
		if f := collection.Fields.GetByName(collection.OAuth2.MappedFields.AvatarURL); f != nil {
			fresh.Set(collection.OAuth2.MappedFields.AvatarURL, oauth2User.AvatarURL)
		}
	}

	return fresh, nil
}

// oauth2Nicknames mirrors src/utils/nickname.js so a Google OAuth sign-up
// gets the same kind of random nickname the registration form promises
// ("a random nickname like LuckyBadger") — without ever using the user's
// real name or email address.
// Format: [Adjective][Animal][Number], e.g. "HappyPanda42".
var (
	oauth2Adjectives = []string{
		"Anonymous", "Brave", "Clever", "Dancing", "Eager", "Friendly",
		"Gentle", "Happy", "Intelligent", "Jolly", "Kind", "Lucky",
		"Merry", "Nice", "Orange", "Proud", "Quick", "Radiant",
		"Sunny", "Thoughtful", "Unique", "Vibrant", "Wise", "Young",
		"Zealous", "Fluffy", "Silly", "Speedy", "Calm", "Bold",
	}
	oauth2Animals = []string{
		"Axolotl", "Badger", "Beaver", "Camel", "Chameleon", "Cheetah",
		"Chinchilla", "Chipmunk", "Crow", "Dingo", "Dinosaur", "Dolphin",
		"Duck", "Elephant", "Ferret", "Fox", "Frog", "Giraffe",
		"Gopher", "Grizzly", "Hedgehog", "Hippo", "Hyena", "Ibex",
		"Iguanodon", "Jackal", "Kangaroo", "Koala", "Kraken", "Lemur",
		"Leopard", "Llama", "Manatee", "Mink", "Monkey", "Narwhal",
		"Octopus", "Otter", "Panda", "Penguin", "Platypus", "Python",
		"Rabbit", "Raccoon", "Rhino", "Sheep", "Shrew", "Skunk",
		"Squirrel", "Tiger", "Turtle", "Walrus", "Wolf", "Wolverine", "Wombat",
	}
)

// generateOAuth2Nickname builds a purely random nickname in the format
// [Adjective][Animal][Number] (e.g. "LuckyBadger42"). It never derives from
// the user's Google name or email. It retries with a fresh random draw until
// the nickname_normalized key is free among non-deleted accounts.
func generateOAuth2Nickname(app core.App) (string, error) {
	for attempt := 0; attempt < 10; attempt++ {
		adj := oauth2Adjectives[rand.Intn(len(oauth2Adjectives))]
		animal := oauth2Animals[rand.Intn(len(oauth2Animals))]
		num := rand.Intn(99) + 1
		nickname := fmt.Sprintf("%s%s%d", adj, animal, num)

		var existing []*core.Record
		if err := app.RecordQuery(usersCollectionName).
			AndWhere(dbx.HashExp{"nickname_normalized": auth.NormalizeNickname(nickname)}).
			AndWhere(notDeletedUsersExpr()).
			Limit(1).
			All(&existing); err != nil {
			return "", err
		}
		if len(existing) == 0 {
			return nickname, nil
		}
	}
	return "", fmt.Errorf("could not generate a unique oauth2 nickname after 10 attempts")
}

// activateAccountIfApprovalDisabled flips a still-pending forum account to
// active when the "require approval" gate is off. It is a no-op for guests,
// non-forum auth collections, already-active/banned accounts and — crucially —
// when approval is required, so an admin who wants manual review keeps it.
//
// A failed save is logged and swallowed rather than aborting the login: a
// member has already proven who they are, and refusing the sign-in over a
// status write would lock them out over our own bookkeeping. The next login (or
// refresh) retries the promotion.
func activateAccountIfApprovalDisabled(app core.App, record *core.Record) {
	if record == nil {
		return
	}
	if record.Collection().Name != usersCollectionName {
		return
	}
	// Only a pending account is eligible. An active account has nothing to do
	// (and must not be rewritten on every request); a banned account must never
	// be resurrected by a login.
	if record.GetString("status") != string(auth.StatusPending) {
		return
	}
	// Approval required: the staff gate stays, so this account waits.
	if loadForumSettings(app).RequireApproval {
		return
	}

	record.Set("status", string(auth.StatusActive))
	if err := app.Save(record); err != nil {
		app.Logger().Warn("account activation failed; the account stays pending until the next sign-in",
			"error", err, "userId", record.Id)
	}
}

// initialAccountStatus reports the status a brand-new email/password account
// should be created with: pending while staff approval is required, active the
// moment it is not. It is the creation-time counterpart of the sign-in hook
// above — the hook self-heals accounts that were created before the switch was
// turned off (and OAuth sign-ups), this one makes new registrations correct from
// the first row so they never sit pending in a forum that does not gate them.
func initialAccountStatus(app core.App) auth.Status {
	if loadForumSettings(app).RequireApproval {
		return auth.StatusPending
	}
	return auth.StatusActive
}
