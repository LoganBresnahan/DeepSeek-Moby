import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { ChatProvider } from './providers/chatProvider';
import { CommandProvider } from './providers/commandProvider';
import { StatusBar } from './views/statusBar';
import { ConfigManager } from './utils/config';
import { ConversationManager, createLLMSummarizer } from './events';
import { TavilyClient } from './clients/tavilyClient';
import { logger } from './utils/logger';
import { UnifiedLogExporter } from './logging/UnifiedLogExporter';
import { TokenService } from './services/tokenService';
import { DrawingServer } from './providers/drawingServer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

let chatProvider: ChatProvider;
let commandProvider: CommandProvider;
let statusBar: StatusBar;
let deepSeekClient: DeepSeekClient;
let conversationManager: ConversationManager;
let tavilyClient: TavilyClient;
let drawingServer: DrawingServer;

export async function activate(context: vscode.ExtensionContext) {
  logger.info('DeepSeek Moby extension activated');

  // Initialize configuration
  const config = ConfigManager.getInstance();
  
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

  // Initialize Tavily client for web search
  tavilyClient = new TavilyClient(context);

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
    tavilyClient,
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

    // Database encryption key
    { name: 'manageEncryptionKey', handler: () => manageEncryptionKey(context, conversationManager) },

    // Diff editor toolbar actions
    { name: 'acceptActiveDiff', handler: () => chatProvider.acceptActiveDiff() },
    { name: 'rejectActiveDiff', handler: () => chatProvider.rejectActiveDiff() }
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
  }
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
    vscode.window.showInformationMessage('DeepSeek API key removed.');
  } else {
    await context.secrets.store('moby.apiKey', input.trim());
    vscode.window.showInformationMessage('DeepSeek API key saved securely.');
  }
  chatProvider.refreshSettings();
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
    vscode.window.showInformationMessage('Tavily API key removed.');
  } else {
    await context.secrets.store('moby.tavilyApiKey', input.trim());
    vscode.window.showInformationMessage('Tavily API key saved securely.');
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
    placeHolder: current ? `Current key: ${current.substring(0, 8)}...` : 'No key set',
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