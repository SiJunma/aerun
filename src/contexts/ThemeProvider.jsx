/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthProvider';
import { useDesign } from './DesignProvider';
import { resolveDesignBaseTheme } from '../api/designs';
import { makeStorageKey } from '../utils/storageScope';

const ThemeContext = createContext();

const BUILTIN_THEMES = ['dark', 'light', 'neutral'];

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const { profile, settings, updateSettings } = useAuth();
  const { activeDesign, previewDesignId } = useDesign();

  const getFallbackTheme = useCallback(() => {
    if (settings?.defaultDesignId && ['light', 'dark', 'neutral'].includes(settings.defaultDesignId)) {
      return settings.defaultDesignId;
    }
    return 'dark';
  }, [settings]);

  const readGuestTheme = useCallback(() => {
    return localStorage.getItem(makeStorageKey('guest_theme', 'guest'));
  }, []);

  const serverTheme = profile?.settings?.theme || null;

  const initialTheme = useCallback(() => {
    if (serverTheme) return serverTheme;
    return readGuestTheme() || getFallbackTheme();
  }, [serverTheme, readGuestTheme, getFallbackTheme]);

  const [theme, setTheme] = useState(initialTheme);

  // Миграция гостевой темы в аккаунт: пользователь вошёл, на сервере тема не задана,
  // а в localStorage есть гостевой выбор — отправить на сервер (один раз при входе).
  useEffect(() => {
    if (profile && !serverTheme) {
      const guest = readGuestTheme();
      if (guest) {
        updateSettings({ theme: guest }).catch(() => {
          // Не критично: сервер недоступен, локальный выбор остаётся в localStorage.
        });
      }
    }
  }, [profile, serverTheme, updateSettings, readGuestTheme]);

  // Реакция на изменение серверной настройки темы (сохранение в профиле и т.п.).
  const [prevThemeSource, setPrevThemeSource] = useState(serverTheme);
  if (serverTheme !== prevThemeSource) {
    setPrevThemeSource(serverTheme);
    setTheme(serverTheme || readGuestTheme() || getFallbackTheme());
  }

  // A guest without an explicit theme choice must open with the forum's default
  // design, not with the hardcoded dark fallback. `settings.defaultDesignId`
  // arrives asynchronously (via getGlobalSettings), so the fallback is applied
  // once it is known — but never overriding an explicit localStorage choice or
  // a signed-in member's own preference. Applied during render (like the
  // themeSource sync above) so it never causes a cascading render from an effect.
  // A guest without an explicit theme choice opens with the forum's default
  // design via the initialTheme above; no separate fallback render needed here.



  useEffect(() => {
    const isStandardTheme = ['light', 'dark', 'neutral'].includes(theme);
    if (previewDesignId && activeDesign) {
      // Previewing a design: its own base theme governs the palette, no
      // matter which theme the viewer uses themselves. A default card IS its
      // own base theme, so its key governs directly.
      document.body.setAttribute('data-theme', activeDesign.isDefaultDesign
        ? activeDesign.key
        : resolveDesignBaseTheme(activeDesign, settings));
      document.body.setAttribute('data-custom-design', activeDesign.id);
      return;
    }
    if (activeDesign?.isDefaultDesign && BUILTIN_THEMES.includes(activeDesign.key)) {
      // The active card is a built-in theme card (e.g. the forum default
      // resolved as a fallback for a hidden/deactivated selection).
      document.body.setAttribute('data-theme', activeDesign.key);
      document.body.removeAttribute('data-custom-design');
      return;
    }
    if (isStandardTheme) {
      document.body.setAttribute('data-theme', theme);
      document.body.removeAttribute('data-custom-design');
    } else {
      // A selected custom design layers on top of its own base theme.
      const baseTheme = activeDesign
        ? resolveDesignBaseTheme(activeDesign, settings)
        : getFallbackTheme();
      document.body.setAttribute('data-theme', baseTheme);
      document.body.setAttribute('data-custom-design', theme);
    }
  }, [theme, settings, settings?.defaultDesignId, getFallbackTheme, activeDesign, previewDesignId]);

  // Сохранение выбора темы: авторизованный → на сервер (users.settings), гость → localStorage.
  const changeTheme = useCallback((newTheme) => {
    setTheme(newTheme);
    if (profile) {
      updateSettings({ theme: newTheme }).catch(() => {});
    } else {
      try {
        localStorage.setItem(makeStorageKey('guest_theme', 'guest'), newTheme);
      } catch {
        // localStorage может быть недоступен (приватный режим) — деградируем мягко.
      }
    }
  }, [profile, updateSettings]);

  const value = {
    theme,
    setTheme,
    // changeGuestTheme — обратная совместимость с Navbar, за ним та же логика.
    changeGuestTheme: changeTheme,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
