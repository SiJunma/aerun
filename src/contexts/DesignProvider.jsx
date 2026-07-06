import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useAuth } from './AuthProvider';
import { subscribeToDesigns } from '../api/designs';

const DesignContext = createContext();

export const useDesign = () => useContext(DesignContext);

export const DesignProvider = ({ children }) => {
  const { settings, profile } = useAuth();
  const [designs, setDesigns] = useState([]);
  
  // Parse URL params without useLocation so it works early
  const urlParams = new URLSearchParams(window.location.search);
  const previewId = urlParams.get('preview_design');

  useEffect(() => {
    return subscribeToDesigns(setDesigns);
  }, []);

  const activeDesign = useMemo(() => {
    if (designs.length === 0) return null;

    let targetId = null;

    if (previewId) {
      targetId = previewId;
    } else if (settings?.allowUserCustomDesign && profile?.settings?.theme) {
      targetId = profile.settings.theme;
    }

    // Fallback to default
    if (!targetId && settings?.defaultDesignId) {
      targetId = settings.defaultDesignId;
    }

    if (!targetId) return null;

    const design = designs.find(d => d.id === targetId);
    
    // Only allow inactive designs if we are previewing them explicitly
    if (design && (design.isActive || targetId === previewId)) {
      return design;
    }

    // If the targeted design is inactive or deleted, fallback to default if it wasn't the default we were looking for
    if (settings?.defaultDesignId && targetId !== settings.defaultDesignId) {
       const fallback = designs.find(d => d.id === settings.defaultDesignId);
       if (fallback && fallback.isActive) return fallback;
    }

    return null;
  }, [designs, settings, profile?.settings?.theme, previewId]);

  useEffect(() => {
    if (activeDesign) {
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
