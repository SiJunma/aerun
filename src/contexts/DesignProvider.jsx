/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useAuth } from './AuthProvider';
import { getDesigns, getDefaultDesigns, resolveActiveDesign } from '../api/designs';
import { makeStorageKey } from '../utils/storageScope';

const DesignContext = createContext();

export const useDesign = () => useContext(DesignContext);

const BUILTIN_THEMES = ['dark', 'light', 'neutral'];

export const DesignProvider = ({ children }) => {
  const { settings, profile } = useAuth();
  const [designs, setDesigns] = useState([]);
  const [defaultDesigns, setDefaultDesigns] = useState([]);

  // Parse URL params without useLocation so it works early
  const urlParams = new URLSearchParams(window.location.search);
  const previewId = urlParams.get('preview_design');

  useEffect(() => {
    let isSubscribed = true;
    getDesigns().then(d => {
      if (isSubscribed) setDesigns(d);
    }).catch(err => console.error('[DesignProvider]', err));
    getDefaultDesigns().then(d => {
      if (isSubscribed) setDefaultDesigns(d);
    }).catch(err => console.error('[DesignProvider]', err));
    return () => { isSubscribed = false; };
  }, []);

  const activeDesign = useMemo(() => {
    // Resolve one target id to its card. `allowHidden` is true only for the
    // forum-default fallback itself: a theme removed from the list stays
    // usable as the fallback, it just can no longer be (re-)selected.
    const resolveTarget = (targetId, allowHidden = false) => {
      if (!targetId) return null;
      if (BUILTIN_THEMES.includes(targetId)) {
        if (defaultDesigns.length === 0) return null;
        const card = defaultDesigns.find(d => d.key === targetId);
        if (!card) return null;
        if (!allowHidden && !card.showInList) return 'hidden';
        return card;
      }
      const design = designs.find(d => d.id === targetId);
      if (!design) return null;
      if (!allowHidden && !design.isActive) return 'hidden';
      return design;
    };

    const resolveWithFallback = (targetId) => {
      if (!targetId) return null;
      const found = resolveTarget(targetId);
      if (found && found !== 'hidden') return found;
      // Targeted card is hidden/removed or deactivated — fall back to the
      // forum default; if that is unavailable too, let the built-in theme apply.
      if (settings?.defaultDesignId) {
        if (targetId !== settings.defaultDesignId) {
          const fallback = resolveTarget(settings.defaultDesignId, true);
          if (fallback && fallback !== 'hidden') return fallback;
        } else if (found === 'hidden') {
          // The hidden card IS the forum default: it stays usable as the
          // fallback even though it can no longer be (re-)selected.
          const self = resolveTarget(targetId, true);
          if (self && self !== 'hidden') return self;
        }
      }
      return null;
    };

    if (previewId) {
      // Preview is explicit: any card by id, custom or default, active or not.
      const custom = designs.find(d => d.id === previewId);
      if (custom) return custom;
      const builtin = defaultDesigns.find(d => d.id === previewId || d.key === previewId);
      if (builtin) return builtin;
      return null;
    }

    let targetId = null;

    if (profile?.settings?.theme) {
      // Авторизованный: серверная настройка — источник истины.
      targetId = profile.settings.theme;
    } else if (!profile) {
      // Гость: локальный выбор из localStorage (скопленный по гостю).
      try {
        const guestTheme = localStorage.getItem(makeStorageKey('guest_theme', 'guest'));
        if (guestTheme) {
          targetId = guestTheme;
        }
      } catch {
        // localStorage недоступен — игнорируем гостевой выбор.
      }
    }

    // Fallback to global default
    if (!targetId && settings?.defaultDesignId) {
      targetId = settings.defaultDesignId;
    }

    if (!targetId) return null;
    return resolveWithFallback(targetId);
  }, [designs, defaultDesigns, settings, profile, previewId]);

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
    <DesignContext.Provider value={{ activeDesign, defaultDesigns, designs, resolvedDesign, previewDesignId: previewId || null }}>
      {children}
    </DesignContext.Provider>
  );
};
