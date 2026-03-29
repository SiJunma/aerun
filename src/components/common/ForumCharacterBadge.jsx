import React from 'react';
import { Badge, OverlayTrigger, Tooltip } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Renders a "Character" badge with a tooltip showing the account owner's nickname.
 * Matches the style of role-badges.
 * 
 * Props:
 *   ownerName    {string}  — Nickname of the user who owns the character mask
 *   size         {string?} — 'sm' for metadata lines, 'md' (default) for sidebar
 *   hideTooltip  {boolean} — Whether to suppress the tooltip (for list views)
 *   className    {string?} — Extra CSS classes
 */
const ForumCharacterBadge = ({ 
  ownerName, 
  size = 'md',
  hideTooltip = false,
  className = '' 
}) => {
  const { lang } = useI18n();
  
  const isSm = size === 'sm';
  const label = isSm 
    ? (lang === 'ru' ? 'Перс.' : 'Char.')
    : (lang === 'ru' ? 'Персонаж' : 'Character');
    
  // If ownerName is not provided, we just show the badge without tooltip
  const showTooltip = !hideTooltip && !!ownerName;

  const badgeElement = (
    <Badge 
      className={`role-badge badge-character ${isSm ? 'badge-character-sm' : ''} ${className}`} 
      style={{ cursor: showTooltip ? 'help' : 'default' }}
    >
      {label}
    </Badge>
  );

  if (!showTooltip) {
    return badgeElement;
  }

  const renderTooltip = (props) => (
    <Tooltip id="character-owner-tooltip" {...props}>
      {lang === 'ru' ? `Игрок: ${ownerName}` : `Player: ${ownerName}`}
    </Tooltip>
  );

  return (
    <OverlayTrigger
      placement="top"
      overlay={renderTooltip}
      delay={{ show: 200, hide: 200 }}
    >
      {badgeElement}
    </OverlayTrigger>
  );
};

export default ForumCharacterBadge;
