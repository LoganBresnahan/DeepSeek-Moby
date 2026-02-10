/**
 * Component Logger Factory
 *
 * Creates loggers with consistent [ComponentName] prefix format.
 * All loggers respect the global log level set via setLogLevel().
 *
 * Usage:
 *   const log = createLogger('VirtualList');
 *   log.debug('Binding actor:', turnId);
 *   log.warn('Pool exhaustion detected');
 *   log.error('Failed to create actor:', error);
 *
 * In production builds, console.debug/log/info are stripped by esbuild.
 * The shouldLog() check provides runtime filtering for development.
 */

import { LogLevel, shouldLog } from './logLevel';
import { webviewLogBuffer } from './WebviewLogBuffer';
import type { WebviewLogEntry } from './WebviewLogBuffer';

/**
 * Logger interface returned by createLogger
 */
export interface ComponentLogger {
  /** Debug level - verbose development info (stripped in production) */
  debug: (...args: unknown[]) => void;
  /** Info level - notable events (stripped in production) */
  info: (...args: unknown[]) => void;
  /** Warn level - issues that should surface (kept in production) */
  warn: (...args: unknown[]) => void;
  /** Error level - errors requiring attention (kept in production) */
  error: (...args: unknown[]) => void;
}

/**
 * Create a logger for a component with consistent prefix formatting.
 *
 * @param component - Component name (e.g., 'VirtualList', 'Pool', 'Gateway')
 * @returns Logger object with debug/info/warn/error methods
 *
 * @example
 * ```typescript
 * const log = createLogger('VirtualList');
 * log.debug('Binding actor to turn:', turnId);
 * log.warn('Actor not bound - content will render on scroll');
 * log.error('Failed to create actor:', error);
 * ```
 */
export function createLogger(component: string): ComponentLogger {
  const prefix = `[${component}]`;

  function pushToBuffer(level: WebviewLogEntry['level'], args: unknown[]): void {
    webviewLogBuffer.push({
      timestamp: new Date().toISOString(),
      level,
      component,
      message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    });
  }

  return {
    debug: (...args: unknown[]) => {
      if (shouldLog(LogLevel.DEBUG)) {
        console.debug(prefix, ...args);
        pushToBuffer('debug', args);
      }
    },

    info: (...args: unknown[]) => {
      if (shouldLog(LogLevel.INFO)) {
        console.info(prefix, ...args);
        pushToBuffer('info', args);
      }
    },

    warn: (...args: unknown[]) => {
      if (shouldLog(LogLevel.WARN)) {
        console.warn(prefix, ...args);
        pushToBuffer('warn', args);
      }
    },

    error: (...args: unknown[]) => {
      if (shouldLog(LogLevel.ERROR)) {
        console.error(prefix, ...args);
        pushToBuffer('error', args);
      }
    }
  };
}
