/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthProvider';
import { fetchSingleDesign, resolveActiveDesign, toDesign, toDefaultDesign } from '../api/designs';
import { makeStorageKey } from '../utils/storageScope';

const DesignContext = createContext();

export const useDesign = () => useContext(DesignContext);

const BUILTIN_THEMES = ['dark', 'light', 'neutral'];

// A card is usable as the SELECTED theme only while it is listed (default)
// or active (custom). As the forum-default FALLBACK a hidden/deactivated
// card still counts — a theme removed from the list stays usable as the
// fallback, it just can no longer be (re-)selected.
const isSelectableCard = (card) => {
  if (!card) return false;
  return card.isDefaultDesign ? Boolean(card.showInList) : Boolean(card.isActive);
};

export const DesignProvider = ({ children }) => {
  const { settings, profile } = useAuth();
  // The one full card fetched on demand (preview, or a target the embedded
  // card cannot answer), together with the target it was resolved for.
  // No full lists live here anymore: the list endpoints return summaries
  // only, and a summary is not a full record — resolving the active design
  // from one would inject empty css/js/header. See fetchSingleDesign.
  const [single, setSingle] = useState({ for: null, card: null });

  // Parse URL params without useLocation so it works early
  const urlParams = new URLSearchParams(window.location.search);
  const previewId = urlParams.get('preview_design');

  // The installed/assigned card the server resolved for this visitor and
  // embedded in the settings snapshot (GET /api/aerun/settings, `activeDesign`).
  // It travels on the settings fetch the app already makes on boot, so the
  // chrome applies it the moment the settings arrive — no waiting for any
  // design fetch. Mapped with the same toDesign/toDefaultDesign the
  // single-record endpoints use, so a card from the snapshot is identical
  // in shape to one from a GET (including file URLs, which stay exactly as
  // stored — relative /api/files/... — and are resolved client-side against
  // pbUrl by the chrome consumers, never here).
  const embeddedDesign = useMemo(() => {
    const raw = settings?.activeDesign;
    if (!raw) return null;
    return raw.kind === 'default' ? toDefaultDesign(raw) : toDesign(raw);
  }, [settings?.activeDesign]);

  const embeddedIdentity = embeddedDesign
    ? (embeddedDesign.isDefaultDesign ? embeddedDesign.key : embeddedDesign.id)
    : null;

  // The settings snapshot the app boots with is a hardcoded literal without
  // defaultDesignId/activeDesign; both keys appear only once the fetch
  // settles (success, or the DEFAULT_GLOBAL_SETTINGS fallback on failure),
  // so their presence is the "settings arrived" signal. Before that, deciding
  // anything about the active design would fire the fetch this change exists
  // to avoid — so the provider waits, with activeDesign null meanwhile,
  // exactly as it used to wait for the lists.
  const settingsReady = Boolean(settings) && ('defaultDesignId' in settings || 'activeDesign' in settings);

  // Target id, as before: member theme > guest local choice > forum default.
  const targetId = useMemo(() => {
    if (profile?.settings?.theme) {
      // Авторизованный: серверная настройка — источник истины.
      return profile.settings.theme;
    }
    if (!profile) {
      // Гость: локальный выбор из localStorage (скопленный по гостю).
      try {
        const guestTheme = localStorage.getItem(makeStorageKey('guest_theme', 'guest'));
        if (guestTheme) {
          return guestTheme;
        }
      } catch {
        // localStorage недоступен — игнорируем гостевой выбор.
      }
    }
    if (settings?.defaultDesignId) {
      return settings.defaultDesignId;
    }
    return null;
  }, [profile, settings]);

  // The single target that needs one GET, or null when the embedded card
  // already answers it: a preview (explicit, needs any card by id), a
  // target that changed after boot (theme switch, guest choice differing
  // from the snapshot), or no embedded card at all (settings fetch failed,
  // or an older server without the field) — then the forum default itself
  // is fetched once. The theme picker (ProfilePage) and the admin tab read
  // the SUMMARY lists through their own subscriptions; the module-level
  // cache in api/designs makes that one fetch, and neither list is ever
  // used to resolve the active design.
  const fetchTarget = useMemo(() => {
    if (previewId) return previewId;
    if (!settingsReady) return null;
    if (targetId && targetId !== embeddedIdentity) return targetId;
    if (!embeddedDesign) return targetId || settings?.defaultDesignId || null;
    return null;
  }, [previewId, settingsReady, targetId, embeddedIdentity, embeddedDesign, settings?.defaultDesignId]);

  const defaultDesignId = settings?.defaultDesignId || null;

  useEffect(() => {
    if (!fetchTarget) return;
    let alive = true;
    // No synchronous reset here: while the new GET is in flight the memo
    // below refuses the stale card outright (single.for !== target), so
    // nothing stale can apply — the loading state is the null activeDesign.
    (async () => {
      try {
        if (previewId && fetchTarget === previewId) {
          // Preview is explicit: any card by id, custom or default, active or not.
          const card = await fetchSingleDesign(previewId);
          if (alive) setSingle({ for: fetchTarget, card });
          return;
        }
        const card = await fetchSingleDesign(fetchTarget);
        if (!alive) return;
        if (isSelectableCard(card)) {
          setSingle({ for: fetchTarget, card });
          return;
        }
        // Targeted card is hidden/removed or deactivated — fall back to the
        // forum default; if that is unavailable too, let the built-in theme apply.
        if (defaultDesignId && fetchTarget !== defaultDesignId) {
          const fallback = await fetchSingleDesign(defaultDesignId);
          if (alive) setSingle({ for: fetchTarget, card: fallback });
          return;
        }
        // The hidden card IS the forum default: it stays usable as the
        // fallback even though it can no longer be (re-)selected.
        if (alive) setSingle({ for: fetchTarget, card });
      } catch (err) {
        console.error('[DesignProvider]', err);
        if (alive) setSingle({ for: fetchTarget, card: null });
      }
    })();
    return () => { alive = false; };
  }, [fetchTarget, previewId, defaultDesignId]);

  const activeDesign = useMemo(() => {
    if (previewId) {
      // Preview is explicit: the single fetch above, and only it, answers.
      return single.for === previewId ? single.card : null;
    }

    if (targetId) {
      // The embedded card answers this target directly — no fetch needed.
      if (embeddedDesign && embeddedIdentity === targetId) return embeddedDesign;
      // Target changed after boot (or no embedded card): the single fetch
      // for this target, fallback-resolved inside the effect. A stale
      // `single` (fetched for another target) never applies.
      if (single.for === targetId) return single.card;
      return null;
    }

    // No explicit target: the embedded card IS what the server resolved for
    // this visitor (their theme, else the forum default, else the built-in
    // dark card) — apply it without any fetch.
    if (embeddedDesign) return embeddedDesign;
    if (single.for === defaultDesignId) return single.card;
    return null;
  }, [previewId, targetId, embeddedDesign, embeddedIdentity, single, defaultDesignId]);

  // Effective values of the active card with the overwrite toggles and the
  // surface-1 fallback applied (see resolveActiveDesign). Every chrome
  // consumer (background, header/footer, title, favicon, placeholders) reads
  // this, never the raw card or settings.* directly.
  const resolvedDesign = useMemo(
    () => resolveActiveDesign(settings, activeDesign),
    [settings, activeDesign]
  );

  useEffect(() => {
    if (activeDesign) {
      // Custom design active → mark the page as themeable so semantic
      // DOM hooks (always rendered) become the theme API.
      document.body.setAttribute('data-theme-engine', 'themeable');
      // 1. Inject CSS — only the card's own code, and only when its
      // overwrite toggle is on; OFF means "no own code, pure built-in theme".
      let styleEl = document.getElementById('custom-design-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-design-style';
        document.head.appendChild(styleEl);
      }
      styleEl.innerHTML = activeDesign.overwriteCss ? (activeDesign.css || '') : '';

      // 2. Inject JS — same toggle rule as CSS.
      // We must recreate the script element to force the browser to execute it
      let oldScriptEl = document.getElementById('custom-design-script');
      if (oldScriptEl) oldScriptEl.remove();

      if (activeDesign.overwriteJs && activeDesign.js) {
        const scriptEl = document.createElement('script');
        scriptEl.id = 'custom-design-script';
        scriptEl.innerHTML = activeDesign.js;
        document.body.appendChild(scriptEl);
      }
    } else {
      document.body.removeAttribute('data-theme-engine');
      // Cleanup
      document.getElementById('custom-design-style')?.remove();
      document.getElementById('custom-design-script')?.remove();
    }
  }, [activeDesign]);

  return (
    <DesignContext.Provider value={{ activeDesign, resolvedDesign, previewDesignId: previewId || null }}>
      {children}
    </DesignContext.Provider>
  );
};
