// The background-switch path, executed end to end at the JS level.
//
// ROOT CAUSE (found 2026-11-26): the backgrounds were uploaded to the
// "Snow Mountains" default design (key 'light'), the light theme WAS active,
// and the backend served the files fine — but the browser requested them
// from the Vite dev origin (http://localhost:5173/api/files/...) while
// PocketBase serves them at http://127.0.0.1:8090/api/files/... The Network
// 304s with Type text/html were the Vite dev server answering HTML instead
// of the image. vite.config.js has no /api proxy; resolveAvatarUrl() already
// prefixes relative /api/files paths with pbUrl, and avatars, placeholders
// and the favicon all use it — but ForumBackground used the resolved
// background URLs RAW. In production (single origin) relative URLs work;
// in local dev (split origins) they break. The fix lives in
// resolveActiveDesign: every URL it returns is resolved against pbUrl, so
// ForumBackground can use them raw from any frontend origin.
//
// These are behavioural tests against the real resolver, not a regex gate:
// they execute toDefaultDesign + resolveActiveDesign on payloads shaped
// exactly like GET /api/aerun/default-designs/{key} returns them (see
// TestDefaultDesignLightBackgroundResolves on the Go side, which proves the
// server stores and returns the same fields). The last case is a source
// gate tying the resolver's output to its consumers, so a render site that
// stops reading resolvedDesign.background cannot drift silently.
//
// The background-opacity setting is gone (custom CSS covers it now): the
// resolver returns no opacity, and the mapped card carries no bgOpacity —
// the bg_opacity column still exists server-side as dead data, but the
// frontend neither reads nor writes it.
//
// Run: node --test --experimental-test-module-mocks scripts/test-default-design-background.mjs
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The dev backend origin: pbUrl defaults to http://127.0.0.1:8090 when
// VITE_POCKETBASE_URL is unset, which is exactly the local-stand split
// (Vite serves the page at :5173, PocketBase serves files at :8090).
// designs.js imports sendApi from ./pocketbase.js and resolveAvatarUrl from
// ./avatars.js, which imports { pb, pbUrl, sendApi } from ./pocketbase.js —
// the mock must provide all three names. pocketbase.js itself reads
// import.meta.env (Vite-only) and constructs a PocketBase client at module
// scope, neither of which works in plain node; the resolver under test is
// pure, so the transport is stubbed and nothing under test ever calls it
// for real. The stub records every path it is asked for, so the
// single-fetch tests below can prove no list endpoint was hit, and serves
// the single-record fixtures by exact path.
const sendApiCalls = [];
const singleRecords = {
  '/api/aerun/designs/custom-1': {
    id: 'custom-1',
    name: 'My Design',
    show_in_list: true,
    is_active: true,
    base_theme: 'dark',
    bg_default_url: '/api/files/designs/custom-1/bg.png',
    css: '.x { color: red; }',
    js: 'console.log(1)',
    header_html: '<div class="banner-content">Hi</div>',
    custom_footer_html: '<footer>F</footer>',
    forum_title: 'My Forum',
    favicon_url: '/api/files/designs/custom-1/icon.png',
    overwrite_css: true,
    overwrite_header: true,
    overwrite_footer: false,
    overwrite_title: false,
    overwrite_favicon: false,
    overwrite_js: false,
    overwrite_placeholder_deleted: false,
    overwrite_placeholder_guest: false,
  },
  '/api/aerun/default-designs/light': {
    id: 'default-light-id',
    key: 'light',
    name: 'Светлая',
    show_in_list: true,
    bg_default_url: '/api/files/default_designs/default-light-id/bg.png',
    css: '.light { color: black; }',
    header_html: '<div>Light header</div>',
    overwrite_header: true,
    overwrite_footer: false,
    overwrite_title: false,
    overwrite_favicon: false,
    overwrite_css: true,
    overwrite_js: false,
    overwrite_placeholder_deleted: false,
    overwrite_placeholder_guest: false,
  },
};
mock.module('../src/api/pocketbase.js', {
  namedExports: {
    pb: { files: { getURL: () => '' } },
    pbUrl: 'http://127.0.0.1:8090',
    sendApi: async (path) => {
      sendApiCalls.push(path);
      const record = singleRecords[path];
      return record ? { ...record } : {};
    },
  },
});

const {
  toDesign,
  toDefaultDesign,
  resolveActiveDesign,
  fetchSingleDesign,
  loadDesignForEdit,
  writeDesignCache,
  designCacheKey,
  updateDesign,
} = await import('../src/api/designs.js');

// sessionStorage stand-in: the helpers take { storage }, so the node test
// injects this instead of the browser store.
const makeFakeStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    keys: () => [...store.keys()],
  };
};

// A custom-design LIST SUMMARY, exactly as GET /api/aerun/designs returns
// it now: no css/js/header/footer/title/favicon/placeholder/overwrite
// fields arrive in lists anymore.
const customSummaryRaw = () => ({
  id: 'custom-1',
  name: 'My Design',
  show_in_list: true,
  bg_default_url: '/api/files/designs/custom-1/bg.png',
  is_active: true,
  base_theme: 'dark',
});

// A default-design LIST SUMMARY, exactly as GET /api/aerun/default-designs
// returns it now.
const defaultSummaryRaw = () => ({
  id: 'default-light-id',
  key: 'light',
  name: 'Светлая',
  show_in_list: true,
  bg_default_url: '/api/files/default_designs/default-light-id/bg.png',
});

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// A 'light' card exactly as GET /api/aerun/default-designs/light returns it
// after the three background uploads.
const lightCardRaw = () => ({
  id: 'default-light-id',
  key: 'light',
  name: 'Светлая',
  show_in_list: true,
  bg_default_url: '/api/files/default_designs/default-light-id/bg.png',
  bg_tablet_url: '/api/files/default_designs/default-light-id/bg-tablet.png',
  bg_mobile_url: '/api/files/default_designs/default-light-id/bg-mobile.png',
  bg_opacity: 0.6,
  overwrite_header: false,
  overwrite_footer: false,
  overwrite_title: false,
  overwrite_favicon: false,
  overwrite_css: false,
  overwrite_js: false,
  overwrite_placeholder_deleted: false,
  overwrite_placeholder_guest: false,
});

// The 'dark' card as seeded: no background uploaded to it.
const darkCardRaw = () => ({
  id: 'default-dark-id',
  key: 'dark',
  name: 'Тёмная',
  show_in_list: true,
  bg_default_url: '',
  bg_tablet_url: '',
  bg_mobile_url: '',
  bg_opacity: 0.5,
  overwrite_header: false,
  overwrite_footer: false,
  overwrite_title: false,
  overwrite_favicon: false,
  overwrite_css: false,
  overwrite_js: false,
  overwrite_placeholder_deleted: false,
  overwrite_placeholder_guest: false,
});

describe('default-design background resolution', () => {
  it('maps the raw light card to a default design with its bg URLs', () => {
    const card = toDefaultDesign(lightCardRaw());

    assert.equal(card.key, 'light');
    assert.equal(card.isDefaultDesign, true);
    assert.equal(card.bgDefaultUrl, '/api/files/default_designs/default-light-id/bg.png');
    assert.equal(card.bgTabletUrl, '/api/files/default_designs/default-light-id/bg-tablet.png');
    assert.equal(card.bgMobileUrl, '/api/files/default_designs/default-light-id/bg-mobile.png');
    assert.equal(card.baseTheme, undefined, 'a default design has no base theme');
    assert.equal(card.isActive, undefined, 'a default design has no activation');
    // The card keeps host-agnostic paths (storage stays portable); the
    // backend origin is prefixed only by the resolver, at render time.
    // bg_opacity is dead data the frontend no longer maps.
    assert.equal(card.bgOpacity, undefined, 'the frontend no longer reads bg_opacity');
  });

  it('resolves the light card background to backend-origin URLs an <img> can load', () => {
    const card = toDefaultDesign(lightCardRaw());
    const resolved = resolveActiveDesign({}, card);

    // The regression: a bare /api/files path resolves against the FRONTEND
    // origin (:5173 in dev) and the Vite server answers HTML. Every URL
    // here must carry the backend origin (:8090).
    assert.deepEqual(resolved.background, {
      default: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg.png',
      tablet: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg-tablet.png',
      mobile: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg-mobile.png',
    });
    assert.equal('opacity' in resolved, false, 'the resolver returns no opacity anymore');
  });

  it('passes absolute background URLs through unchanged', () => {
    const raw = lightCardRaw();
    raw.bg_default_url = 'https://images.unsplash.com/photo-123?w=2000';
    delete raw.bg_tablet_url;
    delete raw.bg_mobile_url;
    const card = toDefaultDesign(raw);
    const resolved = resolveActiveDesign({}, card);

    assert.deepEqual(resolved.background, {
      default: 'https://images.unsplash.com/photo-123?w=2000',
      tablet: 'https://images.unsplash.com/photo-123?w=2000',
      mobile: 'https://images.unsplash.com/photo-123?w=2000',
    });
  });

  it('falls back to the default image for missing breakpoint variants', () => {
    const raw = lightCardRaw();
    delete raw.bg_tablet_url;
    delete raw.bg_mobile_url;
    const card = toDefaultDesign(raw);
    const resolved = resolveActiveDesign({}, card);

    assert.deepEqual(resolved.background, {
      default: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg.png',
      tablet: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg.png',
      mobile: 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/bg.png',
    });
  });

  it('resolves the dark card to NO background', () => {
    const card = toDefaultDesign(darkCardRaw());
    const resolved = resolveActiveDesign({}, card);

    // The uploads live on the 'light' card; with theme 'dark' the active
    // card is 'dark', it carries no background, and ForumBackground renders
    // no <picture> at all.
    assert.equal(resolved.background, null);
    assert.equal('opacity' in resolved, false, 'the resolver returns no opacity anymore');
  });

  it('resolves favicon and placeholder URLs against the backend origin too', () => {
    const raw = lightCardRaw();
    raw.favicon_url = '/api/files/default_designs/default-light-id/icon.svg';
    raw.overwrite_favicon = true;
    raw.placeholder_deleted_url = '/api/files/default_designs/default-light-id/deleted.png';
    raw.overwrite_placeholder_deleted = true;
    const card = toDefaultDesign(raw);
    const resolved = resolveActiveDesign({}, card);

    assert.equal(resolved.faviconUrl, 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/icon.svg');
    assert.equal(resolved.placeholderDeleted, 'http://127.0.0.1:8090/api/files/default_designs/default-light-id/deleted.png');
  });

  it('the render path consumes resolvedDesign.background, not the theme name', () => {
    const forumBackground = read('../src/components/layout/ForumBackground.jsx');
    assert.match(forumBackground, /resolvedDesign\?\.background/, 'ForumBackground must read the resolved background');
    assert.match(forumBackground, /if \(!background \|\| !background\.default\) return null/, 'no background on the card means no <picture>');
    assert.match(forumBackground, /<img src=\{background\.default\}/, 'the <img> renders the resolved default URL');
    assert.doesNotMatch(forumBackground, /resolveAvatarUrl/, 'the single resolution mechanism lives in resolveActiveDesign, not in the render site');
    assert.doesNotMatch(forumBackground, /resolvedDesign\.opacity/, 'no per-card opacity reaches the render site');
    assert.doesNotMatch(forumBackground, /style=\{\{[^}]*opacity/, 'no inline opacity style on the background image');

    const designs = read('../src/api/designs.js');
    assert.match(
      designs,
      /import \{ resolveAvatarUrl \} from '\.\/avatars\.js'/,
      'the resolver uses the one shared helper, not a second mechanism',
    );
    assert.match(
      designs,
      /default: resolveAvatarUrl\(activeCard\.bgDefaultUrl\)/,
      'the resolver prefixes the default background URL',
    );

    const designProvider = read('../src/contexts/DesignProvider.jsx');
    assert.match(
      designProvider,
      /fetchSingleDesign\(/,
      'the provider resolves the active design with single-record GETs',
    );
    assert.doesNotMatch(
      designProvider,
      /getDesigns\(/,
      'the provider never fetches the full custom list to resolve the active design',
    );
    assert.doesNotMatch(
      designProvider,
      /getDefaultDesigns\(/,
      'the provider never fetches the full default list to resolve the active design',
    );
    assert.match(
      designProvider,
      /resolveActiveDesign\(settings, activeDesign\)/,
      'the provider resolves the active card through resolveActiveDesign',
    );
  });
});

describe('list summaries stay valid mapper inputs', () => {
  it('maps a custom summary: list fields kept, full-only fields defaulted', () => {
    const card = toDesign(customSummaryRaw());

    assert.equal(card.id, 'custom-1');
    assert.equal(card.name, 'My Design');
    assert.equal(card.showInList, true);
    assert.equal(card.isActive, true);
    assert.equal(card.baseTheme, 'dark');
    assert.equal(card.bgDefaultUrl, '/api/files/designs/custom-1/bg.png');
    // No full fields arrive in a summary — the mapper must not invent
    // them, and must not crash a consumer that reads them.
    assert.equal(card.css, '');
    assert.equal(card.js, '');
    assert.equal(card.headerHtml, '');
    assert.equal(card.customFooterHtml, '');
    assert.equal(card.forumTitle, '');
    assert.equal(card.faviconUrl, '');
    assert.equal(card.overwriteCss, false);
    assert.equal(card.overwriteHeader, false);
  });

  it('maps a default summary: key/name/flags/bg kept, full-only fields defaulted', () => {
    const card = toDefaultDesign(defaultSummaryRaw());

    assert.equal(card.id, 'default-light-id');
    assert.equal(card.key, 'light');
    assert.equal(card.name, 'Светлая');
    assert.equal(card.showInList, true);
    assert.equal(card.isDefaultDesign, true);
    assert.equal(card.bgDefaultUrl, '/api/files/default_designs/default-light-id/bg.png');
    assert.equal(card.css, '');
    assert.equal(card.headerHtml, '');
    assert.equal(card.baseTheme, undefined, 'a default design has no base theme');
    assert.equal(card.isActive, undefined, 'a default design has no activation');
  });
});

describe('on-demand single-theme fetch (fetchSingleDesign)', () => {
  it('fetches one builtin theme by key, never a list', async () => {
    sendApiCalls.length = 0;
    const card = await fetchSingleDesign('light');

    assert.deepEqual(sendApiCalls, ['/api/aerun/default-designs/light']);
    assert.equal(card.key, 'light');
    assert.equal(card.isDefaultDesign, true);
    // A single-record GET is FULL: the css/header the summary omits arrive.
    assert.equal(card.css, '.light { color: black; }');
    assert.equal(card.headerHtml, '<div>Light header</div>');
  });

  it('fetches one custom theme by id, never a list', async () => {
    sendApiCalls.length = 0;
    const card = await fetchSingleDesign('custom-1');

    assert.deepEqual(sendApiCalls, ['/api/aerun/designs/custom-1']);
    assert.equal(card.id, 'custom-1');
    assert.equal(card.css, '.x { color: red; }');
    assert.equal(card.js, 'console.log(1)');
    assert.equal(card.headerHtml, '<div class="banner-content">Hi</div>');
    assert.equal(card.overwriteCss, true);
  });

  it('fetches nothing for an empty target', async () => {
    sendApiCalls.length = 0;
    assert.equal(await fetchSingleDesign(null), null);
    assert.equal(await fetchSingleDesign(''), null);
    assert.deepEqual(sendApiCalls, []);
  });
});

describe('edit-modal session cache (loadDesignForEdit)', () => {
  it('fetches the full record once, then reuses the cached copy', async () => {
    const storage = makeFakeStorage();
    sendApiCalls.length = 0;

    const first = await loadDesignForEdit('custom', 'custom-1', { storage });
    assert.equal(first.fromCache, false);
    assert.equal(first.design.css, '.x { color: red; }');
    assert.deepEqual(sendApiCalls, ['/api/aerun/designs/custom-1']);
    assert.deepEqual(storage.keys(), ['aerun_design_cache:custom:custom-1']);

    sendApiCalls.length = 0;
    const second = await loadDesignForEdit('custom', 'custom-1', { storage });
    assert.equal(second.fromCache, true);
    assert.equal(second.design.css, '.x { color: red; }');
    assert.equal(second.design.headerHtml, '<div class="banner-content">Hi</div>');
    assert.deepEqual(sendApiCalls, [], 'a cached open must not refetch');
  });

  it('namespaces custom and default designs apart', async () => {
    const storage = makeFakeStorage();
    sendApiCalls.length = 0;

    assert.equal(designCacheKey('custom', 'custom-1'), 'aerun_design_cache:custom:custom-1');
    assert.equal(designCacheKey('default', 'light'), 'aerun_design_cache:default:light');

    await loadDesignForEdit('custom', 'custom-1', { storage });
    const viaDefault = await loadDesignForEdit('default', 'light', { storage });
    assert.equal(viaDefault.fromCache, false, 'the default namespace must not hit the custom entry');
    assert.equal(viaDefault.design.key, 'light');
    assert.deepEqual(
      storage.keys().sort(),
      ['aerun_design_cache:custom:custom-1', 'aerun_design_cache:default:light'],
    );
    assert.deepEqual(sendApiCalls, ['/api/aerun/designs/custom-1', '/api/aerun/default-designs/light']);
  });

  it('a successful save overwrites the cached copy', async () => {
    const storage = makeFakeStorage();
    // Plain node has no sessionStorage, so the API layer's own cache write
    // (inside updateDesign, which takes no storage option) would no-op.
    // Install the fake as the global store for this test, and have the
    // reopened modal read through the DEFAULT store — proving the save
    // write and the modal read share one store, exactly as in the browser.
    const prevSessionStorage = globalThis.sessionStorage;
    globalThis.sessionStorage = storage;
    try {
      // Seed a stale pre-edit snapshot, as if the modal was opened before.
      writeDesignCache('custom', 'custom-1', { ...toDesign(singleRecords['/api/aerun/designs/custom-1']), css: '.stale {}' }, { storage });
      const stale = await loadDesignForEdit('custom', 'custom-1', { storage });
      assert.equal(stale.design.css, '.stale {}');

      // The save round-trips through updateDesign; the stub answers the PATCH
      // with the stored full record, and the API layer must overwrite the
      // session copy with what the server returned.
      const updated = await updateDesign('custom-1', { css: '.x { color: red; }' });
      assert.equal(updated.css, '.x { color: red; }');

      sendApiCalls.length = 0;
      const reopened = await loadDesignForEdit('custom', 'custom-1');
      assert.equal(reopened.fromCache, true);
      assert.equal(reopened.design.css, '.x { color: red; }', 'the next open shows what was saved, not the stale snapshot');
      assert.deepEqual(sendApiCalls, [], 'the overwritten cache must not refetch');
    } finally {
      if (prevSessionStorage === undefined) delete globalThis.sessionStorage;
      else globalThis.sessionStorage = prevSessionStorage;
    }
  });
});

describe('revision gates: banner placeholder and summary-driven UI', () => {
  it('the banner carries no styles of its own; Layout still renders the placeholder', () => {
    const indexCss = read('../src/index.css');
    const layoutCss = read('../src/styles/layout.css');
    const themeCss = read('../src/styles/theme-variables.css');
    const layoutJsx = read('../src/components/layout/Layout.jsx');

    assert.doesNotMatch(indexCss, /\.forum-banner\s*\{/, 'no .forum-banner rule in index.css');
    assert.doesNotMatch(indexCss, /--forum-banner-/, 'no --forum-banner-* aliases in index.css');
    assert.doesNotMatch(layoutCss, /\.forum-banner\s*\{/, 'no .forum-banner rule in layout.css');
    assert.doesNotMatch(themeCss, /--forum-banner-/, 'no --forum-banner-* aliases in theme-variables.css');
    assert.match(layoutJsx, /id="forum-banner"/, 'Layout still renders #forum-banner');
    assert.match(layoutJsx, /dangerouslySetInnerHTML=\{\{ __html: sanitizedHeader \}\}/, 'the header HTML still renders inside the placeholder');
  });

  it('the admin cards render their background from the summary, and the modal loads full records', () => {
    const designsTab = read('../src/components/admin/DesignsTab.jsx');
    assert.match(designsTab, /loadDesignForEdit\(/, 'the modal loads its full record through the cached single-fetch helper');
    assert.match(
      designsTab,
      /resolveAvatarUrl\(design\.bgDefaultUrl\)/,
      'custom cards show the summary background as the cover, resolved against the backend origin',
    );
    assert.match(
      designsTab,
      /resolveAvatarUrl\(card\.bgDefaultUrl\)/,
      'default cards show the summary background as the cover, resolved against the backend origin',
    );
    assert.match(designsTab, /designs-card__cover/, 'the cover has its own card element');
    assert.doesNotMatch(
      designsTab,
      /setForm\(formFromCard\(target\.card\)\)/,
      'the modal form must never be built from the summary card',
    );
  });

  it('the theme picker renders from summaries and never fetches lists to apply a theme', () => {
    const profilePage = read('../src/pages/ProfilePage.jsx');
    assert.match(profilePage, /subscribeToDesigns\(setDesigns\)/, 'the picker still lists from the (summary) subscription');
    assert.doesNotMatch(profilePage, /getDesign\(|getDefaultDesign\(/, 'the picker never single-fetches a list to render');
    const designProvider = read('../src/contexts/DesignProvider.jsx');
    assert.match(
      designProvider,
      /fetchSingleDesign\(fetchTarget\)|fetchSingleDesign\(previewId\)/,
      'the provider applies a changed theme with single-record GETs',
    );
  });
});
