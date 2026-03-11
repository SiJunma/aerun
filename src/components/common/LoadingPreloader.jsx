import React from 'react';

const LoadingPreloader = () => {
  return (
    <div className="preloader-overlay">
      <div className="preloader-logo">Aerun</div>
      <div className="preloader-spinner"></div>
      <div className="preloader-text">Initializing Forum</div>
    </div>
  );
};

export default LoadingPreloader;
