import React, { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from 'react-bootstrap';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import './ScrollButtons.css';

const ScrollButtons = () => {
  const [showUp, setShowUp] = useState(false);
  const [showDown, setShowDown] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const windowHeight = window.innerHeight;
      const documentHeight = Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.clientHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
      );
      const scrollTop = window.scrollY || document.documentElement.scrollTop;

      const distanceToBottom = documentHeight - (scrollTop + windowHeight);

      // Don't show buttons if the page is shorter than 1.5 screens
      if (documentHeight <= windowHeight * 1.5) {
        setShowUp(false);
        setShowDown(false);
        return;
      }

      // Show UP arrow if scrolled down more than half a screen
      if (scrollTop > windowHeight / 2) {
        setShowUp(true);
      } else {
        setShowUp(false);
      }

      // Show DOWN arrow if distance to bottom is more than half a screen
      if (distanceToBottom > windowHeight / 2) {
        setShowDown(true);
      } else {
        setShowDown(false);
      }
    };

    // Run on initial mount
    handleScroll();

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll, { passive: true });

    // In case the document height changes dynamically (e.g., lazy loading images, new data),
    // MutationObserver or ResizeObserver on document.body can also help.
    const observer = new ResizeObserver(() => {
      handleScroll();
    });
    observer.observe(document.body);

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      observer.disconnect();
    };
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="scroll-buttons-container">
      <AnimatePresence>
        {showUp && (
          <Motion.div
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            transition={{ duration: 0.2 }}
          >
            <button
              type="button"
              className="scroll-edge-btn rounded-circle d-flex align-items-center justify-content-center p-0"
              onClick={scrollToTop}
              title="Scroll to top"
            >
              <ArrowUp size={18} />
            </button>
          </Motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showDown && (
          <Motion.div
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.9 }}
            transition={{ duration: 0.2 }}
          >
            <button
              type="button"
              className="scroll-edge-btn rounded-circle d-flex align-items-center justify-content-center p-0"
              onClick={scrollToBottom}
              title="Scroll to bottom"
            >
              <ArrowDown size={18} />
            </button>
          </Motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default ScrollButtons;
