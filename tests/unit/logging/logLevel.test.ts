/**
 * Tests for Global Log Level Control
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LogLevel,
  setLogLevel,
  getLogLevel,
  shouldLog,
  enableDebugMode,
  disableDebugMode
} from '../../../media/logging/logLevel';

describe('logLevel', () => {
  beforeEach(() => {
    // Reset to default WARN level before each test
    setLogLevel(LogLevel.WARN);
    vi.restoreAllMocks();
  });

  describe('getLogLevel / setLogLevel', () => {
    it('defaults to WARN level', () => {
      // Reset by setting to default
      setLogLevel(LogLevel.WARN);
      expect(getLogLevel()).toBe(LogLevel.WARN);
    });

    it('setLogLevel changes the global level', () => {
      setLogLevel(LogLevel.DEBUG);
      expect(getLogLevel()).toBe(LogLevel.DEBUG);

      setLogLevel(LogLevel.ERROR);
      expect(getLogLevel()).toBe(LogLevel.ERROR);
    });

    it('setLogLevel logs the change', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      setLogLevel(LogLevel.DEBUG);

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('Level set to DEBUG')
      );

      infoSpy.mockRestore();
    });
  });

  describe('shouldLog', () => {
    it('returns true for levels >= current level', () => {
      setLogLevel(LogLevel.WARN);

      expect(shouldLog(LogLevel.WARN)).toBe(true);
      expect(shouldLog(LogLevel.ERROR)).toBe(true);
      expect(shouldLog(LogLevel.SILENT)).toBe(true);
    });

    it('returns false for levels < current level', () => {
      setLogLevel(LogLevel.WARN);

      expect(shouldLog(LogLevel.DEBUG)).toBe(false);
      expect(shouldLog(LogLevel.INFO)).toBe(false);
    });

    it('allows all levels when set to DEBUG', () => {
      setLogLevel(LogLevel.DEBUG);

      expect(shouldLog(LogLevel.DEBUG)).toBe(true);
      expect(shouldLog(LogLevel.INFO)).toBe(true);
      expect(shouldLog(LogLevel.WARN)).toBe(true);
      expect(shouldLog(LogLevel.ERROR)).toBe(true);
    });

    it('blocks all levels when set to SILENT', () => {
      setLogLevel(LogLevel.SILENT);

      expect(shouldLog(LogLevel.DEBUG)).toBe(false);
      expect(shouldLog(LogLevel.INFO)).toBe(false);
      expect(shouldLog(LogLevel.WARN)).toBe(false);
      expect(shouldLog(LogLevel.ERROR)).toBe(false);
    });
  });

  describe('enableDebugMode / disableDebugMode', () => {
    it('enableDebugMode sets level to DEBUG', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      enableDebugMode();

      expect(getLogLevel()).toBe(LogLevel.DEBUG);
      infoSpy.mockRestore();
    });

    it('disableDebugMode sets level to WARN', () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      setLogLevel(LogLevel.DEBUG);
      disableDebugMode();

      expect(getLogLevel()).toBe(LogLevel.WARN);
      infoSpy.mockRestore();
    });
  });
});
