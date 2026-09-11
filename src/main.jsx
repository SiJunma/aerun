import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'bootstrap/dist/css/bootstrap.min.css'
import './index.css'
import './styles/utilities.css'
import App from './App.jsx'
import { AuthProvider } from './contexts/AuthProvider'
import { I18nProvider } from './contexts/I18nProvider'
import { ThemeProvider } from './contexts/ThemeProvider'
import { ToastProvider } from './contexts/ToastProvider'
import { DesignProvider } from './contexts/DesignProvider'
import { TitleProvider } from './contexts/TitleProvider'

// Handle chunk load errors after new deploys (stale assets on open tabs)
window.addEventListener('vite:preloadError', (event) => {
  console.warn('New version detected or asset failed to load. Reloading page...', event);
  window.location.reload();
});

if (typeof __APP_BUILD_TIME__ !== 'undefined') {
  console.info(`[Aerun] Build time: ${__APP_BUILD_TIME__}`);
}

// Prevent harmless but noisy Firebase WebChannel internal errors from spamming the console
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const filterFirebaseWarnings = (args, originalFn) => {
  if (typeof args[0] === 'string' && args[0].includes('BloomFilter error')) return;
  originalFn(...args);
};
console.error = (...args) => filterFirebaseWarnings(args, originalConsoleError);
console.warn = (...args) => filterFirebaseWarnings(args, originalConsoleWarn);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <I18nProvider>
          <ThemeProvider>
            <DesignProvider>
              <TitleProvider>
                <ToastProvider>
                  <App />
                </ToastProvider>
              </TitleProvider>
            </DesignProvider>
          </ThemeProvider>
        </I18nProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
