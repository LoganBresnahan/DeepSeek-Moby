/**
 * Tests for ConfigManager singleton
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockConfiguration, workspace } from '../../__mocks__/vscode';
import { ConfigManager } from '../../../src/utils/config';

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton so each test gets a clean state
    (ConfigManager as any).instance = undefined;
  });

  describe('getInstance', () => {
    it('returns a ConfigManager instance', () => {
      const instance = ConfigManager.getInstance();
      expect(instance).toBeInstanceOf(ConfigManager);
    });

    it('returns the same instance on repeated calls (singleton)', () => {
      const instance1 = ConfigManager.getInstance();
      const instance2 = ConfigManager.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('get', () => {
    it('reads a value from VS Code configuration', () => {
      mockConfiguration.get.mockReturnValue('some-value');

      const config = ConfigManager.getInstance();
      const result = config.get<string>('apiKey');

      expect(workspace.getConfiguration).toHaveBeenCalledWith('moby');
      expect(mockConfiguration.get).toHaveBeenCalledWith('apiKey');
      expect(result).toBe('some-value');
    });

    it('returns undefined for missing keys', () => {
      mockConfiguration.get.mockReturnValue(undefined);

      const config = ConfigManager.getInstance();
      const result = config.get<string>('nonExistentKey');

      expect(result).toBeUndefined();
    });

    it('fetches fresh config on each get call (no stale cache)', () => {
      const config = ConfigManager.getInstance();

      mockConfiguration.get.mockReturnValue('value1');
      const first = config.get<string>('key');

      mockConfiguration.get.mockReturnValue('value2');
      const second = config.get<string>('key');

      // getConfiguration should be called each time, not cached
      expect(workspace.getConfiguration).toHaveBeenCalledTimes(2);
      expect(first).toBe('value1');
      expect(second).toBe('value2');
    });

    it('reads typed values (number)', () => {
      mockConfiguration.get.mockReturnValue(42);

      const config = ConfigManager.getInstance();
      const result = config.get<number>('timeout');

      expect(result).toBe(42);
    });

    it('reads typed values (boolean)', () => {
      mockConfiguration.get.mockReturnValue(true);

      const config = ConfigManager.getInstance();
      const result = config.get<boolean>('enabled');

      expect(result).toBe(true);
    });
  });

  describe('update', () => {
    it('writes a value to VS Code configuration', async () => {
      mockConfiguration.update.mockResolvedValue(undefined);

      const config = ConfigManager.getInstance();
      await config.update('apiKey', 'new-key');

      expect(workspace.getConfiguration).toHaveBeenCalledWith('moby');
      expect(mockConfiguration.update).toHaveBeenCalledWith('apiKey', 'new-key', undefined);
    });

    it('passes configuration target when provided', async () => {
      mockConfiguration.update.mockResolvedValue(undefined);

      const config = ConfigManager.getInstance();
      // ConfigurationTarget.Global = 1 in the real VS Code API
      await config.update('apiKey', 'new-key', 1 as any);

      expect(mockConfiguration.update).toHaveBeenCalledWith('apiKey', 'new-key', 1);
    });

    it('propagates errors from VS Code config update', async () => {
      const error = new Error('Config write failed');
      mockConfiguration.update.mockRejectedValue(error);

      const config = ConfigManager.getInstance();

      await expect(config.update('key', 'value')).rejects.toThrow('Config write failed');
    });
  });
});
