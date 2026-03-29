import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fortawesome/fontawesome-free/css/all.min.css'
import { App } from './components/App'
import { logger } from './services/logger'
import { interceptConsole } from './utils/logger'
import { applyBuiltInTheme, readCachedThemeSelection } from './utils/theme'
import './style.css'

interceptConsole();
applyBuiltInTheme(readCachedThemeSelection());

// Error boundary for catching render errors
window.addEventListener('error', (event) => {
  logger.error('Global window error', {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error,
  });
  event.preventDefault(); // Prevent default error handling
});

window.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled promise rejection', {
    reason: event.reason,
  });
  event.preventDefault(); // Prevent default error handling
});

const rootElement = document.getElementById('app');
if (!rootElement) {
  logger.error('Root element #app not found during bootstrap');
  throw new Error('Root element #app not found');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} catch (error) {
  logger.error('React root render failed', error);
  throw error;
}

