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

  // Check API key
  await checkApiKey(context);
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
    { name: 'manageEncryptionKey', handler: () => manageEncryptionKey(context, conversationManager) }
  ];

  commands.forEach(({ name, handler }) => {
    const disposable = vscode.commands.registerCommand(`moby.${name}`, handler);
    context.subscriptions.push(disposable);
  });
}

const DB_KEY_SECRET = 'deepseek-moby.db-encryption-key';

async function getOrCreateEncryptionKey(context: vscode.ExtensionContext): Promise<string> {
  let key = await context.secrets.get(DB_KEY_SECRET);
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(DB_KEY_SECRET, key);
    logger.info('Generated new database encryption key');
  }
  return key;
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
  const current = await context.secrets.get(DB_KEY_SECRET);

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
          await context.secrets.store(DB_KEY_SECRET, newKey);
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
          await context.secrets.store(DB_KEY_SECRET, newKey);
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