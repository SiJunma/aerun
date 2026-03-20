import React from 'react';
import PropTypes from 'prop-types';

/**
 * Reusable Skeleton component for loading states.
 * Uses existing CSS classes from index.css.
 */
const Skeleton = ({ width, height, variant, className = '', style = {} }) => {
  const baseClass = 'skeleton';
  const variantClass = variant ? `skeleton-${variant}` : '';
  
  const combinedStyle = {
    width: width || undefined,
    height: height || undefined,
    ...style
  };

  return (
    <div 
      className={`${baseClass} ${variantClass} ${className}`} 
      style={combinedStyle} 
    />
  );
};

Skeleton.propTypes = {
  width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  variant: PropTypes.oneOf(['text', 'circle', 'rect', 'badge', 'avatar']),
  className: PropTypes.string,
  style: PropTypes.object
};

export default Skeleton;
