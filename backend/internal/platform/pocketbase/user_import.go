package pocketbase

// Users import (Sprint 7 writer, level L1 of the dependency map in
// POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §5).
//
// This is the second writer of the migration, after the role registry
// (role_import.go). It lives in the platform adapter for the same reason: it is
// the only package allowed to import PocketBase, and the rules it encodes are
// properties of the target schema.
//
// The legacy accounts are the one collection that can be addressed by their
// source identity even after the import, because `users` has a place to
// remember it: the hidden `legacy_firebase_uid` column with a partial UNIQUE
// index. Every write is therefore an upsert keyed by that column, which is what
// makes a re-run a no-op instead of a duplicate account — the property the
// whole cutover depends on, since an idempotent *analysis* (mapping.json) says
// nothing about whether a second *write* would be safe.
//
// Deliberate decisions, each of them visible to the caller:
//
//   - Passwords are never transferred. Firebase stores a different hash format
//     and the official Auth export cannot be assumed to carry one. A created
//     row gets either the caller's password (the root-admin bootstrap, so the
//     owner can sign in while mail and OAuth2 are still disabled) or
//     PocketBase's own random unusable password via SetRandomPassword. An
//     *existing* row never has its password touched, so a re-run cannot
//     invalidate a password the owner has already changed.
//   - The historical registration date is preserved: `created` is an autodate
//     field that silently ignores `Set`, so it is written with `SetRaw`, which
//     is the only way PocketBase leaves a manually assigned date alone
//     (core/field_autodate.go, InterceptorActionCreateExecute). `updated` is
//     not seeded: PocketBase owns it and would overwrite it on the next write
//     anyway.
//   - Counters (`post_count`, `topics_count`, `reputation`) are NOT written.
//     They are derived data and are rebuilt by the post-import pass once posts
//     and reputation votes exist (map §5), never imported from a cached value.
//   - A row that is present in the target but absent from the batch is
//     reported, never deleted: deletion is a separate, human-approved decision,
//     exactly as in the role registry.
//   - The batch is validated before the transaction opens: an unknown role, a
//     duplicate email or a duplicate normalised nickname would otherwise fail
//     halfway through, and a half-imported account list is not a state anyone
//     can reason about.

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// UserProfile carries the legacy profile fields that have their own users
// columns since migration 1766900000. They are plain strings: the legacy
// document stored them as free text (birthday is "28.11", not a date).
type UserProfile struct {
	Bio                   string
	Location              string
	Birthday              string
	Occupation            string
	Interests             string
	Contacts              string
	StatusLine            string
	LastSelectedCharacter string
}

// UserUpsert is the desired state of one imported users row.
type UserUpsert struct {
	// LegacyUID is the Firebase uid; it is the upsert key and is stored in
	// the hidden legacy_firebase_uid column.
	LegacyUID string
	// TargetID is the derived PocketBase record id (15 chars, [a-z0-9])
	// from the mapping table. Empty lets PocketBase generate one, which is
	// correct for a locally created account but never for an import: every
	// relation to this user is stored by a derived id (map.go).
	TargetID string
	// Email is the login identity. Required: the target forum signs in with
	// email, and the auth export is the authority for it.
	Email string
	// Verified mirrors the source's emailVerified flag.
	Verified bool
	// Password is used ONLY when the row is created. Empty means "generate
	// PocketBase's random unusable password", which is the cutover policy
	// (plan §3.1). The generated value is returned in the report because no
	// email can be sent while AERUN_MAIL_MODE=disabled.
	Password string
	// Nickname is the display name; nickname_normalized is derived from it
	// with auth.NormalizeNickname inside the writer, so the UNIQUE index and
	// the registration path can never disagree about the comparison key.
	Nickname string
	// Role is the target role id: a compiled system role or an imported
	// custom role id (1766500000). It must exist in the roles collection.
	Role string
	// CustomRoleID is the system role a custom role derives from (empty for
	// a system role); it keeps "is this account staff?" answerable from the
	// compiled matrix.
	CustomRoleID string
	// Status is the account lifecycle state (active/pending/banned).
	Status string
	// AvatarURL is the legacy avatar URL. Storage is a separate import step;
	// until it runs this is the Firebase URL the source stored.
	AvatarURL string
	// Profile holds the explicit profile columns.
	Profile UserProfile
	// Settings is the legacy preferences object, stored verbatim in the
	// users.settings JSON column (theme, language, signature, notification
	// switches, sound, reputation visibility).
	Settings map[string]any
	// CreatedAt is the historical registration date. Zero leaves PocketBase's
	// "now"; a real value is preserved through SetRaw.
	CreatedAt time.Time
}

// UserImportReport states what the import changed, so a rehearsal can prove
// idempotency by comparing two reports.
type UserImportReport struct {
	// Created, Updated and Unchanged hold legacy uids (the stable identity in
	// both databases), sorted, so two reports diff cleanly.
	Created   []string
	Updated   []string
	Unchanged []string
	// ExtraLegacyUIDs are imported rows present in the target but absent from
	// this batch. A `-root-only` bootstrap reports the rest of the export
	// here; that is informational, because the import never deletes.
	ExtraLegacyUIDs []string
	// GeneratedPasswords maps a legacy uid to the random password generated
	// for a row this call created. It is a one-time secret: print it, hand it
	// over, then discard it. It is never written anywhere else.
	GeneratedPasswords map[string]string
}

// Changed reports whether the import modified anything.
func (r UserImportReport) Changed() bool {
	return len(r.Created) > 0 || len(r.Updated) > 0
}

// ImportUsers makes the users collection match upserts exactly.
//
// It runs in a single transaction so a failure cannot leave a partially
// imported account list, and it never deletes: an existing import row that the
// batch does not mention is reported instead. The returned report names what
// changed and carries the one-time passwords generated for created rows.
func ImportUsers(app core.App, upserts []UserUpsert) (UserImportReport, error) {
	report := UserImportReport{GeneratedPasswords: map[string]string{}}
	if len(upserts) == 0 {
		return report, nil
	}
	if err := validateUserUpserts(upserts); err != nil {
		return report, err
	}

	usersCol, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return report, fmt.Errorf("users collection unavailable: %w", err)
	}

	wanted := make(map[string]UserUpsert, len(upserts))
	uids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.LegacyUID] = u
		uids = append(uids, u.LegacyUID)
	}
	sort.Strings(uids)

	err = app.RunInTransaction(func(txApp core.App) error {
		// The roles collection is the authority on what a role id may be
		// (1766500000). A user written with a role that has no registry row
		// would resolve to deny-by-default at request time, so the check
		// happens inside the same transaction that writes the accounts.
		knownRoles, err := knownRoleIDs(txApp)
		if err != nil {
			return err
		}

		existing := make(map[string]*core.Record)
		rows, err := txApp.FindAllRecords(usersCol, dbx.NewExp("legacy_firebase_uid != ''"))
		if err != nil {
			return fmt.Errorf("read imported users: %w", err)
		}
		for _, rec := range rows {
			existing[rec.GetString("legacy_firebase_uid")] = rec
		}

		for _, uid := range uids {
			u := wanted[uid]
			if !knownRoles[u.Role] {
				return fmt.Errorf(
					"user %s: role %q has no row in the roles collection; import the registry first",
					uid, u.Role)
			}

			rec, ok := existing[uid]
			if !ok {
				rec = core.NewRecord(usersCol)
				if u.TargetID != "" {
					rec.Id = u.TargetID
				}
				applyUserUpsert(rec, u)
				// SetRaw is the only assignment PocketBase honours on an
				// autodate field, so the historical registration date is
				// written here rather than inside applyUserUpsert. The value
				// is converted to the field's own type; a date the field
				// cannot parse would be a plan-builder bug, so it falls back
				// to PocketBase's "now" instead of aborting the whole batch.
				if !u.CreatedAt.IsZero() {
					if created, err := types.ParseDateTime(u.CreatedAt); err == nil {
						rec.SetRaw("created", created)
					}
				}
				if u.Password == "" {
					// PocketBase's own random unusable password: ~30
					// characters, set as a hash with the plain-value
					// validators skipped. The account cannot be reached any
					// other way while mail delivery and OAuth2 are disabled,
					// so the value is handed back to the caller.
					password := rec.SetRandomPassword()
					report.GeneratedPasswords[uid] = password
				} else {
					rec.SetPassword(u.Password)
				}
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create user %s: %w", uid, err)
				}
				report.Created = append(report.Created, uid)
				continue
			}

			// Compare before writing: applyUserUpsert would overwrite the very
			// values being compared, and every run would then report a change.
			if userRecordMatches(rec, u) {
				report.Unchanged = append(report.Unchanged, uid)
				continue
			}
			applyUserUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update user %s: %w", uid, err)
			}
			report.Updated = append(report.Updated, uid)
		}

		for uid := range existing {
			if _, ok := wanted[uid]; !ok {
				report.ExtraLegacyUIDs = append(report.ExtraLegacyUIDs, uid)
			}
		}
		sort.Strings(report.ExtraLegacyUIDs)
		return nil
	})
	if err != nil {
		return UserImportReport{}, err
	}
	return report, nil
}

// validateUserUpserts rejects a batch that cannot be written as a whole. Every
// check here is a property of the target schema or of its uniqueness indexes,
// so a batch that passes can only fail later for a genuinely unexpected reason
// (a concurrent write, or a broken database).
func validateUserUpserts(upserts []UserUpsert) error {
	seenUID := make(map[string]bool, len(upserts))
	seenEmail := make(map[string]string, len(upserts))
	seenNickname := make(map[string]string, len(upserts))
	seenID := make(map[string]string, len(upserts))

	for _, u := range upserts {
		switch {
		case u.LegacyUID == "":
			return fmt.Errorf("user upsert without legacy uid")
		case seenUID[u.LegacyUID]:
			return fmt.Errorf("duplicate user upsert %q", u.LegacyUID)
		}
		seenUID[u.LegacyUID] = true

		if err := validateUserIdentity(u); err != nil {
			return fmt.Errorf("user %s: %w", u.LegacyUID, err)
		}

		// The auth email index is case-insensitive, so the comparison key is
		// the lowercased address, exactly like PocketBase's own lookup.
		emailKey := strings.ToLower(strings.TrimSpace(u.Email))
		if prev, dup := seenEmail[emailKey]; dup {
			return fmt.Errorf("users %s and %s share the email %q", prev, u.LegacyUID, emailKey)
		}
		seenEmail[emailKey] = u.LegacyUID

		// The partial UNIQUE index on nickname_normalized is what actually
		// enforces this; checking the derived key up front turns a raw SQLite
		// constraint failure into a message that names both accounts.
		nicknameKey := auth.NormalizeNickname(u.Nickname)
		if prev, dup := seenNickname[nicknameKey]; dup {
			return fmt.Errorf(
				"users %s and %s share the nickname key %q", prev, u.LegacyUID, nicknameKey)
		}
		seenNickname[nicknameKey] = u.LegacyUID

		if u.TargetID != "" {
			if prev, dup := seenID[u.TargetID]; dup {
				return fmt.Errorf("users %s and %s share the target id %q", prev, u.LegacyUID, u.TargetID)
			}
			seenID[u.TargetID] = u.LegacyUID
		}
	}
	return nil
}

// validateUserIdentity checks the required fields of one row.
func validateUserIdentity(u UserUpsert) error {
	switch {
	case strings.TrimSpace(u.Email) == "":
		return fmt.Errorf("email is required")
	case u.Nickname == "":
		return fmt.Errorf("nickname is required")
	case auth.NormalizeNickname(u.Nickname) == "":
		return fmt.Errorf("nickname %q normalises to an empty key", u.Nickname)
	case u.Role == "":
		return fmt.Errorf("role is required")
	}
	if !auth.Status(u.Status).IsValid() {
		return fmt.Errorf("unknown status %q", u.Status)
	}
	if u.TargetID != "" && !isValidDerivedID(u.TargetID) {
		return fmt.Errorf("target id %q is not a 15 character PocketBase id", u.TargetID)
	}
	return nil
}

// isValidDerivedID mirrors PocketBase's record id format — exactly 15
// characters of [a-z0-9], as enforced by the id field pattern of every
// collection (core/collection_model.go defaultLowercaseRecordIdPattern). A
// wrong mapping table therefore fails with a readable message instead of the
// opaque save error PocketBase itself would produce.
func isValidDerivedID(id string) bool {
	if len(id) != 15 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return true
}

// knownRoleIDs returns the role ids the registry holds, as a set. An empty
// registry is not an error by itself: the caller reports the missing role and
// names the account it belongs to.
func knownRoleIDs(app core.App) (map[string]bool, error) {
	roles, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return nil, fmt.Errorf("roles collection unavailable: %w", err)
	}
	records, err := app.FindAllRecords(roles)
	if err != nil {
		return nil, fmt.Errorf("read roles: %w", err)
	}
	out := make(map[string]bool, len(records))
	for _, rec := range records {
		out[rec.GetString("role_id")] = true
	}
	return out, nil
}

// applyUserUpsert writes the desired state onto a record. It never touches the
// password or the created date: those are create-only values with their own
// rules in ImportUsers.
func applyUserUpsert(rec *core.Record, u UserUpsert) {
	rec.SetEmail(u.Email)
	rec.SetVerified(u.Verified)
	rec.Set("nickname", u.Nickname)
	rec.Set("nickname_normalized", auth.NormalizeNickname(u.Nickname))
	rec.Set("role", u.Role)
	rec.Set("custom_role_id", u.CustomRoleID)
	rec.Set("status", u.Status)
	rec.Set("legacy_firebase_uid", u.LegacyUID)
	rec.Set("avatar_url", u.AvatarURL)
	rec.Set("bio", u.Profile.Bio)
	rec.Set("location", u.Profile.Location)
	rec.Set("birthday", u.Profile.Birthday)
	rec.Set("occupation", u.Profile.Occupation)
	rec.Set("interests", u.Profile.Interests)
	rec.Set("contacts", u.Profile.Contacts)
	rec.Set("status_line", u.Profile.StatusLine)
	rec.Set("last_selected_character_id", u.Profile.LastSelectedCharacter)
	rec.Set("settings", settingsRaw(u.Settings))
}

// settingsRaw normalises the settings object to a JSON column value. An absent
// or empty object is stored as `{}`, so the column never holds null and the
// frontend never has to special-case it (the same contract as the settings
// command in settings_update.go).
func settingsRaw(settings map[string]any) types.JSONRaw {
	if len(settings) == 0 {
		return types.JSONRaw("{}")
	}
	payload, err := json.Marshal(settings)
	if err != nil {
		// A settings map that cannot be marshalled is a programming error in
		// the plan builder, not a data problem: fall back to the empty object
		// rather than writing invalid JSON into the column.
		return types.JSONRaw("{}")
	}
	return types.JSONRaw(payload)
}

// userRecordMatches reports whether rec already holds the desired state. The
// password is deliberately not compared: an existing password is never
// rewritten, so it cannot make a row look changed.
func userRecordMatches(rec *core.Record, u UserUpsert) bool {
	return rec.Email() == u.Email &&
		rec.GetBool("verified") == u.Verified &&
		rec.GetString("nickname") == u.Nickname &&
		rec.GetString("nickname_normalized") == auth.NormalizeNickname(u.Nickname) &&
		rec.GetString("role") == u.Role &&
		rec.GetString("custom_role_id") == u.CustomRoleID &&
		rec.GetString("status") == u.Status &&
		rec.GetString("legacy_firebase_uid") == u.LegacyUID &&
		rec.GetString("avatar_url") == u.AvatarURL &&
		rec.GetString("bio") == u.Profile.Bio &&
		rec.GetString("location") == u.Profile.Location &&
		rec.GetString("birthday") == u.Profile.Birthday &&
		rec.GetString("occupation") == u.Profile.Occupation &&
		rec.GetString("interests") == u.Profile.Interests &&
		rec.GetString("contacts") == u.Profile.Contacts &&
		rec.GetString("status_line") == u.Profile.StatusLine &&
		rec.GetString("last_selected_character_id") == u.Profile.LastSelectedCharacter &&
		settingsEqual(rec.Get("settings"), u.Settings)
}

// settingsEqual compares a stored settings column with the desired object by
// canonical JSON. The column round-trips through JSON (types.JSONRaw), so key
// order and number representation are the only things that could differ; a
// textual comparison of the raw value would report every run as changed.
func settingsEqual(stored any, want map[string]any) bool {
	return canonicalJSON(stored) == canonicalJSON(want)
}

// canonicalJSON renders any JSON-ish value with sorted keys and no whitespace,
// so two semantically equal documents produce the same string. A nil value —
// including a nil settings map — is the empty object rather than `null`: the
// writer stores `{}` for an absent settings object (settingsRaw), and without
// this the idempotency check would report every account without preferences
// as changed on every run.
func canonicalJSON(value any) string {
	if value == nil {
		return "{}"
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		// Not valid JSON (should not happen for a JSONField): compare the
		// bytes we got, which is still stable across runs.
		return string(raw)
	}
	if decoded == nil {
		return "{}"
	}
	normalized, err := json.Marshal(decoded)
	if err != nil {
		return string(raw)
	}
	return string(normalized)
}
