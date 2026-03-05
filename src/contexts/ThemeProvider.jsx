import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }) => {
  const { profile } = useAuth();
  const [theme, setTheme] = useState('dark'); // Default

  useEffect(() => {
    if (profile?.settings?.theme) {
      setTheme(profile.settings.theme);
    } else {
      // For guests or new users, default to dark
      setTheme('dark');
    }
  }, [profile]);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
  }, [theme]);

  const value = {
    theme,
    setTheme
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
