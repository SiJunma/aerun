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
  }, [settings?.defaultDesignId]);

  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('guest_theme') || 'dark';
  });

  useEffect(() => {
    if (profile?.settings?.theme) {
      setTheme(profile.settings.theme);
      localStorage.setItem('guest_theme', profile.settings.theme);
    } else {
      // For guests or new users
      setTheme(localStorage.getItem('guest_theme') || getFallbackTheme());
    }
  }, [profile, getFallbackTheme]);

  useEffect(() => {
    const isStandardTheme = ['light', 'dark', 'neutral'].includes(theme);
    if (isStandardTheme) {
      document.body.setAttribute('data-theme', theme);
      document.body.removeAttribute('data-custom-design');
    } else {
      // If the theme is a custom design, we set the data-theme attribute to
      // the standard base theme (usually 'dark', or light/neutral if the default design is light/neutral).
      const baseTheme = (settings?.defaultDesignId && ['light', 'dark', 'neutral'].includes(settings.defaultDesignId))
        ? settings.defaultDesignId
        : 'dark';
      document.body.setAttribute('data-theme', baseTheme);
      document.body.setAttribute('data-custom-design', theme);
    }
  }, [theme, settings?.defaultDesignId]);

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
