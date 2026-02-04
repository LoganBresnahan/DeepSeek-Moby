/**
 * Tests for Extension Logger
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mockOutputChannel, mockConfiguration, resetAllMocks } from '../../__mocks__/vscode';

// Import logger - vscode is aliased to our mock in vitest.config.ts
import { logger, type LogLevel } from '../../../src/utils/logger';

describe('Logger', () => {
  beforeEach(() => {
    resetAllMocks();
    mockConfiguration.get.mockReturnValue('INFO');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('log level filtering', () => {
    it('DEBUG logs when level is DEBUG', () => {
      logger.minLevel = 'DEBUG';
      logger.debug('test message');
      expect(mockOutputChannel.debug).toHaveBeenCalled();
    });

    it('DEBUG does not log when level is INFO', () => {
      logger.minLevel = 'INFO';
      logger.debug('test message');
      expect(mockOutputChannel.debug).not.toHaveBeenCalled();
    });

    it('INFO logs when level is INFO', () => {
      logger.minLevel = 'INFO';
      logger.info('test message');
      expect(mockOutputChannel.info).toHaveBeenCalled();
    });

    it('INFO logs when level is DEBUG', () => {
      logger.minLevel = 'DEBUG';
      logger.info('test message');
      expect(mockOutputChannel.info).toHaveBeenCalled();
    });

    it('WARN logs when level is WARN', () => {
      logger.minLevel = 'WARN';
      logger.warn('test message');
      expect(mockOutputChannel.warn).toHaveBeenCalled();
    });

    it('WARN does not log when level is ERROR', () => {
      logger.minLevel = 'ERROR';
      logger.warn('test message');
      expect(mockOutputChannel.warn).not.toHaveBeenCalled();
    });

    it('ERROR logs when level is ERROR', () => {
      logger.minLevel = 'ERROR';
      logger.error('test message');
      expect(mockOutputChannel.error).toHaveBeenCalled();
    });

    it('OFF disables all logging', () => {
      logger.minLevel = 'OFF';
      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      logger.error('test');

      expect(mockOutputChannel.debug).not.toHaveBeenCalled();
      expect(mockOutputChannel.info).not.toHaveBeenCalled();
      expect(mockOutputChannel.warn).not.toHaveBeenCalled();
      expect(mockOutputChannel.error).not.toHaveBeenCalled();
    });
  });

  describe('formatting', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('includes timestamp in log message', () => {
      logger.info('test message');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      // Timestamp format: HH:MM:SS
      expect(logLine).toMatch(/\d{2}:\d{2}:\d{2}/);
    });

    it('includes level indicator in log message', () => {
      logger.info('test message');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('INFO');
    });

    it('includes message content', () => {
      logger.info('test message');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('test message');
    });

    it('handles details parameter', () => {
      logger.info('main message', 'additional details');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('main message');
      expect(logLine).toContain('additional details');
    });
  });

  describe('session methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('sessionStart logs with session ID and title', () => {
      logger.sessionStart('sess-123', 'My Chat');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Session started');
      expect(logLine).toContain('sess-123');
      expect(logLine).toContain('My Chat');
    });

    it('sessionSwitch logs session ID', () => {
      logger.sessionSwitch('sess-456');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Session switched');
      expect(logLine).toContain('sess-456');
    });

    it('sessionClear logs session cleared', () => {
      logger.sessionClear();
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Session cleared');
    });
  });

  describe('API methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('apiRequest logs model and message count', () => {
      logger.apiRequest('deepseek-chat', 5);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Request');
      expect(logLine).toContain('5 messages');
      expect(logLine).toContain('deepseek-chat');
    });

    it('apiRequest indicates images when present', () => {
      logger.apiRequest('deepseek-chat', 3, true);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('with images');
    });

    it('apiRequest does not mention images when absent', () => {
      logger.apiRequest('deepseek-chat', 3, false);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).not.toContain('with images');
    });

    it('apiResponse logs token count and duration', () => {
      logger.apiResponse(500, 2500);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Response');
      expect(logLine).toContain('500');
      expect(logLine).toContain('2.50s');
    });

    it('apiError logs error message', () => {
      logger.apiError('Rate limit exceeded');
      const logLine = (mockOutputChannel.error as Mock).mock.calls[0][0];
      expect(logLine).toContain('API error');
      expect(logLine).toContain('Rate limit exceeded');
    });

    it('apiError logs error with details', () => {
      logger.apiError('Connection failed', 'Status: 500');
      const logLine = (mockOutputChannel.error as Mock).mock.calls[0][0];
      expect(logLine).toContain('Connection failed');
      expect(logLine).toContain('Status: 500');
    });

    it('apiAborted logs cancellation', () => {
      logger.apiAborted();
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('aborted');
    });
  });

  describe('tool methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('toolCall logs tool name', () => {
      logger.toolCall('shell_execute');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Tool call');
      expect(logLine).toContain('shell_execute');
    });

    it('toolResult logs success', () => {
      logger.toolResult('shell_execute', true);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Tool result');
      expect(logLine).toContain('shell_execute');
      expect(logLine).toContain('succeeded');
    });

    it('toolResult logs failure as warning', () => {
      logger.toolResult('shell_execute', false);
      const logLine = (mockOutputChannel.warn as Mock).mock.calls[0][0];
      expect(logLine).toContain('Tool result');
      expect(logLine).toContain('shell_execute');
      expect(logLine).toContain('failed');
    });
  });

  describe('shell methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('shellExecuting logs command', () => {
      logger.shellExecuting('ls -la');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Shell executing');
      expect(logLine).toContain('ls -la');
    });

    it('shellResult logs success with output', () => {
      logger.shellResult('ls -la', true, 'file1.txt\nfile2.txt');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Shell completed');
      expect(logLine).toContain('ls -la');
      expect(logLine).toContain('file1.txt');
    });

    it('shellResult logs failure', () => {
      logger.shellResult('rm -rf /', false, 'Permission denied');
      const logLine = (mockOutputChannel.warn as Mock).mock.calls[0][0];
      expect(logLine).toContain('Shell failed');
      expect(logLine).toContain('rm -rf /');
    });

    it('shellResult truncates long output', () => {
      const longOutput = 'x'.repeat(300);
      logger.shellResult('cat bigfile', true, longOutput);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      // Output should be truncated to 200 chars
      expect(logLine.length).toBeLessThan(longOutput.length);
    });
  });

  describe('code methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('codeApplied logs success with file', () => {
      logger.codeApplied(true, 'src/index.ts');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Code applied');
      expect(logLine).toContain('src/index.ts');
    });

    it('codeApplied logs success without file', () => {
      logger.codeApplied(true);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Code applied');
    });

    it('codeApplied logs failure', () => {
      logger.codeApplied(false, 'src/index.ts');
      const logLine = (mockOutputChannel.warn as Mock).mock.calls[0][0];
      expect(logLine).toContain('Code apply failed');
      expect(logLine).toContain('src/index.ts');
    });

    it('diffShown logs file path', () => {
      logger.diffShown('src/utils/helper.ts');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Diff shown');
      expect(logLine).toContain('src/utils/helper.ts');
    });
  });

  describe('web search methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('webSearchRequest logs query and depth', () => {
      logger.webSearchRequest('React hooks', 'basic');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Web search');
      expect(logLine).toContain('React hooks');
      expect(logLine).toContain('basic');
    });

    it('webSearchResult logs count and duration', () => {
      logger.webSearchResult(5, 1500);
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Web search complete');
      expect(logLine).toContain('5 results');
      expect(logLine).toContain('1.50s');
    });

    it('webSearchCached logs at DEBUG level', () => {
      logger.webSearchCached('cached query');
      const logLine = (mockOutputChannel.debug as Mock).mock.calls[0][0];
      expect(logLine).toContain('Web search (cached)');
      expect(logLine).toContain('cached query');
    });

    it('webSearchError logs error', () => {
      logger.webSearchError('API key invalid');
      const logLine = (mockOutputChannel.error as Mock).mock.calls[0][0];
      expect(logLine).toContain('Web search failed');
      expect(logLine).toContain('API key invalid');
    });

    it('webSearchCacheCleared logs cache clear', () => {
      logger.webSearchCacheCleared();
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('cache cleared');
    });
  });

  describe('settings methods', () => {
    beforeEach(() => {
      logger.minLevel = 'DEBUG';
    });

    it('settingsChanged logs at DEBUG level', () => {
      logger.settingsChanged('editMode', 'manual');
      const logLine = (mockOutputChannel.debug as Mock).mock.calls[0][0];
      expect(logLine).toContain('Setting changed');
      expect(logLine).toContain('editMode');
      expect(logLine).toContain('manual');
    });

    it('modelChanged logs model name', () => {
      logger.modelChanged('deepseek-reasoner');
      const logLine = (mockOutputChannel.info as Mock).mock.calls[0][0];
      expect(logLine).toContain('Model changed');
      expect(logLine).toContain('deepseek-reasoner');
    });
  });

  describe('output channel operations', () => {
    it('show() reveals the output channel', () => {
      logger.show();
      expect(mockOutputChannel.show).toHaveBeenCalledWith(true);
    });

    it('clear() clears the output channel', () => {
      logger.clear();
      expect(mockOutputChannel.clear).toHaveBeenCalled();
    });

    it('dispose() disposes the output channel', () => {
      logger.dispose();
      expect(mockOutputChannel.dispose).toHaveBeenCalled();
    });
  });

  describe('minLevel property', () => {
    it('get returns current level', () => {
      logger.minLevel = 'WARN';
      expect(logger.minLevel).toBe('WARN');
    });

    it('set updates level', () => {
      logger.minLevel = 'ERROR';
      logger.warn('should not appear');
      expect(mockOutputChannel.warn).not.toHaveBeenCalled();

      logger.error('should appear');
      expect(mockOutputChannel.error).toHaveBeenCalled();
    });
  });
});
