# Session Handover: Guest Permission Fix

**Date**: 2026-07-25
**Status**: Deployed ✅

## 📋 Bug Fixed This Session

### Guest `permission-denied` on public topics

**Symptom**: Guests (incognito) got `FirebaseError: [code=permission-denied]` when opening any topic.

**Root causes (3 fixes applied)**:

1. **`posts` — `allow read: if isAdmin()` only**  
   Posts were completely unreadable by non-admins. Fixed to use `hasCategoryPermission`.

2. **`topics` — `allow list: if isAdmin()` only**  
   `subscribeToTopics()` (query with `where('category_id', ...)`) uses `list` op. Fixed to use `hasCategoryPermission`.

3. **`hasCategoryPermission` fallback bug** ← *root cause*  
   When `view_forum` was not set explicitly at category level, the fallback was:
   ```js
   isSignedIn() && hasPermission(permission)  // always false for guests
   ```
   Fixed to check the `/roles/{roleId}` document directly, so guests whose global `guest` role has `view_forum` pass correctly:
   ```js
   role == 'root' || (
     exists(.../roles/$(role)) &&
     permission in get(.../roles/$(role)).data.permissions
   )
   ```

**Key insight**: The `guest` role has **no global permissions by default** — access to specific categories is granted via category-level `permissions.view_forum` overrides that include `'guest'`. The fallback only matters when a category omits `view_forum` and relies on the global role document.

## 🏗️ Architecture Notes

- `subscribeToCategories` → Cloud Function (`getSecuredCategories`) — unaffected by rules
- `fetchSecuredPosts` → Cloud Function — unaffected by rules  
- `subscribeToTopic(topicId)` → direct Firestore `get` — now covered by fixed `allow get`
- `subscribeToPosts` is **not used** in TopicPage (uses Cloud Function instead)

## ⏭️ Next Steps
- В личных сообщениях ограничение символов для сообщение должно слушать глобальную настройку лимита символов для постов (сейчас хардкод 2000 символов).

- Тайтл вкладки (страницы) не меняется на всех страницах форума - только на форумах и темах. А когда на другие страницы ходит - тайтл остается прежним, что дезинформирует.

- В режиме реального времени - новое сообщение(с цитированием, если это имеет значение) не добавилось в счетчик новых сообщений и не делало активной кнопку "пометить все как прочитано" в итоге. Пока я не перезагрузила страницу.