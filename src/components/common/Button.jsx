import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Button: Unified button component for the forum.
 * Replaces all ad-hoc button classes with a single semantic component.
 * 
 * Variants:
 * - primary: Main action button (filled primary color)
 * - secondary: Secondary action (outlined, subtle)
 * - ghost: Text-only button (like link but button semantics)
 * - filled: Filled with secondary color (for less prominent filled buttons)
 * - danger: Destructive action (red)
 * 
 * Sizes:
 * - default: Standard size (matches other page buttons)
 * - sm: Small (for compact spaces like inline editor)
 * - lg: Large (for prominent CTAs)
 * 
 * Props:
 * - variant: 'primary' | 'secondary' | 'ghost' | 'filled' | 'danger'
 * - size: 'default' | 'sm' | 'lg'
 * - fullWidth: boolean (block button)
 * - iconOnly: boolean (icon only, square)
 * - leftIcon: ReactNode
 * - rightIcon: ReactNode
 * - loading: boolean
 * - disabled: boolean
 * - type: 'button' | 'submit' | 'reset'
 * - onClick: handler
 * - children: label
 * - className: additional classes
 * - ...rest: other button attributes
 */
export const Button = ({
  variant = 'primary',
  size = 'default',
  fullWidth = false,
  iconOnly = false,
  leftIcon,
  rightIcon,
  loading = false,
  disabled = false,
  type = 'button',
  onClick,
  children,
  className = '',
  ...rest
}) => {
  const { t } = useI18n();

  const baseClasses = 'topic-btn';
  const variantClasses = {
    primary: 'topic-btn--primary',
    secondary: 'topic-btn--secondary',
    ghost: 'topic-btn--ghost',
    filled: 'topic-btn--filled',
    danger: 'topic-btn--danger',
  };
  const sizeClasses = {
    default: '',
    sm: 'topic-btn-sm',
    lg: 'topic-btn-lg',
  };
  const widthClass = fullWidth ? 'topic-btn--block' : '';
  const iconOnlyClass = iconOnly ? 'topic-btn--icon-only' : '';
  const loadingClass = loading ? 'topic-btn--loading' : '';

  const classNames = [
    baseClasses,
    variantClasses[variant],
    sizeClasses[size],
    widthClass,
    iconOnlyClass,
    loadingClass,
    className,
  ].filter(Boolean).join(' ');

  // If loading, show spinner and keep button width stable
  const content = loading ? (
    <>
      <span className="topic-btn__spinner" aria-hidden="true" />
      <span className="topic-btn__loading-text">{t?.('common.loading') || 'Loading...'}</span>
    </>
  ) : (
    <>
      {iconOnly && leftIcon && <span className="topic-btn__icon">{leftIcon}</span>}
      {!iconOnly && leftIcon && <span className="topic-btn__icon topic-btn__icon--left">{leftIcon}</span>}
      <span className="topic-btn__label">{children}</span>
      {!iconOnly && rightIcon && <span className="topic-btn__icon topic-btn__icon--right">{rightIcon}</span>}
    </>
  );

  return (
    <button
      type={type}
      className={classNames}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {content}
    </button>
  );
};

export default Button;