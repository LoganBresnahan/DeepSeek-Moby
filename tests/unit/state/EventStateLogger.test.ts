/**
 * Tests for EventStateLogger
 *
 * Note: EventStateLogger now uses the global log level from the logging module.
 * Tests reset the global level in beforeEach/afterEach for isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStateLogger, logger, LogLevel } from '../../../media/state/EventStateLogger';
import { setLogLevel } from '../../../media/logging';

describe('EventStateLogger', () => {
  let testLogger: EventStateLogger;

  beforeEach(() => {
    testLogger = new EventStateLogger();
    // Reset to WARN (production default) before each test
    setLogLevel(LogLevel.WARN);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Reset to WARN after each test for isolation
    setLogLevel(LogLevel.WARN);
  });

  describe('configuration', () => {
    it('has default configuration (WARN level)', () => {
      // Default is WARN level, so debug/info should not log
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.debug('test message');
      testLogger.info('test message');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();

      debugSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('allows warn at default WARN level', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      testLogger.warn('test message');

      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('configure updates settings including log level', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({ logLevel: LogLevel.DEBUG });
      testLogger.debug('test message');

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('setLogLevel changes global log level', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.setLogLevel(LogLevel.INFO);
      testLogger.info('test message');

      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('enableDebug / disableDebug', () => {
    it('enableDebug sets debug level and logs enabled message', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.enableDebug();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Debug logging enabled'));

      infoSpy.mockRestore();
    });

    it('disableDebug sets warn level and logs disabled message', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.enableDebug();
      testLogger.disableDebug();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Debug logging disabled'));

      infoSpy.mockRestore();
    });
  });

  describe('logging methods', () => {
    beforeEach(() => {
      testLogger.setLogLevel(LogLevel.DEBUG);
    });

    it('debug logs with debug icon using console.debug', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.debug('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('🔍'),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('info logs with info icon using console.info', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.info('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('ℹ️'),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('warn logs with warning icon using console.warn', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      testLogger.warn('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('⚠️'),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('error logs with error icon using console.error', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      testLogger.error('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('❌'),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('logs additional arguments', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.info('test', { data: 'value' }, 123);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        { data: 'value' },
        123
      );

      consoleSpy.mockRestore();
    });

    it('uses [EventState] prefix format', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.debug('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventState]'),
        'test message'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('timestamps', () => {
    it('shows relative timestamps when useWallClock is false', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        showTimestamps: true,
        useWallClock: false
      });

      testLogger.debug('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[\d+\.\d+ms\]/),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('shows wall clock timestamps when useWallClock is true', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        showTimestamps: true,
        useWallClock: true
      });

      testLogger.debug('test message');

      // Wall clock format: [HH:MM:SS.mmm]
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('hides timestamps when disabled', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        showTimestamps: false
      });

      testLogger.debug('test message');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.not.stringMatching(/\[\d+\.\d+ms\]/),
        'test message'
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.not.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/),
        'test message'
      );

      consoleSpy.mockRestore();
    });

    it('uses wall clock by default', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Create a fresh logger with default config
      const freshLogger = new EventStateLogger();
      freshLogger.setLogLevel(LogLevel.DEBUG);

      freshLogger.debug('test message');

      // Default should be wall clock format: [HH:MM:SS.mmm]
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/),
        'test message'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('configure and resetTimer', () => {
    it('configure does NOT reset startTime', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        showTimestamps: true,
        useWallClock: false
      });

      // Wait a bit to accumulate elapsed time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Configure again - should NOT reset the timer
      testLogger.configure({
        flatMode: true
      });

      testLogger.debug('test message');

      // Get the logged timestamp - should be >= 50ms, not reset to ~0
      const loggedPrefix = consoleSpy.mock.calls[0][0] as string;
      const match = loggedPrefix.match(/\[(\d+\.\d+)ms\]/);
      expect(match).toBeTruthy();

      const elapsedMs = parseFloat(match![1]);
      expect(elapsedMs).toBeGreaterThanOrEqual(40); // Allow some timing variance

      consoleSpy.mockRestore();
    });

    it('resetTimer explicitly resets startTime', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        showTimestamps: true,
        useWallClock: false
      });

      // Wait a bit to accumulate elapsed time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Explicitly reset the timer
      testLogger.resetTimer();

      testLogger.debug('test message');

      // Get the logged timestamp - should be close to 0 since we reset
      const loggedPrefix = consoleSpy.mock.calls[0][0] as string;
      const match = loggedPrefix.match(/\[(\d+\.\d+)ms\]/);
      expect(match).toBeTruthy();

      const elapsedMs = parseFloat(match![1]);
      expect(elapsedMs).toBeLessThan(20); // Should be near 0, with some tolerance

      consoleSpy.mockRestore();
    });
  });

  describe('specialized logging methods', () => {
    beforeEach(() => {
      testLogger.setLogLevel(LogLevel.DEBUG);
    });

    it('managerInit logs initialization', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      testLogger.managerInit();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('EventState'),
        'Manager initialized'
      );

      consoleSpy.mockRestore();
    });

    it('actorRegister logs actor registration with groups', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});
      const groupEndSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

      testLogger.actorRegister('test-actor', ['pub.key'], ['sub.key']);

      // console.group is called with (prefix, message) - check second arg contains actor ID
      expect(groupSpy).toHaveBeenCalled();
      const callArgs = groupSpy.mock.calls[0];
      expect(callArgs.some((arg: unknown) => typeof arg === 'string' && arg.includes('test-actor'))).toBe(true);
      expect(groupEndSpy).toHaveBeenCalled();

      groupSpy.mockRestore();
      groupEndSpy.mockRestore();
    });

    it('actorUnregister logs unregistration', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.actorUnregister('test-actor', 5);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('test-actor')
      );

      consoleSpy.mockRestore();
    });

    it('stateChangeFlow logs state changes with groups', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});
      const groupEndSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

      testLogger.stateChangeFlow('source-actor', ['key1', 'key2'], 2);

      expect(groupSpy).toHaveBeenCalled();
      expect(groupEndSpy).toHaveBeenCalled();

      groupSpy.mockRestore();
      groupEndSpy.mockRestore();
    });

    it('broadcastToActor logs broadcast info', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.broadcastToActor('target-actor', ['key1', 'key2']);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('target-actor')
      );

      consoleSpy.mockRestore();
    });

    it('circularDependency logs error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      testLogger.circularDependency(['actor-a', 'actor-b', 'actor-a']);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CIRCULAR DEPENDENCY')
      );

      errorSpy.mockRestore();
    });

    it('longChainWarning logs warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      testLogger.longChainWarning(15, ['a', 'b', 'c']);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('chain too long')
      );

      warnSpy.mockRestore();
    });

    it('subscriptionError logs error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('test error');

      testLogger.subscriptionError('test-actor', 'test.key', error);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-actor'),
        error
      );

      errorSpy.mockRestore();
    });

    it('publicationError logs error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('test error');

      testLogger.publicationError('test-actor', 'test.key', error);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-actor'),
        error
      );

      errorSpy.mockRestore();
    });

    it('unauthorizedPublication logs error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      testLogger.unauthorizedPublication('test-actor', ['key1', 'key2']);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('unauthorized')
      );

      errorSpy.mockRestore();
    });

    it('publishInsideGetter logs error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      testLogger.publishInsideGetter('test-actor');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('cannot publish from inside a publication getter')
      );

      errorSpy.mockRestore();
    });
  });

  describe('showState', () => {
    it('shows state table when debug and logGlobalState enabled', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
      const groupEndSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        logGlobalState: true
      });

      testLogger.showState({ key: 'value' });

      expect(groupSpy).toHaveBeenCalled();
      expect(tableSpy).toHaveBeenCalledWith({ key: 'value' });
      expect(groupEndSpy).toHaveBeenCalled();

      groupSpy.mockRestore();
      tableSpy.mockRestore();
      groupEndSpy.mockRestore();
    });

    it('does not show state when logGlobalState disabled', () => {
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        logGlobalState: false
      });

      testLogger.showState({ key: 'value' });

      expect(tableSpy).not.toHaveBeenCalled();

      tableSpy.mockRestore();
    });

    it('does not show state when log level too high', () => {
      const tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.ERROR,
        logGlobalState: true
      });

      testLogger.showState({ key: 'value' });

      expect(tableSpy).not.toHaveBeenCalled();

      tableSpy.mockRestore();
    });

    it('accepts custom label', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});
      vi.spyOn(console, 'table').mockImplementation(() => {});
      vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        logGlobalState: true
      });

      testLogger.showState({ key: 'value' }, 'Custom Label');

      expect(groupSpy).toHaveBeenCalledWith(
        expect.stringContaining('Custom Label')
      );

      groupSpy.mockRestore();
    });
  });

  describe('flat mode', () => {
    it('skips console groups in flat mode', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        flatMode: true
      });

      testLogger.actorRegister('test-actor', ['pub'], ['sub']);

      expect(groupSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      groupSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('useGroups option', () => {
    it('skips groups when useGroups is false', () => {
      const groupSpy = vi.spyOn(console, 'group').mockImplementation(() => {});

      testLogger.configure({
        logLevel: LogLevel.DEBUG,
        useGroups: false
      });

      testLogger.actorRegister('test-actor', ['pub'], ['sub']);

      expect(groupSpy).not.toHaveBeenCalled();

      groupSpy.mockRestore();
    });
  });

  describe('singleton logger', () => {
    it('exports singleton instance', () => {
      expect(logger).toBeInstanceOf(EventStateLogger);
    });
  });

  describe('global level integration', () => {
    it('setLogLevel affects global level', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Create two loggers
      const logger1 = new EventStateLogger();
      const logger2 = new EventStateLogger();

      // Set level on first logger
      logger1.setLogLevel(LogLevel.DEBUG);

      // Second logger should also log debug (global level changed)
      logger2.debug('from logger2');

      expect(debugSpy).toHaveBeenCalled();

      debugSpy.mockRestore();
    });
  });
});
