export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

import { logger as backendLogger } from '../utils/logger';

class Logger {
  private enabled: boolean = true;

  /**
   * Logs a debug message
   */
  debug(message: string, data?: any): void {
    if (!this.enabled) return;
    backendLogger.debug(`[Frontend] ${message}`, ...(data === undefined ? [] : [data]));
  }

  /**
   * Logs an info message
   */
  info(message: string, data?: any): void {
    if (!this.enabled) return;
    backendLogger.info(`[Frontend] ${message}`, ...(data === undefined ? [] : [data]));
  }

  /**
   * Logs a warning message
   */
  warn(message: string, data?: any): void {
    if (!this.enabled) return;
    backendLogger.warn(`[Frontend] ${message}`, ...(data === undefined ? [] : [data]));
  }

  /**
   * Logs an error message
   */
  error(message: string, data?: any): void {
    if (!this.enabled) return;
    backendLogger.error(`[Frontend] ${message}`, ...(data === undefined ? [] : [data]));
  }

  /**
   * Enables or disables logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const logger = new Logger();

