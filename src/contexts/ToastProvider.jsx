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
            <Toast.Header 
              closeButton 
              className="border-bottom-0 bg-transparent py-2 px-3"
            >
              <div 
                className={`text-${toast.variant} me-2 d-flex align-items-center`}
              >
                {getIcon(toast.variant)}
              </div>
              <strong className="me-auto text-body fw-bold" style={{ fontSize: '0.9rem' }}>
                {/* We don't necessarily need a title, but can provide one based on variant, or just leave it empty. Let's just put the message itself inside the body. */}
              </strong>
            </Toast.Header>
            <Toast.Body className="pt-0 pb-3 px-3 fw-medium" style={{ fontSize: '0.95rem' }}>
              {toast.message}
            </Toast.Body>
          </Toast>
        ))}
      </ToastContainer>
    </ToastContext.Provider>
  );
};
