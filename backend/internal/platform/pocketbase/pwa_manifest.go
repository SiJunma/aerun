package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// Dynamic PWA manifest (migration 1780100001).
//
// The first Web Push commit hardcoded the manifest in
// public/manifest.webmanifest: name, description, colours and icon paths.
// That contradicts the forum's own rule — everything an admin can change
// lives in the admin panel, not in a file. So the manifest is served from
// the forum_settings row instead, and the static file is gone: index.html
// links here, and the service worker caches this URL.
//
// What comes from where:
//   - name, short_name, description — the admin fields on the Web Push
//     surface. There is no other home for them: no forum name/description
//     setting exists anywhere else to pull from.
//   - icons — the admin uploads on the same surface.
//   - theme_color, background_color, lang — NOT stored. They follow the
//     viewer: ?theme= takes the base theme (the value ThemeProvider writes
//     to body[data-theme]) and ?lang= the viewer's locale, both set on the
//     manifest link by the app (see PwaManifestLink.jsx). One static pair
//     of colours would fit exactly one theme; the forum has three, plus
//     custom designs on top of them.
//
// Icons appear only when the admin uploaded them. A manifest without icons
// is not installable, but that is the honest state of an unconfigured forum —
// and unlike the old cache.addAll of files that did not exist, it can never
// fail the service worker install.

const manifestContentType = "application/manifest+json"

// pwaThemeColors maps a base theme to the manifest colours. The values are
// the theme's own tokens from src/index.css — background_color is --bg-color,
// theme_color is --nav-bg (the colour the installed app's toolbar takes) —
// so the manifest always matches the theme the viewer has active. Keep this
// map in sync with index.css when a theme palette changes.
var pwaThemeColors = map[string]struct {
	theme      string
	background string
}{
	"light":   {theme: "#212529", background: "#f4f6f8"},
	"dark":    {theme: "#080d1e", background: "#0f172a"},
	"neutral": {theme: "#2c241a", background: "#f4f1ea"},
}

// pwaSupportedLangs mirrors the forum's supported languages
// (src/i18n/languages.js); anything else falls back to the forum default.
var pwaSupportedLangs = map[string]bool{"en": true, "ru": true}

const defaultPWAManifestTheme = "dark"
const defaultPWAManifestLang = "en"

func resolvePWAManifestTheme(theme string) (string, string) {
	colors, ok := pwaThemeColors[strings.TrimSpace(theme)]
	if !ok {
		colors = pwaThemeColors[defaultPWAManifestTheme]
	}
	return colors.theme, colors.background
}

func resolvePWAManifestLang(lang string) string {
	lang = strings.ToLower(strings.TrimSpace(lang))
	if pwaSupportedLangs[lang] {
		return lang
	}
	return defaultPWAManifestLang
}

// manifestIcon describes one icon entry of the Web App Manifest.
type manifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose,omitempty"`
}

func pwaManifest(app core.App, theme, lang string) map[string]any {
	settings := loadForumSettings(app)
	themeColor, backgroundColor := resolvePWAManifestTheme(theme)

	icons := make([]manifestIcon, 0, 3)
	if u := strings.TrimSpace(settings.PWAIcon192URL); u != "" {
		icons = append(icons, manifestIcon{Src: u, Sizes: "192x192", Type: "image/png", Purpose: "any"})
	}
	if u := strings.TrimSpace(settings.PWAIcon512URL); u != "" {
		icons = append(icons, manifestIcon{Src: u, Sizes: "512x512", Type: "image/png", Purpose: "any"})
	}
	if u := strings.TrimSpace(settings.PWAIconMaskableURL); u != "" {
		icons = append(icons, manifestIcon{Src: u, Sizes: "512x512", Type: "image/png", Purpose: "maskable"})
	}

	manifest := map[string]any{
		"name":             settings.pwaName(),
		"short_name":       settings.pwaShortName(),
		"description":      settings.pwaDescription(),
		"start_url":        "/",
		"scope":            "/",
		"display":          "standalone",
		"orientation":      "any",
		"background_color": backgroundColor,
		"theme_color":      themeColor,
		"lang":             resolvePWAManifestLang(lang),
		"icons":            icons,
	}

	// Non-standard member the service worker reads for the notification
	// badge: the manifest spec has no badge icon, and browsers ignore
	// unknown members, so this stays invisible to installability.
	if u := strings.TrimSpace(settings.PWAIconBadgeURL); u != "" {
		manifest["badge_icon"] = u
	}

	// Shortcuts reuse the 192 icon when one is configured; without it the
	// entries carry no icons key rather than a dangling path.
	shortcuts := []map[string]any{
		{
			"name":        "Новые ответы",
			"short_name":  "Ответы",
			"description": "Просмотр новых ответов в темах",
			"url":         "/new-replies",
		},
		{
			"name":        "Личные сообщения",
			"short_name":  "Диалоги",
			"description": "Открыть входящие сообщения",
			"url":         "/messages",
		},
	}
	if u := strings.TrimSpace(settings.PWAIcon192URL); u != "" {
		for _, s := range shortcuts {
			s["icons"] = []map[string]any{{"src": u, "sizes": "96x96", "type": "image/png"}}
		}
	}
	manifest["shortcuts"] = shortcuts

	return manifest
}

// getManifestHandler serves the forum's Web App Manifest.
// GET /api/aerun/manifest.webmanifest — public, no auth: browsers fetch it
// before anyone signs in. The colours and the language follow the viewer:
// ?theme=light|dark|neutral (the base theme from body[data-theme]) and
// ?lang=en|ru (the viewer's locale); both default when absent or unknown.
func getManifestHandler(e *core.RequestEvent) error {
	raw, err := json.Marshal(pwaManifest(
		e.App,
		e.Request.URL.Query().Get("theme"),
		e.Request.URL.Query().Get("lang"),
	))
	if err != nil {
		return internalError("failed to serialize the manifest", err)
	}
	return e.Blob(http.StatusOK, manifestContentType, raw)
}

// pwaIconKinds maps the public icon kind in the URL to its settings column.
// The apple-touch icon is served through the same redirect so index.html can
// link a stable URL while the admin owns the file behind it.
var pwaIconKinds = map[string]string{
	"icon-192":      "pwa_icon_192_url",
	"icon-512":      "pwa_icon_512_url",
	"icon-maskable": "pwa_icon_maskable_url",
	"apple-touch":   "pwa_icon_apple_touch_url",
	"badge":         "pwa_icon_badge_url",
}

// getPWAIconHandler redirects to the admin-configured icon file.
// GET /api/aerun/pwa-icon/{kind} — public, no auth. 404 while the admin has
// not uploaded that icon yet.
func getPWAIconHandler(e *core.RequestEvent) error {
	kind := strings.TrimSpace(e.Request.PathValue("kind"))
	column, ok := pwaIconKinds[kind]
	if !ok {
		return notFoundError("unknown pwa icon kind")
	}
	settings := loadForumSettings(e.App)
	var url string
	switch column {
	case "pwa_icon_192_url":
		url = settings.PWAIcon192URL
	case "pwa_icon_512_url":
		url = settings.PWAIcon512URL
	case "pwa_icon_maskable_url":
		url = settings.PWAIconMaskableURL
	case "pwa_icon_apple_touch_url":
		url = settings.PWAIconAppleTouchURL
	case "pwa_icon_badge_url":
		url = settings.PWAIconBadgeURL
	}
	if strings.TrimSpace(url) == "" {
		return notFoundError("pwa icon is not configured")
	}
	return e.Redirect(http.StatusFound, url)
}
