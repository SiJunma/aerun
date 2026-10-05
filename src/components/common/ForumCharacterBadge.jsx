import React from 'react';
import { Badge, OverlayTrigger, Tooltip } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Renders a "Character" badge with a tooltip showing the account owner's nickname.
 * Matches the style of role-badges.
 * 
 * Props:
 *   characterName {string?} — Name of the character the post was written as. When
 *                             given, the badge READS as that name instead of the
 *                             generic "Char." label: on a list row there is no
 *                             author header above it, so a badge that only says
 *                             "Char." is indistinguishable between two posts by
 *                             two different characters.
 *   ownerName    {string}  — Nickname of the user who owns the character mask
 *   size         {string?} — 'sm' for metadata lines, 'md' (default) for sidebar
 *   hideTooltip  {boolean} — Whether to suppress the tooltip (for list views)
 *   className    {string?} — Extra CSS classes
 */
const ForumCharacterBadge = ({ 
  characterName,
  ownerName, 
  size = 'md',
  hideTooltip = false,
  className = '' 
}) => {
  const { lang } = useI18n();
  
  const isSm = size === 'sm';
  // A known name always wins over the generic label; the label is the fallback
  // for the sidebar, where the character name is already the headline above it.
  const named = typeof characterName === 'string' ? characterName.trim() : '';
  const label = named || (isSm 
    ? (lang === 'ru' ? 'Перс.' : 'Char.')
    : (lang === 'ru' ? 'Персонаж' : 'Character'));
    
  // If ownerName is not provided, we just show the badge without tooltip
  const showTooltip = !hideTooltip && !!ownerName;

  const badgeElement = (
    <Badge 
      className={`role-badge badge-character ${isSm ? 'badge-character-sm' : ''} ${className}`} 
      style={{ cursor: showTooltip ? 'help' : 'default' }}
      // The badge sits on the same line as the topic headline and must never be
      // the thing that wraps it, so a long character name truncates instead.
      title={named || undefined}
    >
      <span className="badge-character-name">{label}</span>
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
