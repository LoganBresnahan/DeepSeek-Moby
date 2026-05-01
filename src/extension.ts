import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { ChatProvider } from './providers/chatProvider';
import { CommandProvider } from './providers/commandProvider';
import { StatusBar } from './views/statusBar';
import { ConfigManager } from './utils/config';
import { ConversationManager, createLLMSummarizer } from './events';
import { WebSearchProviderRegistry } from './clients/webSearchProviderRegistry';
import { pickServiceLocation, resolveServiceUrl } from './utils/serviceLocation';
import { logger } from './utils/logger';
import { UnifiedLogExporter } from './logging/UnifiedLogExporter';
import { TokenService } from './services/tokenService';
import { LspAvailability } from './services/lspAvailability';
import { DrawingServer } from './providers/drawingServer';
import { registerCustomModels } from './models/registry';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

let chatProvider: ChatProvider;
let commandProvider: CommandProvider;
let statusBar: StatusBar;
let deepSeekClient: DeepSeekClient;
let conversationManager: ConversationManager;
let webSearchRegistry: WebSearchProviderRegistry;
let drawingServer: DrawingServer;

export async function activate(context: vscode.ExtensionContext) {
  logger.info('DeepSeek Moby extension activated');

  // Initialize configuration
  const config = ConfigManager.getInstance();

  // Load user-declared custom models into the registry before anything that
  // reads capabilities runs. Re-run on config changes so hot-adding a model
  // via settings.json doesn't require an extension reload.
  const reloadCustomModels = () => {
    const raw = vscode.workspace.getConfiguration('moby').get<unknown[]>('customModels') ?? [];
    const { loaded, errors } = registerCustomModels(raw);
    if (loaded > 0) logger.info(`[Registry] Loaded ${loaded} custom model(s)`);
    for (const err of errors) logger.warn(`[Registry] Custom model rejected — ${err}`);
  };
  reloadCustomModels();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('moby.customModels')) {
        reloadCustomModels();
        chatProvider?.sendModelList();
      }
      // Phase 4 — re-broadcast the model list when modelOptions changes
      // (per-model reasoningEffort overrides) so the selector's active
      // pill reflects edits made directly to settings.json, not just the
      // ones routed through the popup. `sendModelList` re-reads the
      // override bag and re-decorates each entry with the effective effort.
      if (e.affectsConfiguration('moby.modelOptions')) {
        chatProvider?.sendModelList();
      }
      // Web-search provider / endpoint / engines — settings popup dots
      // and the web-search popup's provider-specific section need to
      // update live when any of these change.
      if (
        e.affectsConfiguration('moby.webSearch.provider') ||
        e.affectsConfiguration('moby.webSearch.searxng.endpoint') ||
        e.affectsConfiguration('moby.webSearch.searxng.engines')
      ) {
        chatProvider?.refreshSettings();
      }
    })
  );

  // Initialize WASM tokenizer (exact token counting)
  const tokenService = TokenService.getInstance(context.extensionPath);
  try {
    await tokenService.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[TokenService] WASM tokenizer failed: ${msg}`);
    // Don't block activation — DeepSeekClient falls back to EstimationTokenCounter
  }

  // Initialize DeepSeek client (uses WASM tokenizer if available, estimation otherwise)
  const useWasm = tokenService.isReady;
  deepSeekClient = new DeepSeekClient(context, useWasm ? tokenService : undefined);
  logger.info(`[TokenService] Active: ${useWasm ? 'WASM (exact)' : 'Estimation (fallback)'}`);

  // Switch the WASM vocab to match the restored active model. Without this,
  // the default vocab loads at activation and stays active even when the
  // restored model needs a different one (e.g. V4 on V3's vocab) — the
  // selectModel webview message only fires on user dropdown clicks.
  if (useWasm) {
    try {
      await tokenService.selectModel(deepSeekClient.getModel());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[TokenService] Failed to load vocab for restored model: ${msg}`);
    }
  }

  // Kick off LSP per-language discovery in the background. Results are
  // consulted by the orchestrator when building the tool array AND when
  // injecting the per-language availability declaration into the system
  // prompt. See [docs/plans/partial/lsp-integration.md] Phase 4.
  const lspAvailability = LspAvailability.getInstance();
  context.subscriptions.push(...lspAvailability.registerInvalidators());
  lspAvailability.warmUp();

  // Initialize conversation manager (event sourcing) with encrypted DB
  const dbEncryptionKey = await getOrCreateEncryptionKey(context);
  // Create LLM-powered summarizer for context compression (chained summaries)
  const llmSummarizer = createLLMSummarizer(
    (messages, systemPrompt, options) => deepSeekClient.chat(
      messages.map(m => ({ role: m.role as any, content: m.content })),
      systemPrompt,
      options
    )
  );
  try {
    conversationManager = new ConversationManager(context, {
      encryptionKey: dbEncryptionKey,
      summarizer: llmSummarizer
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Database] Failed to open conversation database: ${msg}`);
    vscode.window.showErrorMessage(
      `DeepSeek Moby: Failed to open conversation database. ${msg}`
    );
    throw err;
  }

  // Initialize status bar
  statusBar = new StatusBar(deepSeekClient, conversationManager);

  // Initialize the web search provider registry. Phase 1: Tavily is the
  // sole entry; the registry resolves `active()` to it unconditionally.
  webSearchRegistry = new WebSearchProviderRegistry(context);

  // Initialize drawing server (starts on-demand via command)
  drawingServer = new DrawingServer();
  drawingServer.onImageReceived((event) => {
    const sizeKB = Math.round(event.imageDataUrl.length / 1024);
    vscode.window.showInformationMessage(`Drawing received (${sizeKB} KB)`);
  });
  context.subscriptions.push({ dispose: () => drawingServer.dispose() });

  // Initialize chat provider (sidebar)
  chatProvider = new ChatProvider(
    context.extensionUri,
    deepSeekClient,
    statusBar,
    conversationManager,
    webSearchRegistry,
    drawingServer
  );

  // Initialize command provider (code actions)
  commandProvider = new CommandProvider(
    deepSeekClient, statusBar, conversationManager,
    () => chatProvider.getCurrentSessionId()
  );

  // Register providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register commands
  registerCommands(context);

  // Start status bar
  statusBar.start();

  // Check API key (fire-and-forget — don't block activation)
  checkApiKey(context);
}

function registerCommands(context: vscode.ExtensionContext) {
  const commands = [
    { name: 'startChat', handler: () => chatProvider.reveal() },
    { name: 'newChat', handler: () => chatProvider.clearConversation() },
    { name: 'switchModel', handler: () => commandProvider.switchModel() },
    
    // Chat History Commands
    { name: 'showChatHistory', handler: () => chatProvider.openHistoryModal() },
    { name: 'openCommandRules', handler: () => chatProvider.openRulesModal() },
    { name: 'exportChatHistory', handler: () => commandProvider.exportChatHistory() },
    { name: 'importChatHistory', handler: () => commandProvider.importChatHistory() },
    { name: 'clearChatHistory', handler: () => commandProvider.clearChatHistory() },
    { name: 'exportCurrentSession', handler: () => commandProvider.exportCurrentSession() },
    { name: 'showStats', handler: () => chatProvider.showStats() },
    { name: 'showLogs', handler: () => logger.show() },

    // Unified Log Export
    { name: 'exportLogs', handler: () => UnifiedLogExporter.exportForHuman() },

    // Diff quick pick command
    { name: 'showDiffQuickPick', handler: async () => {
      await chatProvider.showDiffQuickPick();
    }},

    // Drawing Server
    { name: 'startDrawingServer', handler: () => startDrawingServerCommand() },
    { name: 'stopDrawingServer', handler: () => stopDrawingServerCommand() },

    // API Key management
    { name: 'setApiKey', handler: () => setApiKey(context) },
    { name: 'setTavilyApiKey', handler: () => setTavilyApiKey(context) },
    { name: 'setSearxngEndpoint', handler: () => setSearxngEndpoint() },
    { name: 'setCustomModelApiKey', handler: (modelId?: string) => setCustomModelApiKey(context, modelId) },
    { name: 'clearCustomModelApiKey', handler: (modelId?: string) => clearCustomModelApiKey(context, modelId) },
    { name: 'addCustomModel', handler: () => addCustomModel() },

    // Database encryption key
    { name: 'manageEncryptionKey', handler: () => manageEncryptionKey(context, conversationManager) },

    // LSP availability — re-runs the per-language probe. For users who
    // installed an LSP outside VS Code (e.g. `gem install solargraph`,
    // `pip install python-lsp-server`) without restarting; the extension's
    // automatic invalidators fire on marketplace events but not shell
    // installs.
    { name: 'refreshLspAvailability', handler: async () => {
      LspAvailability.getInstance().invalidate();
      await LspAvailability.getInstance().discoverWorkspace();
      const decl = LspAvailability.getInstance().getDeclaredAvailability();
      const summary =
        `LSP available: ${decl.available.length ? decl.available.join(', ') : '(none)'}\n` +
        `Unavailable: ${decl.unavailable.length ? decl.unavailable.join(', ') : '(none)'}`;
      vscode.window.showInformationMessage(`Moby LSP refreshed.\n${summary}`);
    }},

    // Diff editor toolbar actions. The editor/title menu passes the resource
    // URI as the first argument when the button is clicked — forward it so
    // DiffManager can look up the diff even if activeTextEditor is stale.
    { name: 'acceptActiveDiff', handler: (uri?: vscode.Uri) => chatProvider.acceptActiveDiff(uri) },
    { name: 'rejectActiveDiff', handler: (uri?: vscode.Uri) => chatProvider.rejectActiveDiff(uri) }
  ];

  commands.forEach(({ name, handler }) => {
    const disposable = vscode.commands.registerCommand(`moby.${name}`, handler);
    context.subscriptions.push(disposable);
  });

  // Dev-only commands — registered when devMode is enabled at activation.
  // The command also appears in the webview Commands popup (gated by devMode).
  const config = vscode.workspace.getConfiguration('moby');
  if (config.get<boolean>('devMode', false)) {
    context.subscriptions.push(
      vscode.commands.registerCommand('moby.exportTestFixture', () =>
        exportTestFixture(context)
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand('moby.exportTurnAsJson', () =>
        exportTurnAsJson(chatProvider)
      )
    );
  }
}

/**
 * ADR 0003 Phase 1 debug command — dumps the last completed turn's structural
 * event stream (extension-authored) as JSON so you can inspect live vs. saved
 * vs. hydrated event sequences side-by-side during development of phases 2-3.
 */
async function exportTurnAsJson(chatProvider: import('./providers/chatProvider').ChatProvider): Promise<void> {
  const recorder = chatProvider.getStructuralEventRecorder();
  const current = recorder.peekCurrent();
  const last = recorder.peekLastCompleted();

  const payload = {
    capturedAt: new Date().toISOString(),
    currentSessionId: chatProvider.getCurrentSessionId(),
    inFlightTurn: current,
    lastCompletedTurn: last,
  };

  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(payload, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

const DB_KEY_SECRET = 'deepseek-moby.db-encryption-key';
const DB_KEY_FALLBACK_FILE = 'db-key.txt';

/**
 * Get or create the database encryption key.
 *
 * Strategy:
 * 1. Try the OS keyring via VS Code's SecretStorage API (most secure).
 *    On Linux without a keyring daemon, VS Code falls back to in-memory
 *    or basic storage automatically. The secrets API should not hang.
 * 2. If the secrets API throws (broken keyring, permissions, etc.),
 *    fall back to a file in globalStorage with restrictive permissions.
 */
async function getOrCreateEncryptionKey(context: vscode.ExtensionContext): Promise<string> {
  try {
    // Try reading from VS Code's SecretStorage (OS keyring or VS Code's fallback)
    const key = await context.secrets.get(DB_KEY_SECRET);
    if (key) return key;

    // No key stored yet — generate and store
    const newKey = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(DB_KEY_SECRET, newKey);
    logger.info('[EncryptionKey] Generated new key (stored via SecretStorage)');
    return newKey;
  } catch (err) {
    // SecretStorage failed — fall back to file-based storage
    logger.warn(`[EncryptionKey] SecretStorage unavailable: ${err instanceof Error ? err.message : err}`);
    logger.info('[EncryptionKey] Using file-based key storage as fallback');
    return getOrCreateFileKey(context);
  }
}

/** Read key from fallback file, or generate + save a new one. */
async function getOrCreateFileKey(context: vscode.ExtensionContext): Promise<string> {
  const keyPath = path.join(context.globalStorageUri.fsPath, DB_KEY_FALLBACK_FILE);

  try {
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath, 'utf-8').trim();
      if (key.length >= 16) {
        logger.info('[EncryptionKey] Loaded key from file-based storage');
        return key;
      }
    }
  } catch {
    // File doesn't exist or is unreadable — generate new key
  }

  const newKey = crypto.randomBytes(32).toString('hex');
  return saveKeyToFile(context, newKey);
}

/** Write key to file in globalStorage with restrictive permissions. */
function saveKeyToFile(context: vscode.ExtensionContext, key: string): string {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, DB_KEY_FALLBACK_FILE);
  fs.writeFileSync(keyPath, key, { mode: 0o600 }); // Owner read/write only
  logger.info('[EncryptionKey] Saved key to file-based storage');
  return key;
}

/** Store encryption key — try SecretStorage first, fall back to file. */
async function storeEncryptionKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  try {
    await context.secrets.store(DB_KEY_SECRET, key);
  } catch {
    saveKeyToFile(context, key);
  }
}

async function checkApiKey(context: vscode.ExtensionContext) {
  const apiKey = await context.secrets.get('moby.apiKey');

  if (!apiKey) {
    const result = await vscode.window.showInformationMessage(
      'DeepSeek Moby: API key is not set. Would you like to configure it now?',
      'Configure', 'Later'
    );

    if (result === 'Configure') {
      vscode.commands.executeCommand('moby.setApiKey');
    }
  }
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get('moby.apiKey');
  const input = await vscode.window.showInputBox({
    prompt: current
      ? 'Enter a new DeepSeek API key, or clear the field to remove it'
      : 'Enter your DeepSeek API key (from platform.deepseek.com)',
    password: true,
    placeHolder: 'sk-...',
    value: current ? '••••••••' : '',
    ignoreFocusOut: true
  });
  if (input === undefined) return; // user cancelled (Escape)
  if (input === '••••••••') return; // unchanged

  if (!input.trim()) {
    // Empty input — remove the key
    await context.secrets.delete('moby.apiKey');
    if (process.env.DEEPSEEK_API_KEY) {
      vscode.window.showWarningMessage(
        'DeepSeek secret cleared, but the DEEPSEEK_API_KEY environment variable is still set and will continue to satisfy the API key check. Unset it from your shell (and restart VS Code) to fully remove the key.'
      );
    } else {
      vscode.window.showInformationMessage('DeepSeek API key removed.');
    }
  } else {
    await context.secrets.store('moby.apiKey', input.trim());
    vscode.window.showInformationMessage('DeepSeek API key saved securely.');
  }
  chatProvider.refreshSettings();
}

/**
 * SecretStorage key prefix for per-custom-model API keys.
 * Keyed by the model id declared in `moby.customModels` — e.g.
 * `moby.customModelKey.qwen2.5-coder:7b-instruct`.
 */
function customModelSecretKey(modelId: string): string {
  return `moby.customModelKey.${modelId}`;
}

async function setCustomModelApiKey(
  context: vscode.ExtensionContext,
  modelIdArg?: string
): Promise<void> {
  // Let the caller pass a specific model id (from the settings popup), or
  // surface a quickPick listing custom models when invoked via the palette.
  const customModels = getCustomModelsFromConfig();
  if (customModels.length === 0) {
    vscode.window.showInformationMessage('No custom models configured. Add entries to `moby.customModels` first.');
    return;
  }

  let modelId = modelIdArg;
  if (!modelId) {
    const pick = await vscode.window.showQuickPick(
      customModels.map(m => ({ label: m.name ?? m.id, description: m.id, id: m.id })),
      { placeHolder: 'Select a custom model to set the API key for' }
    );
    if (!pick) return;
    modelId = pick.id;
  }

  const secretKey = customModelSecretKey(modelId);
  const current = await context.secrets.get(secretKey);
  const model = customModels.find(m => m.id === modelId);
  const input = await vscode.window.showInputBox({
    prompt: current
      ? `Enter a new API key for "${model?.name ?? modelId}", or clear the field to remove it`
      : `Enter the API key for "${model?.name ?? modelId}"`,
    password: true,
    placeHolder: 'sk-...',
    value: current ? '••••••••' : '',
    ignoreFocusOut: true
  });
  if (input === undefined) return;
  if (input === '••••••••') return;

  if (!input.trim()) {
    await context.secrets.delete(secretKey);
    vscode.window.showInformationMessage(`API key removed for "${model?.name ?? modelId}".`);
  } else {
    await context.secrets.store(secretKey, input.trim());
    vscode.window.showInformationMessage(`API key saved for "${model?.name ?? modelId}".`);
  }
  chatProvider?.sendModelList();
  // Re-evaluate the active model's apiKeyConfigured — setting/clearing a
  // per-model key can flip the send-button gate if this model is active.
  chatProvider?.refreshSettings();
}

async function clearCustomModelApiKey(
  context: vscode.ExtensionContext,
  modelIdArg?: string
): Promise<void> {
  const customModels = getCustomModelsFromConfig();
  let modelId = modelIdArg;
  if (!modelId) {
    const pick = await vscode.window.showQuickPick(
      customModels.map(m => ({ label: m.name ?? m.id, description: m.id, id: m.id })),
      { placeHolder: 'Select a custom model to clear the API key for' }
    );
    if (!pick) return;
    modelId = pick.id;
  }
  await context.secrets.delete(customModelSecretKey(modelId));
  const model = customModels.find(m => m.id === modelId);
  vscode.window.showInformationMessage(`API key cleared for "${model?.name ?? modelId}".`);
  chatProvider?.sendModelList();
  chatProvider?.refreshSettings();
}

/** Read the raw `moby.customModels` entries from settings for quickPick display. */
function getCustomModelsFromConfig(): Array<{ id: string; name?: string }> {
  const raw = vscode.workspace.getConfiguration('moby').get<Array<{ id?: string; name?: string }>>('customModels') ?? [];
  return raw.filter((m): m is { id: string; name?: string } => typeof m?.id === 'string');
}

/**
 * Templates offered by the "Moby: Add Custom Model" quickPick. Kept in sync
 * with the `examples` array in package.json — package.json is the JSON-schema
 * source of truth for autocomplete, and these are the same templates surfaced
 * through a friendlier UX (no Ctrl+Space required).
 */
const CUSTOM_MODEL_TEMPLATES: Array<{
  label: string;
  description: string;
  detail: string;
  /** 'local' runs the service-location picker wizard after template selection
   *  so the user picks `localhost` vs `host.docker.internal` vs LAN instead
   *  of memorizing networking trivia. 'hosted' skips the picker and uses the
   *  template's baked-in URL verbatim (api.groq.com, api.openai.com, etc.). */
  endpointKind: 'local' | 'hosted';
  /** Default TCP port for the 'local' wizard. Ignored when endpointKind is
   *  'hosted'. Parsed from the template's `apiEndpoint` during setup. */
  defaultPort?: number;
  entry: Record<string, unknown>;
}> = [
  {
    label: 'Ollama — Qwen 2.5 Coder 7B',
    description: 'http://localhost:11434/v1',
    detail: 'Local Ollama with native tool calling',
    endpointKind: 'local',
    defaultPort: 11434,
    entry: {
      id: 'qwen2.5-coder:7b-instruct',
      name: 'Qwen 2.5 Coder 7B (Ollama)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 8192,
      maxTokensConfigKey: 'maxTokensCustomQwen',
      streaming: true,
      apiEndpoint: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      requestFormat: 'openai'
    }
  },
  {
    label: 'LM Studio (Local)',
    description: 'http://localhost:1234/v1',
    detail: 'Local LM Studio — replace `id` with your loaded model name',
    endpointKind: 'local',
    defaultPort: 1234,
    entry: {
      id: 'local-model-in-lm-studio',
      name: 'LM Studio (Local)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 4096,
      maxTokensConfigKey: 'maxTokensCustomLMStudio',
      streaming: true,
      apiEndpoint: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      requestFormat: 'openai'
    }
  },
  {
    label: 'llama.cpp Server',
    description: 'http://localhost:8080/v1',
    detail: 'Local llama.cpp — uses SEARCH/REPLACE for edits + <shell> for commands (R1-style)',
    endpointKind: 'local',
    defaultPort: 8080,
    entry: {
      id: 'local-llama-cpp',
      name: 'llama.cpp Server',
      toolCalling: 'none',
      reasoningTokens: 'none',
      editProtocol: ['search-replace'],
      shellProtocol: 'xml-shell',
      supportsTemperature: true,
      maxOutputTokens: 4096,
      maxTokensConfigKey: 'maxTokensCustomLlamaCpp',
      streaming: true,
      apiEndpoint: 'http://localhost:8080/v1',
      apiKey: 'llamacpp',
      requestFormat: 'openai'
    }
  },
  {
    label: 'OpenAI GPT-4o mini',
    description: 'https://api.openai.com/v1',
    detail: 'Hosted OpenAI — set API key via the settings popup',
    endpointKind: 'hosted',
    entry: {
      id: 'gpt-4o-mini',
      name: 'OpenAI GPT-4o mini',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 16384,
      maxTokensConfigKey: 'maxTokensCustomOpenAI',
      streaming: true,
      apiEndpoint: 'https://api.openai.com/v1',
      requestFormat: 'openai'
    }
  },
  {
    label: 'Kimi (Moonshot)',
    description: 'https://api.moonshot.ai/v1',
    detail: 'Hosted Moonshot — set API key via the settings popup',
    endpointKind: 'hosted',
    entry: {
      id: 'moonshot-v1-128k',
      name: 'Kimi (Moonshot)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 32768,
      maxTokensConfigKey: 'maxTokensCustomKimi',
      streaming: true,
      apiEndpoint: 'https://api.moonshot.ai/v1',
      requestFormat: 'openai'
    }
  },
  {
    label: 'Llama 3.3 70B (Groq)',
    description: 'https://api.groq.com/openai/v1',
    detail: 'Hosted Groq — fast inference, set API key via settings popup',
    endpointKind: 'hosted',
    entry: {
      id: 'llama-3.3-70b-versatile',
      name: 'Llama 3.3 70B (Groq)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 32768,
      maxTokensConfigKey: 'maxTokensCustomGroq',
      streaming: true,
      apiEndpoint: 'https://api.groq.com/openai/v1',
      requestFormat: 'openai'
    }
  }
];

/**
 * Command: surface a quickPick of common provider templates and either
 * insert the selected one into `moby.customModels` or open settings.json
 * for manual editing. Much friendlier than requiring users to know about
 * the `examples` array in the JSON schema.
 */
async function addCustomModel(): Promise<void> {
  const items = [
    ...CUSTOM_MODEL_TEMPLATES.map(t => ({
      label: t.label,
      description: t.description,
      detail: t.detail,
      template: t
    })),
    {
      label: '$(edit) Custom (edit JSON directly)',
      description: '',
      detail: 'Open settings.json to write your own entry from scratch',
      template: null as null | typeof CUSTOM_MODEL_TEMPLATES[number]
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a template to add a custom model, or edit JSON directly',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!pick) return;

  if (!pick.template) {
    // User chose to edit from scratch — drop them into the user settings
    // JSON file directly. Ctrl+F for `moby.customModels` to find the block.
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    return;
  }

  // Append the template entry to the existing array (or create one).
  const config = vscode.workspace.getConfiguration('moby');
  const existing = config.get<Array<Record<string, unknown>>>('customModels') ?? [];

  // Refuse if an entry with this id is already registered.
  if (existing.some(m => m?.id === pick.template!.entry.id)) {
    const answer = await vscode.window.showWarningMessage(
      `An entry with id "${pick.template.entry.id}" already exists in moby.customModels. Open settings.json to edit it?`,
      'Open settings.json',
      'Cancel'
    );
    if (answer === 'Open settings.json') {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    }
    return;
  }

  // For local-backend templates, run the location picker so the user picks
  // "same machine" / "Windows host (from WSL)" / "another machine" instead
  // of needing to know about host.docker.internal / localhost nuances. The
  // picker produces a URL; we splice it over the template's baked-in value.
  const entryWithEndpoint = { ...pick.template.entry };
  if (pick.template.endpointKind === 'local') {
    const defaultPort = pick.template.defaultPort ?? parsePortFromUrl(pick.template.entry.apiEndpoint as string) ?? 8080;
    const pathSuffix = parsePathFromUrl(pick.template.entry.apiEndpoint as string) ?? '/v1';
    const location = await pickServiceLocation({
      serviceName: pick.template.entry.name as string,
      defaultPort,
      pathSuffix
    });
    if (!location) return; // user cancelled
    entryWithEndpoint.apiEndpoint = resolveServiceUrl(location);
  }

  const updated = [...existing, entryWithEndpoint];
  await config.update('customModels', updated, vscode.ConfigurationTarget.Global);

  // Open settings.json so the user can see what was added and tweak fields
  // (e.g. LM Studio's `id` needs their actual loaded model name).
  await vscode.commands.executeCommand('workbench.action.openSettingsJson');

  vscode.window.showInformationMessage(
    `Added "${entryWithEndpoint.name}" to your custom models. ${entryWithEndpoint.apiKey ? 'Select it from the model dropdown to start using it.' : 'Set an API key via the settings popup, then pick it from the model dropdown.'}`
  );
}

/** Extract port from a URL, or null if parse fails / port not explicit. */
function parsePortFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/** Extract path (including leading slash) from a URL, or null on parse fail. */
function parsePathFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '' : u.pathname;
  } catch {
    return null;
  }
}

async function setTavilyApiKey(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get('moby.tavilyApiKey');
  const input = await vscode.window.showInputBox({
    prompt: current
      ? 'Enter a new Tavily API key, or clear the field to remove it'
      : 'Enter your Tavily API key (from tavily.com)',
    password: true,
    placeHolder: 'tvly-...',
    value: current ? '••••••••' : '',
    ignoreFocusOut: true
  });
  if (input === undefined) return; // user cancelled (Escape)
  if (input === '••••••••') return; // unchanged

  if (!input.trim()) {
    // Empty input — remove the key
    await context.secrets.delete('moby.tavilyApiKey');
    if (process.env.TAVILY_API_KEY) {
      vscode.window.showWarningMessage(
        'Tavily secret cleared, but the TAVILY_API_KEY environment variable is still set and will continue to satisfy the API key check. Unset it from your shell (and restart VS Code) to fully remove the key.'
      );
    } else {
      vscode.window.showInformationMessage('Tavily API key removed.');
    }
  } else {
    await context.secrets.store('moby.tavilyApiKey', input.trim());
    vscode.window.showInformationMessage('Tavily API key saved securely.');
  }
  chatProvider.refreshSettings();
}

async function setSearxngEndpoint(): Promise<void> {
  // Runs the location-picker wizard (covers same-machine / WSL-to-Windows /
  // LAN / custom URL) and writes the resolved URL into VS Code config. After
  // the write, fires a test-connection against the new endpoint so the user
  // gets immediate feedback rather than finding out the first real query
  // fails mid-turn.
  //
  // A final "clear endpoint" option is added to the picker pass-through
  // because users occasionally want to remove the setting without leaving
  // garbage behind. Picker cancellation leaves the current setting alone.
  const config = vscode.workspace.getConfiguration('moby');
  const current = (config.get<string>('webSearch.searxng.endpoint') || '').trim();

  // If there's already an endpoint set, offer a shortcut to clear it before
  // running the full picker. Otherwise jump straight to the picker.
  if (current) {
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Change endpoint', description: current, action: 'change' as const },
        { label: 'Clear endpoint', description: 'Remove the SearXNG URL from settings', action: 'clear' as const }
      ],
      {
        title: 'SearXNG endpoint',
        placeHolder: 'What would you like to do?',
        ignoreFocusOut: true
      }
    );
    if (!action) return;
    if (action.action === 'clear') {
      await config.update('webSearch.searxng.endpoint', '', vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('SearXNG endpoint cleared.');
      chatProvider.refreshSettings();
      return;
    }
  }

  const location = await pickServiceLocation({
    serviceName: 'SearXNG',
    defaultPort: 8080
    // SearXNG endpoint is the base URL — the client appends /search. No path suffix.
  });
  if (!location) return;

  const url = resolveServiceUrl(location).replace(/\/$/, '');
  await config.update('webSearch.searxng.endpoint', url, vscode.ConfigurationTarget.Global);

  // Test connection against the freshly-saved endpoint. The webSearchManager
  // reads the URL from config directly so the update above is already
  // visible; any race is a few ms at worst.
  const testResult = await chatProvider.testWebSearchProvider('searxng');
  if (testResult.success) {
    vscode.window.showInformationMessage(`SearXNG endpoint set to ${url}. ${testResult.message}`);
  } else {
    vscode.window.showWarningMessage(`SearXNG endpoint set to ${url}, but test failed: ${testResult.message}`);
  }
  chatProvider.refreshSettings();
}

async function manageEncryptionKey(context: vscode.ExtensionContext, cm: ConversationManager): Promise<void> {
  // Try SecretStorage first, fall back to file
  let current: string | undefined;
  try {
    current = await context.secrets.get(DB_KEY_SECRET);
  } catch {
    // SecretStorage unavailable — check file
    const keyPath = path.join(context.globalStorageUri.fsPath, DB_KEY_FALLBACK_FILE);
    try {
      current = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf-8').trim() : undefined;
    } catch { /* no key found */ }
  }

  const action = await vscode.window.showQuickPick([
    { label: '$(copy) Copy Current Key', description: 'Copy the encryption key to clipboard', id: 'copy' },
    { label: '$(edit) Set Custom Key', description: 'Re-encrypt database with your own key', id: 'set' },
    { label: '$(refresh) Generate New Key', description: 'Generate a random key and re-encrypt', id: 'generate' },
  ], {
    title: 'Database Encryption Key',
    // Don't leak any part of the key into the placeholder — even a prefix
    // narrows the search space and ends up in clipboard history / screen
    // recordings. Just confirm presence/absence.
    placeHolder: current ? 'Key is set (stored in SecretStorage)' : 'No key set',
  });

  if (!action) return;

  switch (action.id) {
    case 'copy': {
      if (current) {
        await vscode.env.clipboard.writeText(current);
        vscode.window.showInformationMessage('Encryption key copied to clipboard.');
      } else {
        vscode.window.showWarningMessage('No encryption key found.');
      }
      break;
    }
    case 'set': {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your encryption key (any passphrase, 16+ characters recommended)',
        placeHolder: 'Enter a strong passphrase...',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || !value.trim()) return 'Key cannot be empty';
          if (value.trim().length < 8) return 'Key must be at least 8 characters';
          return null;
        }
      });
      if (input) {
        const newKey = input.trim();
        try {
          const db = cm.getDatabase();
          db.pragma(`rekey='${newKey}'`);
          await storeEncryptionKey(context, newKey);
          vscode.window.showInformationMessage('Database re-encrypted with new key.');
          logger.info('Database encryption key changed by user');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to re-encrypt database: ${err.message}`);
          logger.error(`[EncryptionKey] Rekey failed: ${err.message}`);
        }
      }
      break;
    }
    case 'generate': {
      const confirm = await vscode.window.showWarningMessage(
        'Generate a new random encryption key? Make sure to copy it afterwards if you need to transfer your database.',
        { modal: true },
        'Generate'
      );
      if (confirm === 'Generate') {
        const newKey = crypto.randomBytes(32).toString('hex');
        try {
          const db = cm.getDatabase();
          db.pragma(`rekey='${newKey}'`);
          await storeEncryptionKey(context, newKey);
          await vscode.env.clipboard.writeText(newKey);
          vscode.window.showInformationMessage('New encryption key generated and copied to clipboard.');
          logger.info('Database encryption key regenerated by user');
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to re-encrypt database: ${err.message}`);
          logger.error(`[EncryptionKey] Rekey failed: ${err.message}`);
        }
      }
      break;
    }
  }
}

async function startDrawingServerCommand(): Promise<void> {
  if (drawingServer.isRunning) {
    const lanIP = DrawingServer.getLanIP();
    const url = `http://${lanIP || 'localhost'}:${drawingServer.port}`;
    vscode.window.showInformationMessage(`Drawing server already running: ${url}`);
    return;
  }
  try {
    const result = await drawingServer.start();

    if (result.isWSL) {
      // WSL2: phone can't reach the WSL internal IP directly
      const phoneUrl = result.phoneIP
        ? `http://${result.phoneIP}:${result.port}`
        : `http://<your-pc-ip>:${result.port}`;
      const choice = await vscode.window.showWarningMessage(
        `Drawing server running (WSL2 detected). Port forwarding needed. ` +
        `Copy the setup commands, run in admin PowerShell, then open ${phoneUrl} on your phone.`,
        'Copy Setup Commands',
        'Copy Phone URL'
      );
      if (choice === 'Copy Setup Commands' && result.portForwardCmd) {
        await vscode.env.clipboard.writeText(result.portForwardCmd);
        vscode.window.showInformationMessage('Setup commands copied. Run in an admin PowerShell on Windows.');
      } else if (choice === 'Copy Phone URL') {
        await vscode.env.clipboard.writeText(phoneUrl);
      }
    } else {
      const choice = await vscode.window.showInformationMessage(
        `Drawing server started. Open on your phone: ${result.url}`,
        'Copy URL'
      );
      if (choice === 'Copy URL') {
        await vscode.env.clipboard.writeText(result.url);
      }
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Drawing server failed: ${err.message}`);
  }
}

async function stopDrawingServerCommand(): Promise<void> {
  if (!drawingServer.isRunning) {
    vscode.window.showInformationMessage('Drawing server is not running.');
    return;
  }
  await drawingServer.stop();
  vscode.window.showInformationMessage('Drawing server stopped.');
}

/**
 * Export the current session as a test fixture (dev mode only).
 *
 * Saves the RichHistoryTurn[] data as JSON — the exact payload that
 * loadHistory sends to the webview. Used for deterministic Layer 2 tests.
 */
async function exportTestFixture(context: vscode.ExtensionContext): Promise<void> {
  const sessionId = chatProvider.getCurrentSessionId();
  if (!sessionId) {
    vscode.window.showWarningMessage('No active session to export.');
    return;
  }

  try {
    const history = await conversationManager.getSessionRichHistory(sessionId);
    if (history.length === 0) {
      vscode.window.showWarningMessage('Session has no messages to export.');
      return;
    }

    const json = JSON.stringify(history, null, 2);

    // Show save dialog
    const session = await conversationManager.getSession(sessionId);
    const defaultName = (session?.title || 'fixture')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      + '.fixture.json';

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? context.globalStorageUri,
        'tests', 'e2e', 'fixtures', defaultName
      ),
      filters: { 'JSON Fixture': ['json'] },
      title: 'Save Test Fixture'
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf-8'));
      vscode.window.showInformationMessage(`Test fixture saved: ${uri.fsPath}`);
      logger.info(`[DevMode] Exported test fixture: ${history.length} turns → ${uri.fsPath}`);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to export fixture: ${err.message}`);
    logger.error(`[DevMode] Export fixture failed: ${err.message}`);
  }
}

export function deactivate() {
  if (conversationManager) {
    conversationManager.dispose();
  }
  if (statusBar) {
    statusBar.dispose();
  }
  if (deepSeekClient) {
    deepSeekClient.dispose();
  }
  TokenService.resetInstance();
  logger.dispose();
}