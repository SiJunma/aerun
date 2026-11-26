import React from 'react';
import { useDesign } from '../../contexts/DesignProvider';

// The background comes from the ACTIVE CARD (custom or default), resolved
// through resolveActiveDesign — never from the theme name or settings.bg*.
// No default image on the card means no <picture> at all.
const ForumBackground = () => {
  const { activeDesign, resolvedDesign } = useDesign();
  const background = resolvedDesign?.background;

  if (!background || !background.default) return null;

  const cardKey = activeDesign?.isDefaultDesign
    ? (activeDesign.key || activeDesign.id)
    : activeDesign?.id;

  return (
    <picture id={`bg_forum_picture__${cardKey}`}>
      <source media="(max-width: 768px)" srcSet={background.mobile || background.default} />
      <source media="(max-width: 1280px)" srcSet={background.tablet || background.default} />
      <img src={background.default} alt="" className="forum-bg-img" style={{ opacity: resolvedDesign.opacity ?? 0.5 }} />
    </picture>
  );
};

export default ForumBackground;
