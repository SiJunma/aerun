# UI and Development Standards

To maintain high quality, consistency, and accessibility, the assistant must follow these standards:

## 🌐 Multi-language Support (i18n)
1. **No Hardcoded Strings**: Never use raw text in UI components. Always use the `t()` translation function.
2. **Update Dictionaries**: When adding new features, immediately add the corresponding keys and values (in both English and Russian) to `src/i18n/dictionary.js`.
3. **Consistency**: Ensure terminology remains consistent across the whole application.

## 🎨 Theming and Design System
1. **CSS Variables Only**: Do not use hardcoded colors (like `#ffffff` or `rgb(...)`) directly in component styles. Use the project's CSS variables (e.g., `--forum-bg`, `--text-primary`, `--card-bg`).
2. **Three-Theme Compatibility**: Always ensure that new elements are readable and visually pleasing in all three themes: **Light**, **Dark**, and **Neutral** (Cyrillic/Old Paper).
3. **Contrast**: Pay special attention to text-to-background contrast in all themes to ensure readability.

## ♻️ Code Reuse and DRY
1. **Search Before Building**: Before creating a new component or utility, search the codebase (especially `src/components/common`) for existing solutions that can be reused or extended.
2. **DRY (Don't Repeat Yourself)**: Avoid duplicating logic or styles. Refactor existing code into reusable components if you see a pattern being repeated.
3. **Follow Patterns**: Match the architecture and coding style of existing components (e.g., Lucide icons, the shared admin classes below). Bootstrap stays only in the older, not-yet-migrated surfaces — see the admin section below.

## 🧩 Admin surfaces: shared components (2026-11-27)

The admin panel used to grow one themed CSS file per tab, each re-declaring
the same button, switch, input, hint and error rules under its own prefix
(`designs-*`, `visits-*`, `push-*`, `favicon-uploader-*`). Twenty rule
bodies were byte-identical across files, so one visual change meant editing
four files — and the copies drifted. The shared primitives live once, in
`src/components/admin/admin.css`, imported once from
`src/pages/AdminPage.jsx`:

1. **Use the shared classes, never a per-tab copy**: `.admin-btn` with
   modifiers `--primary` / `--secondary` / `--ghost` / `--danger` /
   `--activate` / `--deactivate` / `--preview` / `--sm` / `--icon`,
   `.admin-switch` (+ `__input`), `.admin-field` with `__label` /
   `__control` / `__select` / `__textarea` / `__hint` / `__error`,
   `.admin-form` (container), `.admin-actions` (button row, `--wide`
   modifier), `.admin-card` (+ `__header` / `__body` / `__footer`),
   `.admin-muted`, `.admin-title`, `.admin-subtitle`, `.admin-notice`
   (+ `--danger` / `--warning`, boxed modal/form alerts), `.admin-stack`
   (+ `--xs`) and `.admin-truncate`. A rule that two
   tabs need lives in `admin.css`, not in either tab's file.
2. **New admin code**: no `react-bootstrap` imports, no Bootstrap utility
   classes (`d-flex`, `mb-3`, `text-muted`, …), no inline `style={{…}}`,
   colours only through the theme variables, fonts never below 14px.
3. **Targeting**: `AdminPage` wraps every tab in
   `<div className="admin-tab" data-tab="<tab-id>">`. The same element
   everywhere is `.admin-btn`; one element in one place is
   `.admin-tab[data-tab="push"] .admin-btn` or a modifier class on the
   element itself — never a per-tab copy of a shared class.
4. **Scope**: the rule covers the themed surfaces — `DesignsTab`,
   `VisitsTab` (including its child tables, charts and the IP modals),
   `FaviconUploader`, `PushSettingsTab`, and the shared bits
   of `AdminSidebar`. The older Bootstrap-based surfaces (`AdminPage`
   inline sections, `AdminSecretsSettings`, `EmailTemplatesSettings`)
   are exempt until their theming-branch migration; do not "fix" them
   in passing. `AdminSidebar`'s `Offcanvas` / `OverlayTrigger` /
   `Tooltip` are likewise deferred to the Sprint H migration.
5. **Enforcement**: `scripts/check-admin-shared-components.mjs`
   (wired into `npm test`) fails on a `react-bootstrap` import, an
   inline style, a Bootstrap utility class, or a duplicated CSS rule
   body in the covered files.
