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
- Форум (список тем). Когда перехожу в тему по ссылке быстрого сообщения при наличии новых ответов - тема не грузится и в консоль выкидывает ошибку permission-denied. А если зайти через первое сообщение - ссылка через тему, без учета непрочитанных - счетчик непрочитанных сбрасывается и потом нормально открывается через goLast с последнего сообления.
- Когда в теме кто-то пишет пост, то на странице категории(главная страница) И на странице форума(список тем) этот момент(последнее сообщение, количество сообщений, тем) не обновляется, как задумано, в реальном времени.
- Хотелось бы видеть чтобы тайтл вкладки (страницы) менялся при переходе между страницами форума. Чтобы отображалось название страницы или темы, на которой находишься. И чтобы обновлялось в скобках количество уведомлений. И почему то не слышу звука уведомлений, хотя они включены в настройках.