export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private enabled: boolean = true;

  /**
   * Logs a debug message
   */
  debug(message: string, data?: any): void {
    console.debug(`[Frontend] ${message}`, data || '');
  }

  /**
   * Logs an info message
   */
  info(message: string, data?: any): void {
    console.info(`[Frontend] ${message}`, data || '');
  }

  /**
   * Logs a warning message
   */
  warn(message: string, data?: any): void {
    console.warn(`[Frontend] ${message}`, data || '');
  }

  /**
   * Logs an error message
   */
  error(message: string, data?: any): void {
    console.error(`[Frontend] ${message}`, data || '');
  }

  /**
   * Enables or disables logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const logger = new Logger();

