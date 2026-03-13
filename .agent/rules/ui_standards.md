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
3. **Follow Patterns**: Match the architecture and coding style of existing components (e.g., use of Bootstrap, Lucide icons, etc.).
