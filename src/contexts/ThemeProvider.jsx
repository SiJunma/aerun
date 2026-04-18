/* eslint-disable react-refresh/only-export-components, react-hooks/set-state-in-effect */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthProvider';

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const { profile } = useAuth();
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('guest_theme') || 'dark';
  });

  useEffect(() => {
    if (profile?.settings?.theme) {
      setTheme(profile.settings.theme);
      localStorage.setItem('guest_theme', profile.settings.theme);
    } else {
      // For guests or new users
      setTheme(localStorage.getItem('guest_theme') || 'dark');
    }
  }, [profile]);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

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
