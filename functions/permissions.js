// Permission data is security-sensitive. It is read fresh for every callable
// invocation so a revoked category or role is effective on the next request.
const TTL_MS = 0;
let cache = { at: 0, roles: null, categories: null, settings: null };

function invalidateContext() {
  cache = { at: 0, roles: null, categories: null, settings: null };
}

/**
 * roles/categories/settings are tiny and change rarely, but every callable was
 * re-reading all three on every single invocation. Cache them per instance.
 */
async function loadContext(db) {
  const now = Date.now();
  if (cache.roles && now - cache.at < TTL_MS) return cache;

  const [rolesSnap, catsSnap, settingsSnap] = await Promise.all([
    db.collection("roles").get(),
    db.collection("categories").get(),
    db.collection("settings").doc("global").get(),
  ]);

  const roles = {};
  rolesSnap.forEach(d => { roles[d.id] = d.data(); });
  const categories = {};
  catsSnap.forEach(d => { categories[d.id] = d.data(); });

  cache = { at: now, roles, categories, settings: settingsSnap.exists ? settingsSnap.data() : {} };
  return cache;
}

/** Mirrors AuthProvider: a pending user is treated as a spectator while whitelistMode is off. */
function effectiveRole(roleId, settings) {
  if (roleId === "pending" && !settings.whitelistMode) return "spectator";
  return roleId || "guest";
}

/** Normalises a category-level permission value to an array of role ids.
 *  Accepts arrays, {role: true} maps, and single strings; anything else → []. */
function normaliseAllowedRoles(raw) {
  if (Array.isArray(raw)) return raw.filter(r => typeof r === 'string');
  if (typeof raw === 'string') return [raw];
  if (raw && typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([, v]) => v === true || v === 'true')
      .map(([k]) => k);
  }
  return [];
}

/**
 * THE single implementation of view_forum:
 *   category override wins -> otherwise the role's global permission list,
 *   base_role_id inheritance honoured in both branches.
 * A missing category denies (getSecuredPosts used to allow it — decide once).
 */
function hasViewForum(rawRole, categoryId, ctx) {
  if (rawRole === "root" || rawRole === "admin") return true;
  if (!categoryId) return false;

  const role = effectiveRole(rawRole, ctx.settings);
  const roleData = ctx.roles[role] || {};
  const category = ctx.categories[categoryId];
  if (!category) return false;

  const rawAllowed = (category.permissions || {}).view_forum;
  // No override (missing / null / empty) → inherit the role's global list.
  if (!rawAllowed) return (roleData.permissions || []).includes("view_forum");

  const allowed = normaliseAllowedRoles(rawAllowed);
  // A non-array override that normalises to nothing is treated as "no override"
  // rather than "deny everyone" — malformed data must not blank the forum.
  if (allowed.length === 0) return (roleData.permissions || []).includes("view_forum");

  if (allowed.includes(role)) return true;
  if (roleData.base_role_id && allowed.includes(roleData.base_role_id)) return true;
  return false;
}

async function getRequester(db, uid) {
  if (!uid) return { uid: null, role: "guest", data: {} };
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return { uid, role: "guest", data: {} };
  const data = snap.data();
  return { uid, role: data.role_id || "player", data };
}

/**
 * Mirrors the Firestore rules isAdmin(): admin/root bypass every permission
 * check, exactly like request.auth.token.role_id in firestore.rules.
 */
function isRuleAdmin(rawRole) {
  return rawRole === "admin" || rawRole === "root";
}

/**
 * Mirrors the Firestore rules hasPermission(): checks the role's GLOBAL
 * permissions list (root bypasses). Write callables replicate the rules, so no
 * base_role_id inheritance here — the rules do not apply any.
 */
function hasRulePermission(ctx, rawRole, permission) {
  if (rawRole === "root") return true;
  const role = effectiveRole(rawRole, ctx.settings);
  const roleData = ctx.roles[role] || {};
  return Array.isArray(roleData.permissions) && roleData.permissions.includes(permission);
}

/**
 * Mirrors the Firestore rules hasCategoryDataPermission(): a category-level
 * permission list (when present) overrides the role's global list; only
 * explicit role ids count in that list, exactly as the rules evaluate it.
 */
function hasRuleCategoryPermission(ctx, rawRole, categoryId, permission) {
  if (rawRole === "root") return true;
  const category = ctx.categories[categoryId];
  if (!category) return false;
  const catPerms = category.permissions || {};
  const role = effectiveRole(rawRole, ctx.settings);
  if (!(permission in catPerms)) return hasRulePermission(ctx, rawRole, permission);
  return Array.isArray(catPerms[permission]) && catPerms[permission].includes(role);
}

module.exports = { loadContext, invalidateContext, effectiveRole, hasViewForum, getRequester, isRuleAdmin, hasRulePermission, hasRuleCategoryPermission, normaliseAllowedRoles };
