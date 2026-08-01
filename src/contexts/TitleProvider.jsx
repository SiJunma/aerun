import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { useDesign } from './DesignProvider';

const TitleContext = createContext();

export const usePageTitle = () => useContext(TitleContext);

export const TitleProvider = ({ children }) => {
  const [pageTitle, setPageTitle] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const { settings, profile } = useAuth();
  const { activeDesign } = useDesign();

  useEffect(() => {
    let baseName = 'Forum';
    if (activeDesign?.forumTitle) {
      baseName = activeDesign.forumTitle;
    } else {
      const rawName = settings?.forumName;
      baseName =
        (typeof rawName === 'object' && rawName !== null)
          ? (rawName[profile?.settings?.language] || rawName.ru || rawName.en || 'Forum')
          : (rawName || 'Forum');
    }

    const titleParts = [];
    if (unreadCount > 0) {
      titleParts.push(`(${unreadCount})`);
    }
    if (pageTitle) {
      titleParts.push(pageTitle);
    }
    titleParts.push(baseName);

    document.title = titleParts.join(' | ');

    // Handle Favicon update
    const updateFavicon = (count) => {
      let link = document.querySelector("link[rel*='icon']");
      if (!link) {
        link = document.createElement('link');
        link.type = 'image/x-icon';
        link.rel = 'shortcut icon';
        document.head.appendChild(link);
      }
      
      const originalFaviconUrl = '/favicon.ico'; // assuming default favicon

      if (count > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.src = originalFaviconUrl;
        img.onload = () => {
          ctx.drawImage(img, 0, 0, 32, 32);
          
          // Draw badge circle
          ctx.beginPath();
          ctx.arc(22, 10, 9, 0, 2 * Math.PI);
          ctx.fillStyle = '#ff3b30'; // red badge
          ctx.fill();
          
          // Draw text
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 12px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(count > 9 ? '9+' : count.toString(), 22, 11);
          
          link.href = canvas.toDataURL('image/png');
        };
      } else {
        link.href = originalFaviconUrl;
      }
    };

    updateFavicon(unreadCount);

  }, [pageTitle, unreadCount, settings?.forumName, profile?.settings?.language, activeDesign]);

  return (
    <TitleContext.Provider value={{ setPageTitle, setUnreadCount, unreadCount }}>
      {children}
    </TitleContext.Provider>
  );
};
