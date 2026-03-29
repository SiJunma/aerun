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

  // Sync document.title with forumName (bilingual)
  useEffect(() => {
    if (settings?.forumName) {
      if (typeof settings.forumName === 'object') {
        document.title = settings.forumName[lang] || settings.forumName.en || 'Aerun Forum';
      } else {
        document.title = settings.forumName;
      }
    }
  }, [settings?.forumName, lang]);

  const setLang = async (newLang) => {
    setLangState(newLang);
    localStorage.setItem('language', newLang);
    if (profile) {
      await updateSettings({ language: newLang });
    }
  };

  const t = (path, params = {}) => {
    const keys = path.split('.');
    let result = translations[lang];

    for (const key of keys) {
      if (result) {
        result = result[key];
      }
    }

    // Fallback to English if translation missing in current language
    if (!result && lang !== 'en') {
      let fallback = translations['en'];
      for (const key of keys) {
        if (fallback) fallback = fallback[key];
      }
      result = fallback;
    }

    if (typeof result === 'string') {
      // Basic interpolation: replace {key} with params[key]
      Object.keys(params).forEach(key => {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, params[key]);
      });
      return result;
    }

    return result || path;
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
