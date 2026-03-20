import React from 'react';
import { useAuth } from '../../contexts/AuthProvider';
import { useTheme } from '../../contexts/ThemeProvider';

const getResponsiveSrcSet = (url) => {
  if (!url || typeof url !== 'string') return '';
  if (url.includes('images.unsplash.com')) {
    const baseUrl = url.split('?')[0];
    const params = new URLSearchParams(url.split('?')[1] || '');
    params.delete('w');
    params.set('auto', 'format');
    params.set('fit', 'crop');
    params.set('q', '80');

    return [600, 1000, 1400, 2000]
      .map(w => {
        params.set('w', w.toString());
        return `${baseUrl}?${params.toString()} ${w}w`;
      })
      .join(', ');
  }
  return url;
};

const ForumBackground = () => {
  const { settings } = useAuth();
  const { theme } = useTheme();

  return (
    <>
      {theme === 'neutral' && settings?.bgNeutral && (
        <picture id="bg_forum_picture__neutral">
          <source srcSet={getResponsiveSrcSet(settings.bgNeutral)} sizes="100vw" />
          <img src={settings.bgNeutral} alt="" className="forum-bg-img" style={{ opacity: settings.bgOpacityNeutral ?? 0.5 }} />
        </picture>
      )}
      {theme === 'dark' && settings?.bgDark && (
        <picture id="bg_forum_picture__dark">
          <source srcSet={getResponsiveSrcSet(settings.bgDark)} sizes="100vw" />
          <img src={settings.bgDark} alt="" className="forum-bg-img" style={{ opacity: settings.bgOpacityDark ?? 0.5 }} />
        </picture>
      )}
      {theme === 'light' && settings?.bgLight && (
        <picture id="bg_forum_picture__light">
          <source srcSet={getResponsiveSrcSet(settings.bgLight)} sizes="100vw" />
          <img src={settings.bgLight} alt="" className="forum-bg-img" style={{ opacity: settings.bgOpacityLight ?? 0.5 }} />
        </picture>
      )}
    </>
  );
};

export default ForumBackground;
