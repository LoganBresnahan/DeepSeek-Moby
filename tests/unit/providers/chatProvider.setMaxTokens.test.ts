/**
 * Tests for the ChatProvider webview message handler `case 'setMaxTokens'`
 * (src/providers/chatProvider.ts ~line 612-635).
 *
 * Regression coverage for the "dead slider" bug: the handler must BOTH persist
 * the new max-tokens value to the correct per-model VS Code config key AND emit
 * a `logger.settingsChanged(...)` call. The log call was the missing piece that
 * made the slider look like it did nothing.
 *
 * Unlike the lifecycle/queuing suites (which simulate the switch body inline or
 * bind individual prototype methods), this suite drives the *real* inline
 * handler. We call `resolveWebviewView` on a lightweight mock `this`, capture
 * the function passed to `webview.onDidReceiveMessage`, and invoke it directly
 * with a `setMaxTokens` payload — exercising the production code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Working EventEmitter for real event subscriptions (same pattern as siblings).
const { WorkingEventEmitter, mobyConfig } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data?: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  },
  // A single, stable config object so the `config.update` the handler calls is
  // the exact spy we assert on. `_store` backs `get` for the custom-model path.
  mobyConfig: {
    _store: {} as Record<string, any>,
    get: vi.fn((key: string, defaultValue?: any) =>
      key in (mobyConfig as any)._store ? (mobyConfig as any)._store[key] : defaultValue),
    update: vi.fn(async () => {}),
    has: vi.fn().mockReturnValue(true),
    inspect: vi.fn(),
  },
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    workspace: {
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      // Always hand back the same moby config object.
      getConfiguration: vi.fn(() => mobyConfig),
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
      asRelativePath: vi.fn((uri: any) => uri.fsPath || uri),
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), append: vi.fn(), show: vi.fn(),
        clear: vi.fn(), dispose: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      })),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    Uri: {
      joinPath: vi.fn(() => ({ fsPath: '/mock' })),
      file: vi.fn((p: string) => ({ fsPath: p })),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

import { ChatProvider } from '../../../src/providers/chatProvider';
import { logger } from '../../../src/utils/logger';
import { getCapabilities } from '../../../src/models/registry';

const resolveWebviewView = (ChatProvider.prototype as any).resolveWebviewView;

/**
 * Build a minimal `this` for ChatProvider + a webview mock that captures the
 * `onDidReceiveMessage` handler, register the real handler, and return a
 * dispatch function that posts a message to it (mirroring what VS Code does
 * when the webview calls `vscode.postMessage`).
 */
function buildHarness(getModelReturn: string) {
  let handler: ((data: any) => Promise<void> | void) | undefined;

  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: vi.fn((cb: any) => { handler = cb; return { dispose: vi.fn() }; }),
    postMessage: vi.fn(),
    asWebviewUri: vi.fn((u: any) => u),
    cspSource: 'self',
  };
  const webviewView: any = {
    webview,
    visible: true,
    onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const cp: any = {
    _extensionUri: { fsPath: '/ext' },
    _summarizing: false,
    _pendingMessages: [],
    currentSessionId: null,
    deepSeekClient: { getModel: vi.fn(() => getModelReturn) },
    // Stub the heavy synchronous work resolveWebviewView performs at the end so
    // only the handler registration matters for the test.
    getHtmlForWebview: vi.fn(() => '<html></html>'),
    loadCurrentSessionHistory: vi.fn(),
  };

  // Register the real inline handler.
  resolveWebviewView.call(cp, webviewView, { state: undefined }, {});

  return {
    cp,
    webview,
    dispatch: async (data: any) => {
      if (!handler) throw new Error('onDidReceiveMessage handler was never registered');
      await handler(data);
    },
  };
}

describe("ChatProvider webview handler — case 'setMaxTokens'", () => {
  beforeEach(() => {
    mobyConfig.update.mockClear();
    mobyConfig.get.mockClear();
    mobyConfig._store = {};
    vi.restoreAllMocks();
  });

  it('built-in model: writes the per-model config key with the value AND logs settingsChanged', async () => {
    const settingsChangedSpy = vi.spyOn(logger, 'settingsChanged');

    // deepseek-v4-pro-thinking → maxTokensV4ProThinking (per the registry).
    const model = 'deepseek-v4-pro-thinking';
    const expectedKey = getCapabilities(model).maxTokensConfigKey;
    expect(expectedKey).toBe('maxTokensV4ProThinking'); // guards the registry assumption

    // getModel returns something different to prove the explicit `model` is used.
    const { dispatch } = buildHarness('deepseek-chat');

    await dispatch({ type: 'setMaxTokens', maxTokens: 200000, model });

    // Config write: correct key, value, Global target (ConfigurationTarget.Global === 1).
    expect(mobyConfig.update).toHaveBeenCalledTimes(1);
    expect(mobyConfig.update).toHaveBeenCalledWith(expectedKey, 200000, 1);

    // Log call — this is the bit that was missing and made the slider look dead.
    expect(settingsChangedSpy).toHaveBeenCalledTimes(1);
    expect(settingsChangedSpy).toHaveBeenCalledWith(expectedKey, 200000);
  });

  it('falls back to deepSeekClient.getModel() when no model is supplied', async () => {
    const settingsChangedSpy = vi.spyOn(logger, 'settingsChanged');

    const model = 'deepseek-v4-flash-thinking';
    const expectedKey = getCapabilities(model).maxTokensConfigKey; // maxTokensV4FlashThinking

    const { dispatch, cp } = buildHarness(model);

    await dispatch({ type: 'setMaxTokens', maxTokens: 12345 /* no model field */ });

    expect(cp.deepSeekClient.getModel).toHaveBeenCalled();
    expect(mobyConfig.update).toHaveBeenCalledWith(expectedKey, 12345, 1);
    expect(settingsChangedSpy).toHaveBeenCalledWith(expectedKey, 12345);
  });

  it('custom model: patches customModels[].maxOutputTokens AND logs the dotted key', async () => {
    const settingsChangedSpy = vi.spyOn(logger, 'settingsChanged');

    const customId = 'my-local-model';
    // Seed the moby.customModels array the handler reads via config.get.
    mobyConfig._store.customModels = [
      { id: 'other', name: 'Other', maxOutputTokens: 1000 },
      { id: customId, name: 'Local', maxOutputTokens: 2000 },
    ];

    const { dispatch } = buildHarness('deepseek-chat');

    await dispatch({ type: 'setMaxTokens', maxTokens: 9000, model: customId });

    // Wrote the full customModels array back with the patched entry.
    expect(mobyConfig.update).toHaveBeenCalledTimes(1);
    const [writtenKey, writtenValue, target] = mobyConfig.update.mock.calls[0];
    expect(writtenKey).toBe('customModels');
    expect(target).toBe(1);
    const patched = (writtenValue as Array<any>).find(e => e.id === customId);
    expect(patched.maxOutputTokens).toBe(9000);
    // Untouched sibling preserved.
    expect((writtenValue as Array<any>).find(e => e.id === 'other').maxOutputTokens).toBe(1000);

    // Logs the dotted custom-model key.
    expect(settingsChangedSpy).toHaveBeenCalledWith(`customModels.${customId}.maxOutputTokens`, 9000);
  });
});
