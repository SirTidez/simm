import { invoke } from '@tauri-apps/api/core';

// Keep reference to original console methods before interception
const originalConsole = {

  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let consoleIntercepted = false;

/**
 * Safely stringify an object, handling circular references
 */
function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return String(obj);
  }
}

/**
 * Send log to backend without using console (to avoid infinite loops)
 * Fire-and-forget - don't wait for the backend response
 */
function sendToBackend(level: string, message: string, data?: any) {
  // Fire and forget - don't await, don't block
  invoke('log_frontend_message', {
    level,
    message,
    data: data ? safeStringify(data) : null,
  }).catch(() => {
    // Silently fail - logging should never block the app
  });
}

/**
 * Frontend logger that sends logs to both the browser console and the backend log file
 */
class Logger {
  /**
   * Log an info message
   */
  info(message: string, ...args: any[]) {
    originalConsole.info(message, ...args);
    const data = args.length > 0 ? args : undefined;
    sendToBackend('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, ...args: any[]) {
    originalConsole.warn(message, ...args);
    const data = args.length > 0 ? args : undefined;
    sendToBackend('warn', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, ...args: any[]) {
    originalConsole.error(message, ...args);
    const data = args.length > 0 ? args : undefined;
    sendToBackend('error', message, data);
  }

  /**
   * Log a debug message
   */
  debug(message: string, ...args: any[]) {
    originalConsole.debug(message, ...args);
    const data = args.length > 0 ? args : undefined;
    sendToBackend('debug', message, data);
  }
}

// Export singleton instance
export const logger = new Logger();

/**
 * Override global console methods to automatically capture all console output
 * Call this in your app initialization
 */
export function interceptConsole() {
  if (consoleIntercepted) {
    return;
  }

  consoleIntercepted = true;
  console.log = (...args: any[]) => {
    originalConsole.log(...args);
    const message = args.map(arg =>
      typeof arg === 'object' ? safeStringify(arg) : String(arg)
    ).join(' ');
    sendToBackend('info', message);
  };

  console.info = (...args: any[]) => {
    originalConsole.info(...args);
    const message = args.map(arg =>
      typeof arg === 'object' ? safeStringify(arg) : String(arg)
    ).join(' ');
    sendToBackend('info', message);
  };

  console.warn = (...args: any[]) => {
    originalConsole.warn(...args);
    const message = args.map(arg =>
      typeof arg === 'object' ? safeStringify(arg) : String(arg)
    ).join(' ');
    sendToBackend('warn', message);
  };

  console.error = (...args: any[]) => {
    originalConsole.error(...args);
    const message = args.map(arg =>
      typeof arg === 'object' ? safeStringify(arg) : String(arg)
    ).join(' ');
    sendToBackend('error', message);
  };

  console.debug = (...args: any[]) => {
    originalConsole.debug(...args);
    const message = args.map(arg =>
      typeof arg === 'object' ? safeStringify(arg) : String(arg)
    ).join(' ');
    sendToBackend('debug', message);
  };

  originalConsole.info('[Logger] Console interception enabled - all console output will be logged to file');
}


