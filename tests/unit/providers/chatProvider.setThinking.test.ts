/**
 * Tests for the ChatProvider webview handlers `setThinking` / `setThinkingLevel`.
 *
 * These persist into `moby.modelOptions.<id>`, which `resolveThinking` reads
 * fresh on every request. The load-bearing behaviour is what they REFUSE: a
 * setting that names a state the model can't reach would read as authoritative
 * while the wire quietly ignores it — the same dead-control class the
 * declarative design exists to remove, just one layer up in settings.
 *
 * Drives the *real* inline handler: call `resolveWebviewView` on a mock `this`,
 * capture the `onDidReceiveMessage` callback, invoke it directly.
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
import { getCapabilities, registerCustomModels, __resetCustomModelsForTests } from '../../../src/models/registry';

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
    // The handlers delegate the read-modify-write to this private method, so
    // the harness needs the real one — stubbing it would test nothing.
    updateModelOptions: (ChatProvider.prototype as any).updateModelOptions,
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

describe("ChatProvider webview handlers — setThinking / setThinkingLevel", () => {
  beforeEach(() => {
    mobyConfig.update.mockClear();
    mobyConfig.get.mockClear();
    mobyConfig._store = {};
    __resetCustomModelsForTests();
    vi.restoreAllMocks();
  });

  const V4_PRO = 'deepseek-v4-pro-thinking';

  /** Kimi K3's shape: grades effort, declares no off-knob. */
  function registerAlwaysThinkingModel(id = 'kimi-k3') {
    registerCustomModels([{
      id, name: 'Kimi K3',
      toolCalling: 'native', reasoningTokens: 'inline',
      editProtocol: ['native-tool'], shellProtocol: 'none',
      supportsTemperature: false, maxOutputTokens: 131072,
      maxTokensConfigKey: 'maxTokensCustomKimi',
      streaming: true, apiEndpoint: 'https://api.moonshot.ai/v1',
      requestFormat: 'openai',
      thinkingLevels: { low: { reasoning_effort: 'low' }, max: { reasoning_effort: 'max' } },
      defaultThinkingLevel: 'max',
    }]);
    return id;
  }

  it('persists thinking:off for a model that declares an off-knob', async () => {
    const { dispatch } = buildHarness(V4_PRO);

    await dispatch({ type: 'setThinking', model: V4_PRO, thinking: 'off' });

    expect(mobyConfig.update).toHaveBeenCalledWith(
      'modelOptions', { [V4_PRO]: { thinking: 'off' } }, 1
    );
  });

  it('REFUSES thinking:off for a model that declares no off-knob', async () => {
    const id = registerAlwaysThinkingModel();
    expect(getCapabilities(id).disableThinkingParam).toBeUndefined(); // guards the premise
    const { dispatch } = buildHarness(id);

    await dispatch({ type: 'setThinking', model: id, thinking: 'off' });

    // Persisting it would leave a setting saying "off" that every request
    // ignores — worse than the control simply not existing.
    expect(mobyConfig.update).not.toHaveBeenCalled();
  });

  it('persists a declared level', async () => {
    const { dispatch } = buildHarness(V4_PRO);

    await dispatch({ type: 'setThinkingLevel', model: V4_PRO, level: 'high' });

    expect(mobyConfig.update).toHaveBeenCalledWith(
      'modelOptions', { [V4_PRO]: { thinkingLevel: 'high' } }, 1
    );
  });

  it('REFUSES a level the model does not declare', async () => {
    const { dispatch } = buildHarness(V4_PRO);

    // `low` is deliberately undeclared on V4 until the API confirms it.
    await dispatch({ type: 'setThinkingLevel', model: V4_PRO, level: 'low' });

    expect(mobyConfig.update).not.toHaveBeenCalled();
  });

  it('accepts a custom model own level vocabulary', async () => {
    const id = registerAlwaysThinkingModel();
    const { dispatch } = buildHarness(id);

    await dispatch({ type: 'setThinkingLevel', model: id, level: 'low' });

    expect(mobyConfig.update).toHaveBeenCalledWith(
      'modelOptions', { [id]: { thinkingLevel: 'low' } }, 1
    );
  });

  it('preserves the sibling key — the two settings are orthogonal', async () => {
    // The whole point of two keys: turning thinking off and back on must
    // remember the level. A read-modify-write that clobbered would lose it.
    mobyConfig._store.modelOptions = { [V4_PRO]: { thinkingLevel: 'high' } };
    const { dispatch } = buildHarness(V4_PRO);

    await dispatch({ type: 'setThinking', model: V4_PRO, thinking: 'off' });

    expect(mobyConfig.update).toHaveBeenCalledWith(
      'modelOptions', { [V4_PRO]: { thinkingLevel: 'high', thinking: 'off' } }, 1
    );
  });

  it('preserves other models entries', async () => {
    mobyConfig._store.modelOptions = { 'deepseek-v4-flash-thinking': { thinkingLevel: 'max' } };
    const { dispatch } = buildHarness(V4_PRO);

    await dispatch({ type: 'setThinkingLevel', model: V4_PRO, level: 'high' });

    expect(mobyConfig.update).toHaveBeenCalledWith('modelOptions', {
      'deepseek-v4-flash-thinking': { thinkingLevel: 'max' },
      [V4_PRO]: { thinkingLevel: 'high' },
    }, 1);
  });

  it('ignores malformed payloads', async () => {
    const { dispatch } = buildHarness(V4_PRO);

    await dispatch({ type: 'setThinking', model: V4_PRO, thinking: 'maybe' });
    await dispatch({ type: 'setThinking', thinking: 'off' });
    await dispatch({ type: 'setThinkingLevel', model: V4_PRO, level: '' });
    await dispatch({ type: 'setThinkingLevel', model: V4_PRO });

    expect(mobyConfig.update).not.toHaveBeenCalled();
  });
});
