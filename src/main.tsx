import React from 'react'
import ReactDOM from 'react-dom/client'
import { config } from '@fortawesome/fontawesome-svg-core'
import { App } from './components/App'
import { logger } from './services/logger'
import { interceptConsole } from './utils/logger'
import {
  applyBuiltInTheme,
  isBuiltInTheme,
  readCachedThemeBaseSelection,
  readCachedThemeSelection,
} from './utils/theme'
import '@fortawesome/fontawesome-svg-core/styles.css'
import './style.css'

declare global {
  interface Window {
    __SIMM_BOOT_TIMINGS__?: {
      appElementReadyAt?: number;
      bootFrameAt?: number;
      inlineScriptAt?: number;
      mainModuleAt?: number;
      reactRenderQueuedAt?: number;
      reactFrameAt?: number;
    };
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const bootTimings = window.__SIMM_BOOT_TIMINGS__ ?? {};
bootTimings.mainModuleAt = now();
window.__SIMM_BOOT_TIMINGS__ = bootTimings;

config.autoAddCss = false;
interceptConsole();
const cachedThemeSelection = readCachedThemeSelection();
applyBuiltInTheme(
  isBuiltInTheme(cachedThemeSelection)
    ? cachedThemeSelection
    : readCachedThemeBaseSelection(),
);

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
  logger.debug('[Startup] Frontend module ready', {
    appElementToMainMs: bootTimings.appElementReadyAt !== undefined
      ? Math.round(bootTimings.mainModuleAt - bootTimings.appElementReadyAt)
      : null,
    inlineToMainMs: bootTimings.inlineScriptAt !== undefined
      ? Math.round(bootTimings.mainModuleAt - bootTimings.inlineScriptAt)
      : null,
    bootFrameBeforeMain: bootTimings.bootFrameAt !== undefined,
  });

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
  bootTimings.reactRenderQueuedAt = now();
  window.requestAnimationFrame?.(() => {
    bootTimings.reactFrameAt = now();
    logger.debug('[Startup] Frontend first frame after React render', {
      appElementToReactFrameMs: bootTimings.appElementReadyAt !== undefined
        ? Math.round(bootTimings.reactFrameAt! - bootTimings.appElementReadyAt)
        : null,
      mainToReactFrameMs: bootTimings.mainModuleAt !== undefined
        ? Math.round(bootTimings.reactFrameAt! - bootTimings.mainModuleAt)
        : null,
      bootFrameAtMs: bootTimings.bootFrameAt !== undefined
        ? Math.round(bootTimings.bootFrameAt)
        : null,
    });
  });
} catch (error) {
  logger.error('React root render failed', error);
  throw error;
}

