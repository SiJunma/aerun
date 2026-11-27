import { useEffect } from 'react';
import { useI18n } from '../contexts/I18nProvider';

// Keeps the <link rel="manifest"> href in sync with the viewer's language
// and effective base theme, so the manifest the browser fetches at install
// time carries the theme's own colours and the viewer's language — instead
// of one static pair that fits exactly one theme.
//
// The theme is read from body[data-theme] (written by ThemeProvider) and
// watched with a MutationObserver, so a theme/design change — including a
// design preview — updates the link without re-rendering anything. The
// language comes from the i18n provider. The server resolves both
// (?theme=light|dark|neutral, ?lang=en|ru) and falls back to the forum
// defaults when they are absent or unknown.
export default function PwaManifestLink() {
  const { lang } = useI18n();

  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    const update = () => {
      const theme = document.body.getAttribute('data-theme') || 'dark';
      link.setAttribute(
        'href',
        `/api/aerun/manifest.webmanifest?lang=${encodeURIComponent(lang)}&theme=${encodeURIComponent(theme)}`,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [lang]);

  return null;
}
