import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fortawesome/fontawesome-free/css/all.min.css'
import { App } from './components/App'
import { interceptConsole } from './utils/logger'
import { applyBuiltInTheme, readCachedThemeSelection } from './utils/theme'
import './style.css'

interceptConsole();
applyBuiltInTheme(readCachedThemeSelection());

// Error boundary for catching render errors
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  event.preventDefault(); // Prevent default error handling
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  event.preventDefault(); // Prevent default error handling
});

const rootElement = document.getElementById('app');
if (!rootElement) {
  throw new Error('Root element #app not found');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
} catch (error) {
  throw error;
}

