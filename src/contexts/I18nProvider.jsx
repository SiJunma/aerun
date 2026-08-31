/* eslint-disable react-refresh/only-export-components, react-hooks/set-state-in-effect */
import React, { createContext, useContext, useState, useEffect } from 'react';
import { translations } from '../i18n/dictionary';
import { useAuth } from './AuthProvider';

const I18nContext = createContext();

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
};

export const I18nProvider = ({ children }) => {
  const { profile, settings, updateSettings } = useAuth();
  
  // Detect browser language or use saved preference
  const getInitialLang = () => {
    const saved = localStorage.getItem('language');
    if (saved && (saved === 'ru' || saved === 'en')) return saved;
    
    const browserLang = navigator.language || navigator.userLanguage;
    return (browserLang && browserLang.toLowerCase().startsWith('ru')) ? 'ru' : 'en';
  };

  const [lang, setLangState] = useState(getInitialLang());

  useEffect(() => {
    if (profile?.settings?.language) {
      setLangState(profile.settings.language);
    }
  }, [profile]);

  const setLang = async (newLang) => {
    setLangState(newLang);
    localStorage.setItem('language', newLang);
    if (profile) {
      await updateSettings({ language: newLang });
    }
  };

  const t = (path, params = {}, fallback = null) => {
    let fallbackText = null;
    let actualParams = params;

    if (typeof params === 'string') {
      fallbackText = params;
      actualParams = (typeof fallback === 'object' && fallback !== null) ? fallback : {};
    } else if (typeof fallback === 'string') {
      fallbackText = fallback;
    }

    const keys = path.split('.');
    let result = translations[lang];

    for (const key of keys) {
      if (result) {
        result = result[key];
      }
    }

    // Fallback to English if translation missing in current language
    if (!result && lang !== 'en') {
      let fallbackDict = translations['en'];
      for (const key of keys) {
        if (fallbackDict) fallbackDict = fallbackDict[key];
      }
      result = fallbackDict;
    }

    if (typeof result === 'string') {
      // Basic interpolation: replace {key} with actualParams[key]
      Object.keys(actualParams).forEach(key => {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, actualParams[key]);
      });
      return result;
    }

    return fallbackText || result || path;
  };

  const value = {
    lang,
    setLang,
    t,
    translations
  };

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
};
