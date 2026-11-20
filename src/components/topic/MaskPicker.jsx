import React, { useRef, useEffect, useState } from 'react';
import { User, ChevronDown } from 'lucide-react';

/**
 * MaskPicker: Custom dropdown for selecting post mask (user profile or character).
 * Replaces native <select> and react-bootstrap Dropdown.
 * 
 * Props:
 *   - value: currently selected character ID ('' for user profile)
 *   - onChange: callback(characterId)
 *   - characters: array of character objects {id, name}
 *   - profile: user profile object {nickname, email}
 *   - user: user object (for setLastSelectedMask)
 *   - setLastSelectedMask: function to persist last used mask
 *   - t: translation function
 *   - disabled: boolean
 *   - className: additional CSS classes
 */
export const MaskPicker = ({
  value,
  onChange,
  characters = [],
  profile,
  user,
  setLastSelectedMask,
  t,
  disabled = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  // Get display label for current selection
  const getDisplayLabel = (charId) => {
    if (!charId) {
      return `${t?.('forum.post_as_user_label') || 'User'}: ${profile?.nickname || profile?.email?.split('@')[0]}`;
    }
    const char = characters.find(c => c.id === charId);
    return char ? `${t?.('forum.post_as_character_label') || 'Character'}: ${char.name}` : '';
  };

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle Escape key
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleSelect = (charId) => {
    onChange(charId);
    if (user && setLastSelectedMask) {
      setLastSelectedMask(charId);
    }
    setIsOpen(false);
  };

  const currentLabel = getDisplayLabel(value);

  return (
    <div className={`topic-mask-picker ${className}`} ref={wrapperRef}>
      <button
        type="button"
        ref={buttonRef}
        className="topic-mask-picker__toggle"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <User size={16} className="topic-mask-picker__icon" />
        <span className="topic-mask-picker__label">{currentLabel}</span>
        <ChevronDown size={14} className={`topic-mask-picker__chevron ${isOpen ? 'topic-mask-picker__chevron--open' : ''}`} />
      </button>

      {isOpen && (
        <div className="topic-mask-picker__menu" role="listbox">
          <button
            type="button"
            className={`topic-mask-picker__item ${value === '' ? 'topic-mask-picker__item--active' : ''}`}
            role="option"
            aria-selected={value === ''}
            onClick={() => handleSelect('')}
          >
            <User size={14} className="topic-mask-picker__item-icon" />
            <span>{t?.('forum.post_as_user_label') || 'User'}: {profile?.nickname || profile?.email?.split('@')[0]}</span>
          </button>
          {characters.length > 0 && (
            <>
              <div className="topic-mask-picker__divider" />
              {characters.map(char => (
                <button
                  key={char.id}
                  type="button"
                  className={`topic-mask-picker__item ${value === char.id ? 'topic-mask-picker__item--active' : ''}`}
                  role="option"
                  aria-selected={value === char.id}
                  onClick={() => handleSelect(char.id)}
                >
                  <span className="topic-mask-picker__item-icon" aria-hidden="true">★</span>
                  <span>{t?.('forum.post_as_character_label') || 'Character'}: {char.name}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default MaskPicker;