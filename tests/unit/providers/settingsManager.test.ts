import { describe, it, expect, vi, beforeEach } from 'vitest';

// The default __mocks__/vscode.ts EventEmitter uses vi.fn() stubs that don't
// wire event→fire. We need real subscriptions for testing event-driven classes.
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

// Track config values set by update() so get() can read them back
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, any>()
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    workspace: {
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (configStore.has(key)) return configStore.get(key);
          // Return sensible defaults
          const defaults: Record<string, any> = {
            'model': 'deepseek-chat',
            'temperature': 0.7,
            'maxToolCalls': 100,
            'maxShellIterations': 100,
            'maxTokens': 8192,
            'logLevel': 'WARN',
            'webviewLogLevel': 'WARN',
            'tracing.enabled': true,
            'logColors': true,
            'systemPrompt': '',
            'autoSaveHistory': true,
            'allowAllShellCommands': false,
            'editMode': 'manual'
          };
          return defaults[key] ?? defaultValue;
        }),
        update: vi.fn(async (key: string, value: any) => {
          if (value === undefined) {
            configStore.delete(key);
          } else {
            configStore.set(key, value);
          }
        }),
        has: vi.fn().mockReturnValue(true),
        inspect: vi.fn()
      }))
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
  };
});

import { SettingsManager } from '../../../src/providers/settingsManager';
import type { SettingsSnapshot } from '../../../src/providers/types';
import type { ModelChangedEvent, DefaultPromptEvent } from '../../../src/providers/settingsManager';

// ── DeepSeekClient mock ──
function createMockClient() {
  return {
    setModel: vi.fn(),
    getModel: vi.fn(() => 'deepseek-chat'),
    chat: vi.fn(),
    chatStream: vi.fn(),
    getApiUsage: vi.fn(),
  };
}

describe('SettingsManager', () => {
  let manager: SettingsManager;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    configStore.clear();
    mockClient = createMockClient();
    manager = new SettingsManager(mockClient as any);
  });

  // ── updateSettings ──

  describe('updateSettings', () => {
    it('should update temperature in VS Code config', async () => {
      await manager.updateSettings({ temperature: 0.5 });

      expect(configStore.get('temperature')).toBe(0.5);
    });

    it('should update maxToolCalls in VS Code config', async () => {
      await manager.updateSettings({ maxToolCalls: 10 });

      expect(configStore.get('maxToolCalls')).toBe(10);
    });

    it('should update maxTokens in VS Code config', async () => {
      await manager.updateSettings({ maxTokens: 4096 });

      expect(configStore.get('maxTokens')).toBe(4096);
    });

    it('should update autoSaveHistory in VS Code config', async () => {
      await manager.updateSettings({ autoSaveHistory: false });

      expect(configStore.get('autoSaveHistory')).toBe(false);
    });

    it('should set model on client immediately and fire onModelChanged', async () => {
      const modelEvents: ModelChangedEvent[] = [];
      manager.onModelChanged(e => modelEvents.push(e));

      await manager.updateSettings({ model: 'deepseek-reasoner' });

      expect(mockClient.setModel).toHaveBeenCalledWith('deepseek-reasoner');
      expect(configStore.get('model')).toBe('deepseek-reasoner');
      expect(modelEvents).toEqual([{ model: 'deepseek-reasoner' }]);
    });

    it('should fire onSettingsChanged after model change', async () => {
      const settingsEvents: SettingsSnapshot[] = [];
      manager.onSettingsChanged(e => settingsEvents.push(e));

      await manager.updateSettings({ model: 'deepseek-reasoner' });

      expect(settingsEvents).toHaveLength(1);
      expect(settingsEvents[0].model).toBe('deepseek-reasoner');
    });

    it('should handle multiple settings at once', async () => {
      await manager.updateSettings({
        temperature: 0.3,
        maxTokens: 2048,
        maxToolCalls: 5
      });

      expect(configStore.get('temperature')).toBe(0.3);
      expect(configStore.get('maxTokens')).toBe(2048);
      expect(configStore.get('maxToolCalls')).toBe(5);
    });

    it('should not fire model events for non-model updates', async () => {
      const modelEvents: ModelChangedEvent[] = [];
      manager.onModelChanged(e => modelEvents.push(e));

      await manager.updateSettings({ temperature: 0.5 });

      expect(modelEvents).toHaveLength(0);
    });
  });

  // ── updateLogSettings ──

  describe('updateLogSettings', () => {
    it('should update logLevel in VS Code config', async () => {
      await manager.updateLogSettings({ logLevel: 'DEBUG' });

      expect(configStore.get('logLevel')).toBe('DEBUG');
    });

    it('should update logColors in VS Code config', async () => {
      await manager.updateLogSettings({ logColors: false });

      expect(configStore.get('logColors')).toBe(false);
    });

    it('should handle both settings at once', async () => {
      await manager.updateLogSettings({ logLevel: 'ERROR', logColors: false });

      expect(configStore.get('logLevel')).toBe('ERROR');
      expect(configStore.get('logColors')).toBe(false);
    });
  });

  // ── updateWebviewLogSettings ──

  describe('updateWebviewLogSettings', () => {
    it('should update webviewLogLevel and fire onSettingsChanged', async () => {
      const settingsEvents: SettingsSnapshot[] = [];
      manager.onSettingsChanged(e => settingsEvents.push(e));

      await manager.updateWebviewLogSettings({ webviewLogLevel: 'DEBUG' });

      expect(configStore.get('webviewLogLevel')).toBe('DEBUG');
      expect(settingsEvents).toHaveLength(1);
    });
  });

  // ── updateTracingSettings ──

  describe('updateTracingSettings', () => {
    it('should update tracing.enabled in VS Code config', async () => {
      await manager.updateTracingSettings({ enabled: false });

      expect(configStore.get('tracing.enabled')).toBe(false);
    });
  });

  // ── updateReasonerSettings ──

  describe('updateReasonerSettings', () => {
    it('should update allowAllShellCommands in VS Code config', async () => {
      await manager.updateReasonerSettings({ allowAllCommands: true });

      expect(configStore.get('allowAllShellCommands')).toBe(true);
    });
  });

  // ── updateSystemPrompt ──

  describe('updateSystemPrompt', () => {
    it('should update systemPrompt in VS Code config', async () => {
      await manager.updateSystemPrompt('You are a test assistant.');

      expect(configStore.get('systemPrompt')).toBe('You are a test assistant.');
    });
  });

  // ── sendDefaultSystemPrompt ──

  describe('sendDefaultSystemPrompt', () => {
    it('should fire onDefaultPromptRequested with chat prompt for deepseek-chat', () => {
      const events: DefaultPromptEvent[] = [];
      manager.onDefaultPromptRequested(e => events.push(e));

      manager.sendDefaultSystemPrompt();

      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('DeepSeek Chat');
      expect(events[0].prompt).toContain('AI programming assistant');
    });

    it('should fire onDefaultPromptRequested with reasoner prompt for deepseek-reasoner', () => {
      configStore.set('model', 'deepseek-reasoner');
      const events: DefaultPromptEvent[] = [];
      manager.onDefaultPromptRequested(e => events.push(e));

      manager.sendDefaultSystemPrompt();

      expect(events).toHaveLength(1);
      expect(events[0].model).toBe('DeepSeek Reasoner (R1)');
      expect(events[0].prompt).toContain('shell');
    });
  });

  // ── getCurrentSettings ──

  describe('getCurrentSettings', () => {
    it('should return a snapshot of all settings with defaults', () => {
      const snapshot = manager.getCurrentSettings();

      expect(snapshot.model).toBe('deepseek-chat');
      expect(snapshot.temperature).toBe(0.7);
      expect(snapshot.maxToolCalls).toBe(100);
      expect(snapshot.maxShellIterations).toBe(100);
      expect(snapshot.maxTokens).toBe(8192);
      expect(snapshot.logLevel).toBe('WARN');
      expect(snapshot.webviewLogLevel).toBe('WARN');
      expect(snapshot.tracingEnabled).toBe(true);
      expect(snapshot.logColors).toBe(true);
      expect(snapshot.systemPrompt).toBe('');
      expect(snapshot.autoSaveHistory).toBe(true);
      expect(snapshot.allowAllCommands).toBe(false);
    });

    it('should reflect updated values from config store', () => {
      configStore.set('model', 'deepseek-reasoner');
      configStore.set('temperature', 0.3);
      configStore.set('maxTokens', 2048);

      const snapshot = manager.getCurrentSettings();

      expect(snapshot.model).toBe('deepseek-reasoner');
      expect(snapshot.temperature).toBe(0.3);
      expect(snapshot.maxTokens).toBe(2048);
    });

    it('should include webSearch defaults', () => {
      const snapshot = manager.getCurrentSettings();

      expect(snapshot.webSearch).toEqual({
        searchDepth: 'basic',
        creditsPerPrompt: 1,
        maxResultsPerSearch: 5,
        cacheDuration: 15,
        mode: 'auto'
      });
    });
  });

  // ── resetToDefaults ──

  describe('resetToDefaults', () => {
    it('should clear all settings from VS Code config', async () => {
      // Set some values first
      configStore.set('logLevel', 'DEBUG');
      configStore.set('temperature', 0.3);
      configStore.set('maxTokens', 2048);

      await manager.resetToDefaults();

      // All settings should be cleared (undefined → deleted from configStore)
      expect(configStore.has('logLevel')).toBe(false);
      expect(configStore.has('webviewLogLevel')).toBe(false);
      expect(configStore.has('tracing.enabled')).toBe(false);
      expect(configStore.has('logColors')).toBe(false);
      expect(configStore.has('systemPrompt')).toBe(false);
      expect(configStore.has('maxTokens')).toBe(false);
      expect(configStore.has('maxToolCalls')).toBe(false);
      expect(configStore.has('maxShellIterations')).toBe(false);
      expect(configStore.has('editMode')).toBe(false);
      expect(configStore.has('autoSaveHistory')).toBe(false);
    });

    it('should fire onSettingsChanged with fresh defaults', async () => {
      const settingsEvents: SettingsSnapshot[] = [];
      manager.onSettingsChanged(e => settingsEvents.push(e));

      await manager.resetToDefaults();

      expect(settingsEvents).toHaveLength(1);
      expect(settingsEvents[0].model).toBe('deepseek-chat');
      expect(settingsEvents[0].temperature).toBe(0.7);
    });

    it('should fire onSettingsReset', async () => {
      const resetEvents: void[] = [];
      manager.onSettingsReset(() => resetEvents.push(undefined));

      await manager.resetToDefaults();

      expect(resetEvents).toHaveLength(1);
    });
  });

  // ── dispose ──

  describe('dispose', () => {
    it('should dispose all emitters without error', () => {
      expect(() => manager.dispose()).not.toThrow();
    });

    it('should not fire events after dispose', () => {
      const events: DefaultPromptEvent[] = [];
      manager.onDefaultPromptRequested(e => events.push(e));

      manager.dispose();
      manager.sendDefaultSystemPrompt();

      expect(events).toHaveLength(0);
    });
  });
});
