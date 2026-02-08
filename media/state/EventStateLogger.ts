/**
 * EventStateLogger
 *
 * Centralized logging system for the Event State Management system.
 * Provides log level control with optional runtime debugging.
 */

import { LogLevel, type LoggerConfig } from './types';

export class EventStateLogger {
  private config: LoggerConfig = {
    logLevel: LogLevel.ERROR,
    showTimestamps: true,      // Changed: enabled by default for debugging
    useWallClock: true,        // New: wall clock for cross-boundary correlation
    useGroups: true,
    flatMode: false,
    logGlobalState: false
  };

  private startTime: number = performance.now();
  private componentName = 'EventState';

  /**
   * Configure the logger.
   * Note: Does NOT reset startTime - use resetTimer() for that.
   */
  configure(options: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...options };
    // Intentionally NOT resetting startTime here - that was a bug
  }

  /**
   * Reset the elapsed timer to zero.
   * Call this explicitly if you need to restart relative timing.
   */
  resetTimer(): void {
    this.startTime = performance.now();
  }

  /**
   * Set log level
   */
  setLogLevel(level: LogLevel): void {
    this.config.logLevel = level;
  }

  /**
   * Enable debug mode
   */
  enableDebug(): void {
    this.config.logLevel = LogLevel.DEBUG;
    this.config.logGlobalState = true;
    console.log('🔍 EventState: Debug logging enabled');
  }

  /**
   * Disable debug mode
   */
  disableDebug(): void {
    this.config.logLevel = LogLevel.ERROR;
    this.config.logGlobalState = false;
    console.log('🔇 EventState: Debug logging disabled');
  }

  /**
   * Check if a message at given level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return level >= this.config.logLevel;
  }

  /**
   * Get formatted timestamp.
   * Wall clock format: [HH:MM:SS.mmm] - correlates with extension logs
   * Relative format: [1234.5ms] - useful for performance profiling
   */
  private getTimestamp(): string {
    if (!this.config.showTimestamps) return '';

    if (this.config.useWallClock) {
      const now = new Date();
      const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
      return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}] `;
    }

    const elapsed = performance.now() - this.startTime;
    return `[${elapsed.toFixed(1)}ms] `;
  }

  /**
   * Internal log method.
   * Uses appropriate console methods for proper devtools filtering.
   */
  private log(level: LogLevel, icon: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const timestamp = this.getTimestamp();
    const prefix = `${timestamp}${icon} ${this.componentName}:`;

    // Use appropriate console method for devtools filtering
    const logArgs = args.length > 0 ? [prefix, message, ...args] : [prefix, message];

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(...logArgs);
        break;
      case LogLevel.INFO:
        console.info(...logArgs);
        break;
      case LogLevel.WARN:
        console.warn(...logArgs);
        break;
      case LogLevel.ERROR:
        console.error(...logArgs);
        break;
      default:
        console.log(...logArgs);
    }
  }

  /**
   * Start a console group
   */
  private startGroup(level: LogLevel, icon: string, message: string, style?: string): void {
    if (!this.shouldLog(level)) return;
    if (this.config.flatMode) {
      this.log(level, icon, message);
      return;
    }
    if (!this.config.useGroups) return;

    const timestamp = this.getTimestamp();
    const prefix = `${timestamp}${icon} ${this.componentName}:`;

    if (style) {
      console.group(`%c${prefix} ${message}`, style);
    } else {
      console.group(prefix, message);
    }
  }

  /**
   * End a console group
   */
  private endGroup(level: LogLevel): void {
    if (!this.shouldLog(level)) return;
    if (this.config.flatMode) return;
    if (!this.config.useGroups) return;
    console.groupEnd();
  }

  // Public logging methods

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, '🔍', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, 'ℹ️', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, '⚠️', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, '❌', message, ...args);
  }

  // Specialized logging methods for Event State system

  /**
   * Log manager initialization
   */
  managerInit(): void {
    this.info('Manager initialized');
  }

  /**
   * Log actor registration
   */
  actorRegister(
    actorId: string,
    publicationKeys: readonly string[],
    subscriptionKeys: readonly string[]
  ): void {
    this.startGroup(LogLevel.DEBUG, '📝', `Actor [${actorId}] registered`);
    this.debug(`Publications: [${publicationKeys.join(', ')}]`);
    this.debug(`Subscriptions: [${subscriptionKeys.join(', ')}]`);
    this.endGroup(LogLevel.DEBUG);
  }

  /**
   * Log actor unregistration
   */
  actorUnregister(actorId: string, remainingActors: number): void {
    this.debug(`Actor [${actorId}] unregistered. Remaining: ${remainingActors}`);
  }

  /**
   * Log state change flow
   */
  stateChangeFlow(source: string, changedKeys: string[], chainDepth: number): void {
    this.startGroup(
      LogLevel.DEBUG,
      '🔄',
      `State change from [${source}]`,
      'color: #F57C00; font-weight: bold;'
    );
    this.debug(`Changed keys: [${changedKeys.join(', ')}]`);
    if (chainDepth > 0) {
      this.debug(`Chain depth: ${chainDepth}`);
    }
    this.endGroup(LogLevel.DEBUG);
  }

  /**
   * Log broadcast to actor
   */
  broadcastToActor(actorId: string, keys: string[]): void {
    this.debug(`→ [${actorId}]: [${keys.join(', ')}]`);
  }

  /**
   * Log circular dependency detection
   */
  circularDependency(chain: string[]): void {
    console.error(
      `🔴 ${this.componentName}: CIRCULAR DEPENDENCY DETECTED!\n` +
      `   Chain: ${chain.join(' → ')}\n` +
      `   Dropping state to prevent infinite loop`
    );
  }

  /**
   * Log long chain warning
   */
  longChainWarning(depth: number, chain: string[]): void {
    console.warn(
      `⚠️ ${this.componentName}: Publication chain too long (depth ${depth})\n` +
      `   Chain: ${chain.join(' → ')}\n` +
      `   Consider refactoring to reduce cascading updates`
    );
  }

  /**
   * Log subscription handler error
   */
  subscriptionError(actorId: string, key: string, error: unknown): void {
    console.error(`❌ ${this.componentName}: Actor [${actorId}] error in subscription "${key}":`, error);
  }

  /**
   * Log publication getter error
   */
  publicationError(actorId: string, key: string, error: unknown): void {
    console.error(`❌ ${this.componentName}: Actor [${actorId}] error reading "${key}":`, error);
  }

  /**
   * Log unauthorized publication attempt
   */
  unauthorizedPublication(actorId: string, keys: string[]): void {
    console.error(
      `❌ ${this.componentName}: Actor [${actorId}] attempted to publish unauthorized keys:\n` +
      `   Keys: [${keys.join(', ')}]`
    );
  }

  /**
   * Log publication from inside getter (not allowed)
   */
  publishInsideGetter(actorId: string): void {
    console.error(
      `🔴 ${this.componentName}: Actor [${actorId}] cannot publish from inside a publication getter!\n` +
      `   Publication getters should be PURE FUNCTIONS that only read state.`
    );
  }

  /**
   * Show state table (for debugging)
   */
  showState(state: Record<string, unknown>, label = 'Global State'): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;
    if (!this.config.logGlobalState) return;

    console.group(`📊 ${this.componentName}: ${label}`);
    console.table(state);
    console.groupEnd();
  }
}

// Singleton instance for shared logging
export const logger = new EventStateLogger();
