/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthProvider';

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const { profile, settings } = useAuth();

  const getFallbackTheme = useCallback(() => {
    if (settings?.defaultDesignId && ['light', 'dark', 'neutral'].includes(settings.defaultDesignId)) {
      return settings.defaultDesignId;
    }
    return 'dark';
  }, [settings]);

  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('guest_theme') || getFallbackTheme();
  });

  // Sync the active theme with the signed-in member's preference during render
  // instead of inside an effect: `profile.settings.theme` is the source of truth
  // when present, otherwise the guest/fallback theme applies. Doing it here (a
  // state adjustment on a changed source, React's documented pattern) avoids the
  // cascading render the old effect triggered on every mount.
  const themeSource = profile?.settings?.theme || null;
  const [prevThemeSource, setPrevThemeSource] = useState(themeSource);
  if (themeSource !== prevThemeSource) {
    setPrevThemeSource(themeSource);
    setTheme(themeSource || localStorage.getItem('guest_theme') || getFallbackTheme());
  }

  // Persist the member's own theme choice to the guest store so it survives a
  // reload. Kept as a pure side-effect here (no setState), so it is not a
  // cascading render.
  useEffect(() => {
    if (themeSource) {
      localStorage.setItem('guest_theme', themeSource);
    }
  }, [themeSource]);

  // A guest without an explicit theme choice must open with the forum's default
  // design, not with the hardcoded dark fallback. `settings.defaultDesignId`
  // arrives asynchronously (via getGlobalSettings), so the fallback is applied
  // once it is known — but never overriding an explicit localStorage choice or
  // a signed-in member's own preference. Applied during render (like the
  // themeSource sync above) so it never causes a cascading render from an effect.
  const [prevFallbackTheme, setPrevFallbackTheme] = useState(getFallbackTheme());
  const currentFallbackTheme = getFallbackTheme();
  if (
    !themeSource &&
    !localStorage.getItem('guest_theme') &&
    currentFallbackTheme !== prevFallbackTheme
  ) {
    setPrevFallbackTheme(currentFallbackTheme);
    setTheme(currentFallbackTheme);
  }

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

  const changeGuestTheme = useCallback((newTheme) => {
    setTheme(newTheme);
    localStorage.setItem('guest_theme', newTheme);
  }, []);

  const value = {
    theme,
    setTheme,
    changeGuestTheme
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
