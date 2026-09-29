package importer

// Legacy accounts -> target users rows (Sprint 7 writer, level L1 of the
// dependency map in POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §5).
//
// This file is the plan half of the users writer: it turns a decoded staging
// ledger (plus the official Auth export that BuildPlan already merged into
// plan.AuthUsers) into the target state of every account. The write itself
// lives in the platform adapter (internal/platform/pocketbase/user_import.go),
// because only that package may import PocketBase.
//
// Three rules shape the translation:
//
//  1. **The auth export is the authority for credentials and email**, the
//     Firestore document for the profile. Both are needed: the document alone
//     cannot say whether the address was verified, and the export alone carries
//     no profile.
//  2. **The legacy settings object migrates verbatim** into users.settings —
//     that is where the adapted frontend reads theme, language, signature,
//     notification switches, sound and reputation visibility from
//     (src/pages/ProfilePage.jsx). The profile fields it does *not* contain
//     (bio, location, birthday, occupation, interests, contacts, status_line,
//     last_selected_character_id) have explicit columns since migration
//     1766900000 and are written flat.
//  3. **Derived data is never imported.** post_count, topics_count and
//     reputation are recomputed by the post-import pass; characters belong to
//     the characters collection (L4), not inside settings — the analysis-stage
//     fold (finding `character_docs_folded_into_user_settings`) is explicitly
//     NOT repeated here. Every one of those decisions is reported, so a
//     reviewer sees exactly what the write does and does not carry over.
//
// A legacy account document with no email anywhere cannot become an auth
// record: it is skipped and reported (`user_email_missing`) instead of being
// invented with a placeholder address, which would create an account nobody
// could ever sign in to.
//
// What is deliberately NOT imported:
//
//   - `admin_message` — a message *to the moderator* in the legacy UI
//     ("This message will only be seen by the moderator"), while the only users
//     read rule publishes every active profile. It needs a private column plus
//     a staff-only read command before it can be migrated; until then it is
//     reported (`admin_message_not_imported`) so it is not silently lost.
//   - passwords — the Firebase hash cannot be replayed (plan §3.1). The writer
//     sets a create-only password: the operator's for the root bootstrap, or
//     PocketBase's random unusable one.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	pb "github.com/SiJunma/aerun/backend/internal/platform/pocketbase"
)

// firebaseStorageMarkers identify a URL that points at a Firebase Storage
// object. Such a file belongs to the Storage import step; until that step runs
// the value is the source URL, and the row is reported so nobody mistakes it
// for a migrated link.
var firebaseStorageMarkers = []string{
	"firebasestorage.googleapis.com",
	"firebasestorage.app",
}

// UserProfileRow is the profile part of a planned row, mirroring the explicit
// users columns added by migration 1766900000.
type UserProfileRow struct {
	Bio                   string
	Location              string
	Birthday              string
	Occupation            string
	Interests             string
	Contacts              string
	StatusLine            string
	LastSelectedCharacter string
}

// UserRow is the target state of one users row.
type UserRow struct {
	// LegacyUID is the Firebase uid: the upsert key, stored in the hidden
	// legacy_firebase_uid column.
	LegacyUID string
	// TargetID is the derived PocketBase id (DeriveID(SpaceUser, uid)), the
	// same value the mapping table and every relation use.
	TargetID string
	// Email and Verified come from the auth export when it holds the account.
	Email    string
	Verified bool
	// Nickname is the display name; the uniqueness key is derived from it by
	// the writer (auth.NormalizeNickname), never stored here.
	Nickname string
	// Role, CustomRoleID and Status are the translated identity (compat.go).
	Role         string
	CustomRoleID string
	Status       string
	// AvatarURL is the source avatar reference.
	AvatarURL string
	// Profile holds the explicit profile columns.
	Profile UserProfileRow
	// Settings is the legacy preferences object, migrated verbatim.
	Settings map[string]any
	// CreatedAt is the historical registration date (zero when unknown), so
	// the target keeps the account's real age.
	CreatedAt time.Time
	// Password is applied ONLY when the row is created. The root bootstrap
	// sets it so the owner can sign in while mail and OAuth2 are disabled;
	// left empty, the writer generates an unusable random password.
	Password string
	// Findings maps a finding code to the detail shown for this row.
	Findings map[string]string
}

// note records a finding for this row. The code also becomes a plan-level
// finding whose example is this row's detail, which is how one report line
// explains every affected account.
func (r *UserRow) note(code, detail string) {
	if r.Findings == nil {
		r.Findings = make(map[string]string, 4)
	}
	r.Findings[code] = detail
}

// UserPlan is the full result of planning the users import.
type UserPlan struct {
	// Rows are the accounts to write, sorted by legacy uid.
	Rows []UserRow
	// Findings explains every non-trivial decision, aggregated per code.
	Findings map[string]*Finding
	// SkippedUIDs are legacy accounts that cannot become auth records (no
	// email anywhere). They are reported, never guessed at.
	SkippedUIDs []string
	// RootUID is the uid of the account whose source document carries
	// role_id "root" — the forum owner's account, and the only one a bootstrap
	// run needs. Empty when the export has none or more than one, which is
	// itself a finding.
	RootUID string
}

// BuildUserPlan translates every legacy account document into a target row.
//
// isReservedNickname is the compiled reserved-name predicate
// (auth.IsReservedNickname), passed in so this package stays free of
// internal/auth — the command adapter supplies it, exactly like the role specs
// passed to BuildRolePlan. An imported nickname the predicate rejects is still
// imported: refusing it would lock a real member out of the migration, so it is
// reported instead and staff can rename the account through the admin command.
func BuildUserPlan(plan *ImportPlan, isReservedNickname func(string) bool) *UserPlan {
	up := &UserPlan{Findings: make(map[string]*Finding)}

	roots := make([]string, 0, 1)
	for _, uid := range sortedKeys(plan.Users) {
		if containsSlash(uid) {
			// Character subcollection rows share this bucket with their
			// parent account (importer.go classifies them here). They are not
			// accounts, and they are imported into the characters collection.
			continue
		}
		fields := plan.Users[uid]

		row, ok := buildUserRow(plan, uid, fields, isReservedNickname)
		if !ok {
			up.SkippedUIDs = append(up.SkippedUIDs, uid)
			continue
		}
		if identity := MapUserRole(plan, fields); identity.LegacyRole == "root" {
			roots = append(roots, uid)
		}
		up.Rows = append(up.Rows, row)
	}
	sort.Strings(up.SkippedUIDs)
	up.summarize()

	// The root account is identified by the *source document*, not by the
	// resolved role: a suspended root (role_id "pending" with
	// previous_role_id "root") resolves back to the root role, but the owner's
	// live account is the document that says role_id "root".
	switch len(roots) {
	case 1:
		up.RootUID = roots[0]
	case 0:
		up.note("root_admin_missing", "")
	default:
		up.note("root_admin_not_unique", strings.Join(roots, ","))
	}

	if len(up.Rows) > 0 {
		up.note("password_not_transferable", fmt.Sprintf("accounts=%d", len(up.Rows)))
	}
	return up
}

// buildUserRow translates one account document. ok is false when the document
// cannot become an auth record, in which case the row already carries the
// finding that explains why.
func buildUserRow(plan *ImportPlan, uid string, fields map[string]any, isReservedNickname func(string) bool) (UserRow, bool) {
	row := UserRow{
		LegacyUID: uid,
		TargetID:  DeriveID(SpaceUser, uid),
		AvatarURL: stringField(fields, "avatar_url"),
		Findings:  make(map[string]string, 4),
	}

	authUser := plan.AuthUsers[uid]
	if authUser == nil {
		// No credentials metadata for this account: the profile still
		// imports, but verified cannot be true and the provider link has to be
		// checked before launch (plan §3.1).
		row.note("user_without_auth_record", uid)
	}

	email := ""
	if authUser != nil {
		email = normalizeEmail(authUser.Email)
		row.Verified = authUser.EmailVerified
	}
	if email == "" {
		email = normalizeEmail(stringField(fields, "email"))
		if email != "" {
			row.note("user_email_from_legacy_document", uid)
		}
	}
	if email == "" {
		row.note("user_email_missing", uid)
		return row, false
	}
	row.Email = email
	row.Nickname = userNickname(&row, uid, fields, authUser, email, isReservedNickname)

	identity := MapUserRole(plan, fields)
	row.Role = identity.Role
	row.CustomRoleID = identity.BaseRoleID
	row.Status = identity.Status
	switch {
	case identity.CustomRole != "":
		// The custom role id is kept verbatim and its system base is recorded
		// in custom_role_id (1766500000).
		row.note("custom_role_assigned", fmt.Sprintf("%s=%s(base %s)", uid, identity.CustomRole, identity.BaseRoleID))
	case identity.Role != identity.LegacyRole:
		// A pseudo-role or unknown id became a status plus a safe role.
		row.note("user_role_translated", fmt.Sprintf(
			"%s legacy=%q -> role=%s status=%s", uid, identity.LegacyRole, identity.Role, identity.Status))
	}

	row.Profile = UserProfileRow{
		Bio:                   stringField(fields, "bio"),
		Location:              stringField(fields, "location"),
		Birthday:              stringField(fields, "birthday"),
		Occupation:            stringField(fields, "occupation"),
		Interests:             stringField(fields, "interests"),
		Contacts:              stringField(fields, "contacts"),
		StatusLine:            stringField(fields, "status_line"),
		LastSelectedCharacter: stringField(fields, "last_selected_character_id"),
	}
	row.Settings = userSettings(&row, uid, fields)
	row.CreatedAt = userCreatedAt(fields, authUser)

	if isFirebaseStorageURL(row.AvatarURL) {
		row.note("avatar_url_pending_storage_rewrite", uid)
	}
	if stringField(fields, "admin_message") != "" {
		row.note("admin_message_not_imported", uid)
	}
	if counters := userCounterFields(fields); len(counters) > 0 {
		row.note("user_counters_deferred_to_rebuild",
			fmt.Sprintf("%s %s", uid, strings.Join(counters, "+")))
	}
	if chars := characterRowCount(plan, uid); chars > 0 {
		row.note("user_characters_owned_by_characters_writer", fmt.Sprintf("%s=%d", uid, chars))
	}
	return row, true
}

// userNickname resolves the display name with an explicit fallback chain, each
// step of which is reported. The chain never yields an empty value: nickname is
// a required column and the partial UNIQUE index on its normalised form must
// stay meaningful.
func userNickname(row *UserRow, uid string, fields map[string]any, authUser *AuthExportUser, email string, isReservedNickname func(string) bool) string {
	nickname := strings.TrimSpace(stringField(fields, "nickname"))
	if nickname == "" && authUser != nil {
		nickname = strings.TrimSpace(authUser.DisplayName)
		if nickname != "" {
			row.note("user_nickname_from_provider", uid)
		}
	}
	if nickname == "" {
		if local := emailLocalPart(email); local != "" {
			nickname = local
			row.note("user_nickname_from_email", uid)
		}
	}
	if nickname == "" {
		// Last resort: a stable, non-impersonating placeholder derived from
		// the uid. It is reported, so staff can rename the account.
		suffix := uid
		if len(suffix) > 8 {
			suffix = suffix[:8]
		}
		nickname = "user-" + suffix
		row.note("user_nickname_generated", uid)
	}
	if isReservedNickname != nil && isReservedNickname(nickname) {
		// Imported verbatim: the account already carries this name in the
		// live forum, and refusing the row would drop a real member. Staff
		// rename it later through the admin command, which enforces the
		// reserved list.
		row.note("user_nickname_reserved", fmt.Sprintf("%s=%q", uid, nickname))
	}
	return nickname
}

// userSettings copies the legacy preferences object. The copy is shallow on
// purpose: the nested values are decoded JSON (maps, slices, scalars) that
// nothing mutates, and re-encoding them here would risk changing their shape.
func userSettings(row *UserRow, uid string, fields map[string]any) map[string]any {
	raw, ok := fields["settings"].(map[string]any)
	if !ok || len(raw) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(raw))
	for key, value := range raw {
		out[key] = value
	}
	// The staging export has never carried characters inside settings (they
	// live in a subcollection), but a future snapshot might. If it does, the
	// key is kept verbatim and reported, because moving it into the characters
	// collection is the characters writer's decision, not a silent edit here.
	if _, hasCharacters := out["characters"]; hasCharacters {
		row.note("settings_characters_key_left_verbatim", uid)
	}
	return out
}

// userCreatedAt returns the account's historical registration date: the
// Firestore document is authoritative, the auth export is the fallback (its
// createdAt is epoch milliseconds as a string).
func userCreatedAt(fields map[string]any, authUser *AuthExportUser) time.Time {
	if created := timeField(fields, "created_at"); !created.IsZero() {
		return created.UTC()
	}
	if authUser == nil {
		return time.Time{}
	}
	millis, err := strconv.ParseInt(strings.TrimSpace(authUser.CreatedAt), 10, 64)
	if err != nil || millis <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(millis).UTC()
}

// userCounterFields lists the cached counters present on the document. They are
// never imported; naming them in the report is what makes the omission
// verifiable instead of a silent difference.
func userCounterFields(fields map[string]any) []string {
	out := make([]string, 0, 3)
	for _, name := range []string{"post_count", "topics_count", "reputation"} {
		if _, ok := fields[name]; ok {
			out = append(out, name)
		}
	}
	return out
}

// characterRowCount counts the character subcollection rows the classifier
// parked under this uid in plan.Users.
func characterRowCount(plan *ImportPlan, uid string) int {
	prefix := uid + "/characters/"
	count := 0
	for key := range plan.Users {
		if strings.HasPrefix(key, prefix) {
			count++
		}
	}
	return count
}

// isFirebaseStorageURL reports whether a URL points at Firebase Storage, i.e.
// at a file the Storage import step still has to fetch and rehost.
func isFirebaseStorageURL(url string) bool {
	if url == "" {
		return false
	}
	for _, marker := range firebaseStorageMarkers {
		if strings.Contains(url, marker) {
			return true
		}
	}
	return false
}

// normalizeEmail lowercases and trims an address. PocketBase's email lookup is
// case-insensitive, so storing the canonical form keeps a later comparison (and
// the idempotency check) honest.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// emailLocalPart returns the part before "@", or "" when the address carries
// none.
func emailLocalPart(email string) string {
	at := strings.Index(email, "@")
	if at <= 0 {
		return ""
	}
	return email[:at]
}

// RootAdminRow returns the account a bootstrap run imports. It fails when the
// export does not identify exactly one, because "which account owns the forum"
// is a question the tooling must not answer by guessing.
func (up *UserPlan) RootAdminRow() (UserRow, error) {
	switch {
	case up.RootUID == "":
		return UserRow{}, fmt.Errorf(
			"the export does not identify exactly one root account (legacy role_id \"root\"); " +
				"use -uid to select an account explicitly")
	default:
		for _, row := range up.Rows {
			if row.LegacyUID == up.RootUID {
				return row, nil
			}
		}
	}
	return UserRow{}, fmt.Errorf("root account %s has no planned row", up.RootUID)
}

// Subset returns a plan holding only the listed accounts, with the findings
// recomputed for that selection — so a `-root-only` bootstrap reports the root
// account's decisions and nothing about the accounts it did not touch.
func (up *UserPlan) Subset(uids []string) (*UserPlan, error) {
	wanted := make(map[string]bool, len(uids))
	for _, uid := range uids {
		if uid != "" {
			wanted[uid] = true
		}
	}
	if len(wanted) == 0 {
		return nil, fmt.Errorf("no account selected")
	}

	sub := &UserPlan{Findings: make(map[string]*Finding), RootUID: up.RootUID}
	found := make(map[string]bool, len(wanted))
	for _, row := range up.Rows {
		if !wanted[row.LegacyUID] {
			continue
		}
		sub.Rows = append(sub.Rows, row)
		found[row.LegacyUID] = true
	}

	missing := make([]string, 0)
	for uid := range wanted {
		if !found[uid] {
			missing = append(missing, uid)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("no planned account for: %s", strings.Join(missing, ", "))
	}
	sub.summarize()
	sub.note("password_not_transferable", fmt.Sprintf("accounts=%d", len(sub.Rows)))
	return sub, nil
}

// summarize aggregates the per-row findings into the plan-level report, in a
// deterministic order (rows are sorted, and a row's codes are sorted).
func (up *UserPlan) summarize() {
	for _, row := range up.Rows {
		for _, code := range sortedKeys(row.Findings) {
			up.note(code, row.Findings[code])
		}
	}
}

// note records one plan-level finding occurrence.
func (up *UserPlan) note(code, example string) {
	if up.Findings == nil {
		up.Findings = make(map[string]*Finding)
	}
	f, ok := up.Findings[code]
	if !ok {
		f = &Finding{Code: code}
		up.Findings[code] = f
	}
	f.Count++
	f.Examples = appendBounded(f.Examples, example)
}

// SortedRowLines renders one line per planned account, so a reviewer can read
// exactly what will be written without opening the database.
func (up *UserPlan) SortedRowLines() []string {
	lines := make([]string, 0, len(up.Rows))
	for _, row := range up.Rows {
		line := fmt.Sprintf("%s id=%s email=%s nickname=%q role=%s", row.LegacyUID, row.TargetID, row.Email, row.Nickname, row.Role)
		if row.CustomRoleID != "" {
			line += fmt.Sprintf(" base=%s", row.CustomRoleID)
		}
		line += fmt.Sprintf(" status=%s verified=%t", row.Status, row.Verified)
		if !row.CreatedAt.IsZero() {
			line += fmt.Sprintf(" created=%s", row.CreatedAt.Format("2006-01-02"))
		}
		for _, code := range sortedKeys(row.Findings) {
			line += fmt.Sprintf("\n    finding %s %s", code, row.Findings[code])
		}
		lines = append(lines, line)
	}
	return lines
}

// Upserts converts the planned rows into the platform package's write type. The
// importer is the only allowed direction of that dependency: the tool depends
// on the platform, never the reverse.
func (up *UserPlan) Upserts() []pb.UserUpsert {
	out := make([]pb.UserUpsert, 0, len(up.Rows))
	for _, row := range up.Rows {
		out = append(out, pb.UserUpsert{
			LegacyUID:    row.LegacyUID,
			TargetID:     row.TargetID,
			Email:        row.Email,
			Verified:     row.Verified,
			Password:     row.Password,
			Nickname:     row.Nickname,
			Role:         row.Role,
			CustomRoleID: row.CustomRoleID,
			Status:       row.Status,
			AvatarURL:    row.AvatarURL,
			Profile: pb.UserProfile{
				Bio:                   row.Profile.Bio,
				Location:              row.Profile.Location,
				Birthday:              row.Profile.Birthday,
				Occupation:            row.Profile.Occupation,
				Interests:             row.Profile.Interests,
				Contacts:              row.Profile.Contacts,
				StatusLine:            row.Profile.StatusLine,
				LastSelectedCharacter: row.Profile.LastSelectedCharacter,
			},
			Settings:  row.Settings,
			CreatedAt: row.CreatedAt,
		})
	}
	return out
}
