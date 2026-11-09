import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import 'bootstrap/dist/css/bootstrap.min.css'
import './index.css'
import './styles/utilities.css'
import './styles/theme-variables.css'
import './styles/layout.css'
import './styles/forum-index.css'
import './styles/forum-stats.css'
import './styles/forum-view.css'
import './styles/topic-row.css'
import './styles/forum-breadcrumbs.css'
import './styles/forum-pagination.css'
import './styles/topic-view.css'
import './styles/author-meta.css'
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
