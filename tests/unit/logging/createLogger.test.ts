/**
 * Tests for Component Logger Factory
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLogger } from '../../../media/logging/createLogger';
import { LogLevel, setLogLevel } from '../../../media/logging/logLevel';
import { webviewLogBuffer } from '../../../media/logging/WebviewLogBuffer';

describe('createLogger', () => {
  beforeEach(() => {
    // Reset to WARN level (production default)
    setLogLevel(LogLevel.WARN);
    webviewLogBuffer.clear();
    vi.restoreAllMocks();
  });

  describe('prefix format', () => {
    it('creates logger with [Component] prefix', () => {
      setLogLevel(LogLevel.DEBUG);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log = createLogger('VirtualList');
      log.warn('test message');

      expect(warnSpy).toHaveBeenCalledWith('[VirtualList]', 'test message');

      warnSpy.mockRestore();
    });

    it('passes additional arguments', () => {
      setLogLevel(LogLevel.DEBUG);
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const log = createLogger('Pool');
      log.debug('stats:', { count: 5 }, 'extra');

      expect(debugSpy).toHaveBeenCalledWith('[Pool]', 'stats:', { count: 5 }, 'extra');

      debugSpy.mockRestore();
    });
  });

  describe('log level filtering', () => {
    it('filters debug when level is WARN', () => {
      setLogLevel(LogLevel.WARN);
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const log = createLogger('Test');
      log.debug('should not appear');

      expect(debugSpy).not.toHaveBeenCalled();

      debugSpy.mockRestore();
    });

    it('filters info when level is WARN', () => {
      setLogLevel(LogLevel.WARN);
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const log = createLogger('Test');
      log.info('should not appear');

      expect(infoSpy).not.toHaveBeenCalled();

      infoSpy.mockRestore();
    });

    it('allows warn when level is WARN', () => {
      setLogLevel(LogLevel.WARN);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log = createLogger('Test');
      log.warn('should appear');

      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('allows error when level is WARN', () => {
      setLogLevel(LogLevel.WARN);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const log = createLogger('Test');
      log.error('should appear');

      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('allows all levels when level is DEBUG', () => {
      setLogLevel(LogLevel.DEBUG);
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const log = createLogger('Test');
      log.debug('debug');
      log.info('info');
      log.warn('warn');
      log.error('error');

      expect(debugSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('console method usage', () => {
    beforeEach(() => {
      setLogLevel(LogLevel.DEBUG);
    });

    it('debug uses console.debug', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const log = createLogger('Test');
      log.debug('message');

      expect(debugSpy).toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it('info uses console.info', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const log = createLogger('Test');
      log.info('message');

      expect(infoSpy).toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it('warn uses console.warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log = createLogger('Test');
      log.warn('message');

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('error uses console.error', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const log = createLogger('Test');
      log.error('message');

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('multiple loggers share global level', () => {
    it('changing level affects all loggers', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const log1 = createLogger('Component1');
      const log2 = createLogger('Component2');

      // Initially WARN, debug should not log
      log1.debug('test');
      log2.debug('test');
      expect(debugSpy).not.toHaveBeenCalled();

      // Change to DEBUG, now both should log
      setLogLevel(LogLevel.DEBUG);
      log1.debug('test1');
      log2.debug('test2');

      expect(debugSpy).toHaveBeenCalledWith('[Component1]', 'test1');
      expect(debugSpy).toHaveBeenCalledWith('[Component2]', 'test2');

      debugSpy.mockRestore();
    });
  });

  describe('WebviewLogBuffer integration', () => {
    it('pushes log entries to the buffer', () => {
      setLogLevel(LogLevel.DEBUG);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log = createLogger('TestComponent');
      log.warn('buffer test');

      const entries = webviewLogBuffer.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].component).toBe('TestComponent');
      expect(entries[0].level).toBe('warn');
      expect(entries[0].message).toBe('buffer test');
    });

    it('does not push filtered entries to the buffer', () => {
      setLogLevel(LogLevel.WARN);
      vi.spyOn(console, 'debug').mockImplementation(() => {});

      const log = createLogger('TestComponent');
      log.debug('should not buffer');

      expect(webviewLogBuffer.getAll()).toHaveLength(0);
    });

    it('serializes non-string args to JSON', () => {
      setLogLevel(LogLevel.DEBUG);
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const log = createLogger('TestComponent');
      log.error('data:', { key: 'value' });

      const entries = webviewLogBuffer.getAll();
      expect(entries[0].message).toBe('data: {"key":"value"}');
    });

    it('multiple loggers push to same buffer', () => {
      setLogLevel(LogLevel.WARN);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const log1 = createLogger('Comp1');
      const log2 = createLogger('Comp2');

      log1.warn('from comp1');
      log2.warn('from comp2');

      const entries = webviewLogBuffer.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0].component).toBe('Comp1');
      expect(entries[1].component).toBe('Comp2');
    });
  });
});
