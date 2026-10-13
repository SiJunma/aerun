# План: таб-скоп сохранений профиля + сид настроек при регистрации

Цель: убрать хардкод `theme:'dark'` / `language:'en'`, сохранять только таб,
сидировать при регистрации текущие гостевые значения.

## Шаг 0 — этот файл (якорь против компактинга)
- Дальше работать только по шагам ниже, по одному малому чтению/правке за раз.
- Не перечитывать весь контекст. Ссылки — только указанные диапазоны строк.

## Шаг 1 — ProfilePage: карта принадлежности полей табам
- Файл: `src/pages/ProfilePage.jsx`
- Точки: `buildAccountForm` (~L305-328), инит `accountFormData` (~L93-116)
- Сделать:
  - `PROFILE_TAB_FIELDS = [status_line,bio,location,birthday,occupation,interests,contacts,nickname,signature]`
  - `SETTINGS_TAB_FIELDS = [theme,language,notifications_*,sound_*,member_view_style,show_footer,...]`
  - `avatar_url` — НЕ поле формы (загружается через `PUT /me/avatar`, см. `src/api/avatars.js:44-55`).
- Проверка: `node scripts/check-identity-refresh.mjs` (паттерн `confirmedProfilePatch` без `avatar_url`).

## Шаг 2 — ProfilePage: убрать хардкод, префилл из живых значений
- Тот же файл + хуки:
  - `useTheme()` из `src/contexts/ThemeProvider.jsx:7` (активная тема, фолбэк `settings.defaultDesignId`)
  - `lang` из `src/contexts/I18nProvider.jsx:8`
- Заменить `|| 'dark'` / `|| 'en'` на `?? liveTheme ?? settings.defaultDesignId`, `?? liveLang`.
- Префилл таба = живые значения, если `profile.settings.*` отсутствует.

## Шаг 3 — ProfilePage: раздельные сейвы по табам + дифф внутри таба
- Точки: `handleSaveAccount` (~L453), кнопка Профиля (~L1625-1642), кнопка Настроек (~L1808-1960)
- Сделать:
  - `handleSaveProfileTab()` → `PATCH /me/profile` только diff PROFILE_TAB_FIELDS (+ `signature` через settings? уточнить: signature лежит в settings — шлётся через `updateSettings({signature})` отдельно).
  - `handleSaveSettingsTab()` → `updateSettings(diff(SETTINGS_TAB_FIELDS))`.
  - Хелпер `diffFields(form, seed, fields)` — шлёт только изменившееся. Пустой diff = no-op + тост "нет изменений".
- Контракт сервера: `PUT /me/settings` = wholesale replace, но клиент мержит (`AuthProvider.jsx:534-535`), поэтому partial diff безопасен.

## Шаг 4 — Регистрация: сид настроек текущими гостевыми
- Бэк: `backend/internal/platform/pocketbase/register.go:116` (`settings={}`) → принять `theme,language` (whitelist, остальные ключи игнор).
- Фронт:
  - `src/contexts/AuthProvider.jsx:432-453` (`registerWithEmail`) → добавить param `initialSettings {theme,language}`.
  - `src/components/auth/RegisterForm.jsx:110` → передать `localStorage guest_theme + localStorage language`.
  - `loginWithGoogle` (`AuthProvider.jsx:405-430`): если новый юзер (нет settings) → `updateSettings(seed)` один раз после `authRefresh`.
- Тест бэка: обновить `commands_test.go:64-70` (сейчас asserts empty settings) → asserts seed отражён + unknown keys отброшены.

## Шаг 5 — Проверки
- `npm run test:drafts-and-settings`
- `npm run test:identity-refresh`
- `npm run test:user-profile-normalization`
- `go test ./backend/internal/platform/pocketbase -run 'TestRegister|TestSettings|TestProfile'`
- Ручная: новый юзер (светлая+ru) → сохранить Профиль → тема/язык не меняются.

## Прогресс
- [x] Шаг 0 — файл-план создан
- [x] Шаг 1 — карта принадлежности полей табам (PROFILE_TAB_KEYS + SETTINGS_TAB_KEYS, avatar_url вне списков)
- [x] Шаг 2 — живой префилл без хардкода (liveTheme/lang/defaultDesignId в buildAccountForm)
- [x] Шаг 3 — ProfilePage: раздельные сейвы по табам + дифф внутри таба
  (handleSaveProfileTab/handleSaveSettingsTab + diffTabFields + buildSettingsPatch)
- [x] Шаг 4 — сид при регистрации (бэк whitelist theme/language + email-сид + OAuth-сид один раз)
- [x] Шаг 5 — проверки (identity-refresh, drafts-and-settings, user-profile-normalization, Go TestRegister/TestSettings|TestProfile — все зелёные)
