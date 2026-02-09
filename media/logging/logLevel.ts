/**
 * Global Log Level Control
 *
 * Provides centralized log level management for the webview.
 * All logging systems (createLogger, EventStateLogger) use this.
 *
 * Production default: WARN (only warnings and errors)
 * Development: Can be set to DEBUG for verbose output
 */

/**
 * Log levels (matches EventState LogLevel for consistency)
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

/**
 * Global log level - WARN by default for production
 * Only warnings and errors show unless explicitly changed
 */
let globalLogLevel: LogLevel = LogLevel.WARN;

/**
 * Set the global log level.
 * Affects all loggers created with createLogger and EventStateLogger.
 *
 * @param level - The log level to set
 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
  // Use console.info so it's stripped in production but visible in dev
  console.info(`[Logging] Level set to ${LogLevel[level]}`);
}

/**
 * Get the current global log level.
 */
export function getLogLevel(): LogLevel {
  return globalLogLevel;
}

/**
 * Check if a message at the given level should be logged.
 * Used by all logging systems for consistent filtering.
 *
 * @param level - The level of the message to check
 * @returns true if the message should be logged
 */
export function shouldLog(level: LogLevel): boolean {
  return level >= globalLogLevel;
}

/**
 * Enable debug mode - sets level to DEBUG and logs confirmation.
 */
export function enableDebugMode(): void {
  setLogLevel(LogLevel.DEBUG);
}

/**
 * Disable debug mode - sets level back to WARN (production default).
 */
export function disableDebugMode(): void {
  setLogLevel(LogLevel.WARN);
}
