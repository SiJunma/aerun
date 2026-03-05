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
  const { profile, updateSettings } = useAuth();
  const [lang, setLangState] = useState('en');

  useEffect(() => {
    if (profile?.settings?.language) {
      setLangState(profile.settings.language);
    }
  }, [profile]);

  const setLang = async (newLang) => {
    setLangState(newLang);
    if (profile) {
      await updateSettings({ language: newLang });
    }
  };

  const t = (path) => {
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
