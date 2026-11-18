/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useAuth } from './AuthProvider';
import { getDesigns } from '../api/designs';
import { makeStorageKey } from '../utils/storageScope';

const DesignContext = createContext();

export const useDesign = () => useContext(DesignContext);

const BUILTIN_THEMES = ['dark', 'light', 'neutral'];

export const DesignProvider = ({ children }) => {
  const { settings, profile } = useAuth();
  const [designs, setDesigns] = useState([]);
  
  // Parse URL params without useLocation so it works early
  const urlParams = new URLSearchParams(window.location.search);
  const previewId = urlParams.get('preview_design');

  useEffect(() => {
    let isSubscribed = true;
    getDesigns().then(d => {
      if (isSubscribed) setDesigns(d);
    }).catch(err => console.error('[DesignProvider]', err));
    return () => { isSubscribed = false; };
  }, []);

  const activeDesign = useMemo(() => {
    if (designs.length === 0) return null;

    let targetId = null;

    if (previewId) {
      targetId = previewId;
    } else if (profile?.settings?.theme) {
      // Авторизованный: серверная настройка — источник истины.
      targetId = profile.settings.theme;
    } else if (!profile) {
      // Гость: локальный выбор из localStorage (скопленный по гостю).
      // Built-in темы ('dark'/'light'/'neutral') не являются custom design —
      // их обрабатывает ThemeProvider, здесь пропускаем.
      try {
        const guestTheme = localStorage.getItem(makeStorageKey('guest_theme', 'guest'));
        if (guestTheme && !BUILTIN_THEMES.includes(guestTheme)) {
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

    // Built-in theme IDs ('dark','light','neutral') are valid defaults,
    // but they don't have a custom design entry — return null to let
    // ThemeProvider handle them via data-theme attribute.
    if (BUILTIN_THEMES.includes(targetId) && targetId !== previewId) {
      return null;
    }

    const design = designs.find(d => d.id === targetId);

    // Only allow inactive designs if we are previewing them explicitly
    if (design && (design.isActive || targetId === previewId)) {
      return design;
    }

    // Targeted design is inactive or deleted — try the global default
    if (settings?.defaultDesignId && targetId !== settings.defaultDesignId) {
      const defaultId = settings.defaultDesignId;
      // If the global default is also a built-in theme, return null gracefully
      if (BUILTIN_THEMES.includes(defaultId)) return null;
      const fallback = designs.find(d => d.id === defaultId);
      if (fallback && fallback.isActive) return fallback;
    }

    // No custom design found → let built-in theme apply
    return null;
  }, [designs, settings, profile, previewId]);

  useEffect(() => {
    if (activeDesign) {
      // Custom design active → mark the page as themeable so semantic
      // DOM hooks (always rendered) become the theme API.
      document.body.setAttribute('data-theme-engine', 'themeable');
      // 1. Inject CSS
      let styleEl = document.getElementById('custom-design-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-design-style';
        document.head.appendChild(styleEl);
      }
      styleEl.innerHTML = activeDesign.css || '';

      // 2. Inject JS
      // We must recreate the script element to force the browser to execute it
      let oldScriptEl = document.getElementById('custom-design-script');
      if (oldScriptEl) oldScriptEl.remove();

      if (activeDesign.js) {
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
    <DesignContext.Provider value={{ activeDesign }}>
      {children}
    </DesignContext.Provider>
  );
};
