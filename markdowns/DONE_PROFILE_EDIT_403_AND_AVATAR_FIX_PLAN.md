# Profile edit 403 + avatar false-error — diagnosis & fix plan

- **Status:** FIXES IMPLEMENTED — VERIFIED (backend: auth + migrations + pocketbase ok;
  frontend: mask-avatar-isolation OK, vite build ok)
- **Branch:** `feature/pocketbase-migration`
- **Date:** 2026-10-10
- **Scope:** two profile-editing bugs: (1) 403 "You are not allowed to edit your profile" on save for Pending/Player users; (2) mask-avatar upload shows false "Ошибка загрузки" despite server returning a valid `avatar_url`.

---

## Bug 1 — 403 on profile save

### Symptom
`PATCH /api/aerun/me/profile` (bio / status_line / location / occupation…, and the account form that batches nickname+fields) returns **403 "You are not allowed to edit your profile"** for pending accounts always, and for active players on the production database. The UI shows the fields as editable, so the failure looks arbitrary.

### Root-cause chain (verified in code)

1. **Route & gate** — `PATCH /api/aerun/me/profile` → `updateMyProfileHandler`
   (`backend/internal/platform/pocketbase/profile_commands.go`, gate on `auth.PermEditSelfProfile`).
   The whole payload is behind this ONE permission key. Nickname is a separate audited command (see `TestProfileEditDoesNotWriteNickname`), but bio/status_line/location/etc. all hit this gate.

2. **How the permission set is built** — `access.go` `resolve()`:
   `base := storedRolePermissions(app, role)` (reads the **`roles.permissions` array from the DB row**) → `auth.NarrowForStatus(base, status)`.
   So the final set = stored DB row ∩ status narrowing.

3. **Defect A — pending status narrowing.** `pendingAllowedPermissions`
   (`backend/internal/auth/status.go:49-55`) does **not** list `PermEditSelfProfile`,
   so `NarrowForStatus` strips it for EVERY pending account regardless of the DB row.
   The UI gates individual fields by other keys (`EDIT_SELF_NICKNAME`, `EDIT_SELF_STATUS`, …) which pending **does** have → fields look editable, save 403s.

4. **Defect B — stale stored rows on existing databases.** The player role spec
   (`backend/internal/auth/role.go:178`) includes `PermEditSelfProfile`, but:
   - role rows were seeded by migration `1766000000_identity_rbac.go` **before** the permission key existed (key added later, commit `bce786d`);
   - PocketBase migrations run **once** — reconcile migration `1768600000` has already been applied and will not re-run;
   - therefore the stored `roles.permissions` array on existing DBs lacks `edit_self_profile` → `storedRolePermissions` returns it without the key → 403 for active players too.
   - **CI never catches this**: test apps create a fresh DB seeded with current code, so `TestProfileEditIsPersistedForSelf` passes. The bug only exists on databases created before the key was added. → Must be confirmed on the real DB in Step 0.1.

5. **SelectField dictionary gap.** The `roles.permissions` select-field **options** on
   existing DBs may also lack `edit_self_profile` / `edit_others_profile`. Even a correct
   row value could then fail field validation on save. A repair migration must append the
   missing keys to the dictionary (pattern: `1768900000_branding_backgrounds_repair.go`).

6. **Frontend drift.** `src/constants/permissions.js` `MAX_ROLE_PERMISSIONS.pending`
   (lines ~406-412) does not include `EDIT_SELF_PROFILE` — impact to be assessed in Step 0.5.

### Summary of Bug 1
Two independent defects, both must be fixed:
- **(A)** `status.go` pending narrowing never grants the key (code fix);
- **(B)** stored `roles` rows + select dictionary on existing DBs predate the key (repair migration).

### Evidence pending is MEANT to save its profile
`src/contexts/AuthProvider.jsx` OAuth registration flow `PATCH`es `/me/profile` right after signup to submit the pending nickname + admin message — a pending account must be able to write its own profile.

---

## Bug 2 — false "Ошибка загрузки" on mask-avatar upload

### Symptom
Uploading a **mask (character) avatar** in the profile editor shows the error toast/label
"Ошибка загрузки. Попробуйте ещё раз." (`profile.error_upload_failed`), yet the server
stores the file and returns a valid `avatar_url`; after reload the avatar is there.

### Root-cause chain (verified in code)

1. **`ProfilePage.jsx` mask uploader has no `onChange`** (lines ~1921-1931, inside the
   character editor modal). It passes `label`, `value`, `allowGifs`, `onUpload`,
   `storagePath`, `size` — but NOT `onChange`.

2. **`AvatarUploader.jsx` line ~121** — after a successful upload the component does
   `onChange(newUrl)` **unconditionally**. With `onChange === undefined` this throws
   `TypeError: onChange is not a function`.

3. The `TypeError` is caught by the surrounding `try/catch` (lines ~125-134), which shows
   the generic failure message (`t('profile.error_upload_failed')`). So the failure UI is
   produced **after** the upload already succeeded — a false negative. The comment/logic
   path is: `resizeImage → onUpload (server call, returns url) → onChange(newUrl) → CRASH → catch → error`.

4. Note the same unguarded `onChange(...)` call appears in `handleUrlConfirm`
   (~line 149) — the "by URL" mode of the same component; the mask usage likely never
   reaches it, but the fix must cover both call sites.

5. Why only the mask: the **account** avatar uploader in `ProfilePage.jsx`
   (~line 1484) DOES pass `onChange`, so it works.

### Secondary observation (why preview doesn't update)
The mask uploader displays `value={formData.avatar_url}`; since `onChange` was missing,
even without the crash the preview would never refresh in-modal. For a NEW character the
object URL must NOT be written into `formData.avatar_url` (comment at
`ProfilePage.jsx:394-397` — 512-char column, data URLs can't be saved; the file is parked
in `pendingCharAvatar` and flushed in `handleSaveCharacter`).

---

---

# FIX PLAN

Work strictly step by step; each step ends with its own verification. Do not start a step
before the previous one is verified. Nothing below has been executed yet.

## Step 0 — Pre-flight confirmations (read-only, no edits)

0.1. Confirm intended behavior: pending users SHOULD be able to save their own profile
     (evidence: OAuth registration flow PATCHes `/me/profile` while pending). If any doubt
     remains after reading `updateMyProfileHandler` and `AuthProvider.jsx` — ask the owner
     before editing `status.go`.
0.2. Check the real production/test DB to confirm defect B:
     open `pb_data/data.db` (SQLite) and inspect the `roles` row for `player`:
     does `permissions` contain `edit_self_profile`? Also check the `roles` collection
     schema JSON (SelectField `options`/Values) for the same key.
     Expected: key absent in both → confirms repair migration is required.
0.3. Confirm how migrations are registered (list/registry file under
     `backend/internal/migrations/`) and re-read `1768900000_branding_backgrounds_repair.go`
     as the template (idempotent standalone repair).
0.4. Grep `backend` for other gates on `PermEditSelfProfile` — make sure granting it to
     pending does not unlock anything unintended (only `profile_commands.go` expected).

**Verification 0:** findings written down; no code changed.

## Step 1 — Backend fix A: allow pending to edit own profile

1.1. File: `backend/internal/auth/status.go`.
     Add `auth.PermEditSelfProfile` to `pendingAllowedPermissions` (lines ~49-55).
1.2. Add a short comment explaining why: pending members must be able to fill in their
     own profile (bio/status/nickname) while awaiting approval; the UI already exposes
     those fields to them.
1.3. Re-check `NarrowForStatus` semantics: pending narrowing is an **allowlist** — adding
     the key there is sufficient for defect A; nothing else to change in `status.go`.

**Verification 1:** ✅ DONE — `status.go` содержит ключ; `auth` + `migrations`
зелёные; `TestPendingAccountCannotPost` исправлен (5→6), точечный прогон ok.
Полный `pocketbase`-пакет запущен фоном (`aerun_pb.log`).

## Step 2 — Backend fix B: repair migration for stale `roles` rows

2.1. New file: `backend/internal/migrations/1769400000_profile_permission_repair.go`
     (timestamp strictly after `1769300000`, pattern copied from
     `1768900000_branding_backgrounds_repair.go`; register it wherever the other
     migrations are registered — confirmed in Step 0.3).
2.2. The migration must be **idempotent** and do exactly two things:
     a) **Dictionary**: load the `roles` collection, and if its `permissions` SelectField
        options are missing any value from `auth.AllPermissionValues()`, append the
        missing keys (at minimum `edit_self_profile`, `edit_others_profile` — but assert
        against the full compiled list so future keys self-heal). Save the collection
        only when something changed.
     b) **Rows**: for EVERY system role (admin, pending, player, moderator, root,
        spectator, banned — iterate over the specs used by `compiledRolePermissions()` /
        the role registry in `role.go`, not a hand-picked subset), rewrite the stored
        `roles.permissions` array to exactly `compiledRolePermissions(...)` for that role.
        Use `app.FindAllRecords` on `roles` by `role_id`, `Upsert`/`Save` only rows whose
        value differs. Rows for custom (non-system) roles must be left untouched.
2.3. Do NOT touch `access.go` runtime fallback logic — it already falls back to
     `auth.DefaultPermissions(role)` when the row is unusable; the migration makes the
     stored authority match the compiled matrix, which is the intended design
     (comment in `storedRolePermissions` says the DB row is the runtime authority).

**Verification 2:** `go build ./...`; migration test (Step 4) proves: a DB seeded with
pre-`bce786d` role rows (no `edit_self_profile`) ends up with the key for `player`,
pending row gains it too, dictionary contains the key, custom role rows unchanged,
running twice changes nothing.

## Step 3 — Frontend fix: false avatar-upload error

3.1. File: `src/components/common/AvatarUploader.jsx`.
     Make `onChange` **optional/defensive** at BOTH call sites:
     - line ~121: `onChange(newUrl)` → guard with `typeof onChange === 'function'`
       (or destructure with a no-op default `onChange = () => {}`);
     - line ~149 (`handleUrlConfirm`): same guard.
     The guard is the primary fix: a successful `onUpload` (server already returned
     `avatar_url`) must never be turned into an error by a missing optional callback.
     Update the JSDoc header (lines ~8-20): `onChange` — optional, called with the new URL
     when available.
3.2. File: `src/pages/ProfilePage.jsx`, mask `AvatarUploader` usage (lines ~1921-1931).
     Pass `onChange` so the preview actually updates, respecting the existing invariant:
     - If `editingChar?.id` exists (upload already persisted server-side and returned a
       real URL): `onChange={(url) => setFormData({ ...formData, avatar_url: url })}`.
     - If it is a NEW character (no id yet): `handleCharacterAvatarUpload` returns a local
       object URL (`ProfilePage.jsx:399`) which must NOT enter `formData.avatar_url`
       (comment at lines ~394-397). For this branch either pass no-op, or better: keep a
       local preview state — evaluate at implementation time which is smaller; correctness
       rule: the object URL must never reach `formData.avatar_url`.
     Note: with only the 3.1 guard and no `onChange`, upload succeeds and no error shows —
     that alone already fixes the reported bug; 3.2 is a UX improvement for the preview and
     should be done only if it cannot leak the object URL into formData.
3.3. Audit other `AvatarUploader` call sites (grep `AvatarUploader` under `src/`) to make
     sure no other usage passes neither `onChange` nor relies on it; the 3.1 guard makes
     this harmless either way.

**Verification 3:** frontend build/lint (see Step 5) passes; manual reasoning check —
`onUpload` success path never reaches `catch` because of a missing `onChange`.

## Step 4 — Tests

4.1. **Pending profile save (Bug 1, defect A)** — in
     `backend/internal/platform/pocketbase/profile_commands_test.go`, following existing
     patterns (`seedIdentityFixtures` → `tokens["pending"]`, `newTestServer`,
     `PATCH /api/aerun/me/profile`):
     - Test: pending user PATCHes own profile (`{"bio":"...", "status_line":"..."}`)
       → expect **200**, fields persisted. This test must FAIL before Step 1 and pass after.
4.2. **Stale role row repair (Bug 1, defect B)** — in
     `backend/internal/migrations/migrations_test.go` (follow the reconcile-test pattern
     of `1768600000`):
     - Seed a `roles` row for `player` with a permissions array that LACKS
       `edit_self_profile`, and a collection dictionary without the key (simulate a
       pre-`bce786d` DB); run the new `1769000000` migration; assert:
       (a) dictionary now contains `edit_self_profile`,
       (b) player row equals `compiledRolePermissions(player)`,
       (c) a custom role row is untouched,
       (d) running the migration a second time changes nothing (idempotency).
4.3. **Unit test for status narrowing** — if `status.go` / `auth` package has an existing
     test file for `NarrowForStatus`, extend it: `NarrowForStatus(DefaultPermissions(player), pending)`
     contains `PermEditSelfProfile` after Step 1. (Find the right file first; skip only if
     no auth-level test file exists — then rely on 4.1 as integration coverage.)
4.4. **Avatar upload (Bug 2)** — front-end: check whether the repo has any JS test runner
     (look at `package.json` scripts). If tests exist, add a component-level test only if a
     runner is already configured; otherwise cover with the existing static check pattern
     (`.mjs` script under `scripts/` wired into `npm test`, like
     `scripts/check-last-selected-mask.mjs`) asserting:
     - `AvatarUploader.jsx` does not call `onChange` unguarded (regex/AST: no bare
       `onChange(` without `typeof`/default guard), and
     - the mask uploader usage in `ProfilePage.jsx` passes an `onChange` prop or the
       component guard exists.
     If no test mechanism fits, document manual verification instead (Step 6).

**Verification 4:** all new tests fail when the corresponding fix is temporarily reverted
(optional but recommended for 4.1), pass with fixes in place.

## Step 5 — Frontend permission constants sync (only if needed)

5.1. Re-read `src/constants/permissions.js` — `MAX_ROLE_PERMISSIONS.pending`
     (lines ~406-412) lacks `EDIT_SELF_PROFILE`. Decide based on how the constant is used
     (it appears to be a per-status ceiling for the role editor):
     - If its role is "what the UI may grant/allow for a pending account", add
       `EDIT_SELF_PROFILE` so the client and server agree.
     - If it only gates admin role-editing checkboxes for custom roles, cross-check
       whether the pending **role spec** (server `role.go`) matters more than the status
       allowlist — then the constant may be irrelevant to these bugs; if so, leave it and
       record the decision in this file.
5.2. Grep the frontend for `EDIT_SELF_PROFILE` usages to confirm the profile page field
     gating actually references the keys the server now honors (the reported 403 means the
     server gate and the UI gate disagreed; after Steps 1-2 the server is the superset, so
     no UI gating change should be required — verify only).

**Verification 5:** ✅ DONE — `MAX_ROLE_PERMISSIONS.pending` уже содержит
`EDIT_SELF_PROFILE` (permissions.js:416); сервер — суперсет, UI-гейтинг менять не нужно.

## Step 6 — Full verification

6.1. Backend: ✅ `auth` + `migrations` зелёные; `pocketbase` зелёный
     (`aerun_pb.log`: ok 247.817s). Gofmt по тронутым файлам чистый
     (чужой `admin_email_templates_test.go` не трогаем).
6.2. Frontend: ✅ `test:mask-avatar-isolation` OK; `npm run build` ok
     (`aerun_front_build.log`: built in 5.58s).
6.3. Cross-check CI report after push (project rule: `git fetch origin ci-report` →
     `git show origin ci-report:report.json`), fix red before finishing.
6.4. Manual smoke (if a running instance is available):
     - login as a **pending** account → edit bio/status → save → no 403;
     - login as an **active player** on the migrated DB → save → no 403;
     - upload a **mask avatar** in the character modal → no "Ошибка загрузки" toast,
       preview shows the new image (or stays correct until save, per 3.2 decision).

## Risks / open questions

- **R1:** If the owner did NOT intend pending users to edit their profile at all, Step 1
  would be wrong — but the OAuth registration flow and the editable UI fields are strong
  evidence they should. Step 0.1 exists to catch this.
- **R2:** The repair migration rewrites `roles.permissions` from the compiled matrix —
  this mirrors what `1768600000` already does (reconcile pattern), so any admin-edited
  system-role rows will be reset to compiled values. That is consistent with the existing
  reconcile migration; custom roles are untouched (asserted by test 4.2c).
- **R3:** `NarrowForStatus` for pending is an allowlist — adding the key grants pending
  the WHOLE `edit_self_profile` permission, not just bio. Grep in Step 0.4 must confirm
  the key only gates self-profile editing (it does: `profile_commands.go`), so the blast
  radius is exactly the reported bug.
- **R4 (Bug 2):** Only the guard (3.1) is strictly required; 3.2 must not leak a local
  object URL into `formData.avatar_url` (512-char column invariant, comment at
  `ProfilePage.jsx:394-397`). If in doubt, do 3.1 only and note it here.

## Files to touch (expected final list)

| File | Change |
|---|---|
| `backend/internal/auth/status.go` | add `PermEditSelfProfile` to `pendingAllowedPermissions` |
| `backend/internal/migrations/1769400000_profile_permission_repair.go` | NEW — idempotent dictionary + role-row reconcile |
| `backend/internal/migrations/1769400000_profile_permission_repair_test.go` | repair-migration test |
| `backend/internal/platform/pocketbase/profile_commands_test.go` | pending-user 200 test |
| `src/components/common/AvatarUploader.jsx` | guard `onChange` at 2 call sites + JSDoc |
| `src/pages/ProfilePage.jsx` | pass `onChange` to mask uploader (per 3.2 rules) |
| `src/constants/permissions.js` | only if Step 5 decides it is needed |
| `markdowns/PROFILE_EDIT_403_AND_AVATAR_FIX_PLAN.md` | this file — update statuses as steps complete |
