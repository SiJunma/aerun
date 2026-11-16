/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthProvider';
import { makeStorageKey } from '../utils/storageScope';

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const { profile, settings, updateSettings } = useAuth();

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
    if (isStandardTheme) {
      document.body.setAttribute('data-theme', theme);
      document.body.removeAttribute('data-custom-design');
    } else {
      // If the theme is a custom design, we set the data-theme attribute to
      // the standard base theme (usually 'dark', or light/neutral if the default design is light/neutral).
      const baseTheme = getFallbackTheme();
      document.body.setAttribute('data-theme', baseTheme);
      document.body.setAttribute('data-custom-design', theme);
    }
  }, [theme, settings?.defaultDesignId, getFallbackTheme]);

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
