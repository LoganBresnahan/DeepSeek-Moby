/**
 * Webview Logging Module
 *
 * Provides unified logging for the webview with:
 * - Global log level control (setLogLevel)
 * - Component logger factory (createLogger)
 * - Consistent [Component] prefix format
 *
 * Production default: LogLevel.WARN
 * - Only warnings and errors are logged
 * - console.debug/log/info are stripped by esbuild
 *
 * Development:
 * - Call enableDebugMode() or setLogLevel(LogLevel.DEBUG) for verbose output
 * - All log levels are available
 *
 * @example
 * ```typescript
 * import { createLogger, setLogLevel, LogLevel } from './logging';
 *
 * // Set global level (affects all loggers)
 * setLogLevel(LogLevel.DEBUG);
 *
 * // Create component logger
 * const log = createLogger('MyComponent');
 * log.debug('Verbose info');
 * log.warn('Something unusual');
 * log.error('Something failed:', error);
 * ```
 */

// Log level control
export {
  LogLevel,
  setLogLevel,
  getLogLevel,
  shouldLog,
  enableDebugMode,
  disableDebugMode
} from './logLevel';

// Component logger factory
export { createLogger, type ComponentLogger } from './createLogger';
