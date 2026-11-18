/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useCallback } from 'react';
import { Toast, ToastContainer } from 'react-bootstrap';
import { CheckCircle, AlertTriangle, Info, XCircle } from 'lucide-react';

const ToastContext = createContext();

export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  // variant: 'success' | 'danger' | 'warning' | 'info'
  const showToast = useCallback((message, variant = 'success', duration = 4000) => {
    const id = Date.now() + Math.random().toString(36).substring(2);
    setToasts(prev => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const getIcon = (variant) => {
    switch(variant) {
      case 'success': return <CheckCircle size={18} />;
      case 'danger': return <XCircle size={18} />;
      case 'warning': return <AlertTriangle size={18} />;
      default: return <Info size={18} />;
    }
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      
      <ToastContainer position="bottom-end" className="p-3" style={{ position: 'fixed', zIndex: 9999 }}>
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            autohide
            delay={toast.duration}
            onClose={() => removeToast(toast.id)}
            className={`global-toast border-0 shadow-lg mb-2`}
            style={{
              backgroundColor: 'var(--card-bg)',
              color: 'var(--text-color)',
              borderLeft: `4px solid var(--bs-${toast.variant})`
            }}
          >
            {/* THE MESSAGE LIVES IN THE HEADER, NOT IN A BODY.

                It used to sit in an empty <Toast.Body> while the header held an
                empty <strong> — so every toast rendered the icon on row one and
                the text on row two, with the close button floating above both.
                The comment in the old header said as much ("just leave it empty"),
                so this was not a regression from the members refresh; that button
                is simply where it became visible.

                Icon and text share one line now: `flex-shrink-0` keeps the icon
                whole when a message is long enough to wrap, and `me-auto` on the
                text pushes the close button to the far edge as before. */}
            <Toast.Header
              closeButton
              className="border-bottom-0 bg-transparent py-2 px-3 d-flex align-items-center"
              style={{ color: 'var(--text-color)' }}
            >
              <div
                className={`text-${toast.variant} me-2 d-flex align-items-center flex-shrink-0`}
              >
                {getIcon(toast.variant)}
              </div>
              <strong
                className="me-auto fw-bold"
                style={{ color: 'var(--text-color)', fontSize: '0.9rem', lineHeight: 1.35 }}
              >
                {toast.message}
              </strong>
            </Toast.Header>
          </Toast>
        ))}
      </ToastContainer>
    </ToastContext.Provider>
  );
};
