/**
 * Единый источник поддерживаемых языков форума.
 *
 * Добавляя новую запись здесь, язык автоматически появляется:
 *   - в выпадающем списке настроек профиля (ProfilePage),
 *   - в числе допустимых значений при автоопределении языка (I18nProvider).
 *
 * Поля:
 *   code      — значение, которое сохраняется в settings.language и localStorage
 *   labelKey  — ключ в common-разделе src/i18n/dictionary.js (например common.language_de)
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', labelKey: 'common.language_en' },
  { code: 'ru', labelKey: 'common.language_ru' },
];

/** Коды поддерживаемых языков, например ['en', 'ru']. */
export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map(l => l.code);

/** Язык по умолчанию, если ничего не подошло. */
export const DEFAULT_LANGUAGE = 'en';

/** Проверяет, является ли код поддерживаемым языком. */
export const isSupportedLanguage = (code) =>
  SUPPORTED_LANGUAGE_CODES.includes(code);

/**
 * Возвращает ближайший поддерживаемый язык по строке из navigator.language,
 * например 'ru-RU' -> 'ru', 'en-US' -> 'en'. Если ничего не совпало — DEFAULT_LANGUAGE.
 */
export const detectLanguageFromBrowser = (browserLang) => {
  if (!browserLang) return DEFAULT_LANGUAGE;
  const lang = String(browserLang).toLowerCase();
  for (const code of SUPPORTED_LANGUAGE_CODES) {
    if (lang.startsWith(code.toLowerCase())) return code;
  }
  return DEFAULT_LANGUAGE;
};
