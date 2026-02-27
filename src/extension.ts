import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { ChatProvider } from './providers/chatProvider';
import { CompletionProvider } from './providers/completionProvider';
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
let completionProvider: CompletionProvider;
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

  // Initialize completion provider (inline suggestions)
  completionProvider = new CompletionProvider(deepSeekClient);
  
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

  // Register inline completions if enabled
  if (config.get<boolean>('enableCompletions')) {
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        completionProvider
      )
    );
  }

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
    { name: 'explainCode', handler: () => commandProvider.explainCode() },
    { name: 'refactorCode', handler: () => commandProvider.refactorCode() },
    { name: 'documentCode', handler: () => commandProvider.documentCode() },
    { name: 'fixBugs', handler: () => commandProvider.fixBugs() },
    { name: 'optimizeCode', handler: () => commandProvider.optimizeCode() },
    { name: 'generateTests', handler: () => commandProvider.generateTests() },
    { name: 'clearConversation', handler: () => chatProvider.clearConversation() },
    { name: 'newChat', handler: () => chatProvider.clearConversation() },
    { name: 'switchModel', handler: () => commandProvider.switchModel() },
    { name: 'insertCode', handler: () => commandProvider.insertCode() },
    
    // Chat History Commands
    { name: 'showChatHistory', handler: () => chatProvider.openHistoryModal() },
    { name: 'openCommandRules', handler: () => chatProvider.openRulesModal() },
    { name: 'exportChatHistory', handler: () => commandProvider.exportChatHistory() },
    { name: 'importChatHistory', handler: () => commandProvider.importChatHistory() },
    { name: 'clearChatHistory', handler: () => commandProvider.clearChatHistory() },
    { name: 'searchChatHistory', handler: () => chatProvider.openHistoryModal() },
    { name: 'exportCurrentSession', handler: () => commandProvider.exportCurrentSession() },
    { name: 'showStats', handler: () => chatProvider.showStats() },
    { name: 'showLogs', handler: () => logger.show() },

    // Trace Export Commands
    { name: 'exportTrace', handler: () => commandProvider.exportTraceToFile() },
    { name: 'copyTrace', handler: () => commandProvider.copyTraceToClipboard() },
    { name: 'viewTrace', handler: () => commandProvider.viewTraceInOutput() },
    { name: 'clearTrace', handler: () => commandProvider.clearTraces() },
    { name: 'traceStats', handler: () => commandProvider.showTraceStats() },

    // Unified Log Export Commands
    { name: 'exportLogsAI', handler: () => UnifiedLogExporter.exportForAI() },
    { name: 'exportLogsHuman', handler: () => UnifiedLogExporter.exportForHuman() },

    // Diff quick pick command
    { name: 'showDiffQuickPick', handler: async () => {
      await chatProvider.showDiffQuickPick();
    }},

    // Drawing Server
    { name: 'startDrawingServer', handler: () => startDrawingServerCommand() },
    { name: 'stopDrawingServer', handler: () => stopDrawingServerCommand() },

    // API Key management
    { name: 'setApiKey', handler: () => setApiKey(context) },
    { name: 'setTavilyApiKey', handler: () => setTavilyApiKey(context) }
  ];

  commands.forEach(({ name, handler }) => {
    const disposable = vscode.commands.registerCommand(`deepseek.${name}`, handler);
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
  const apiKey = await context.secrets.get('deepseek.apiKey');

  if (!apiKey) {
    const result = await vscode.window.showInformationMessage(
      'DeepSeek Moby: API key is not set. Would you like to configure it now?',
      'Configure', 'Later'
    );

    if (result === 'Configure') {
      vscode.commands.executeCommand('deepseek.setApiKey');
    }
  }
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get('deepseek.apiKey');
  const input = await vscode.window.showInputBox({
    prompt: 'Enter your DeepSeek API key (from platform.deepseek.com)',
    password: true,
    placeHolder: 'sk-...',
    value: current ? '••••••••' : '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !value.trim()) { return 'API key cannot be empty'; }
      if (value === '••••••••') { return null; } // unchanged
      return null;
    }
  });
  if (input && input !== '••••••••') {
    await context.secrets.store('deepseek.apiKey', input.trim());
    vscode.window.showInformationMessage('DeepSeek API key saved securely.');
  }
}

async function setTavilyApiKey(context: vscode.ExtensionContext): Promise<void> {
  const current = await context.secrets.get('deepseek.tavilyApiKey');
  const input = await vscode.window.showInputBox({
    prompt: 'Enter your Tavily API key (from tavily.com)',
    password: true,
    placeHolder: 'tvly-...',
    value: current ? '••••••••' : '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !value.trim()) { return 'API key cannot be empty'; }
      if (value === '••••••••') { return null; }
      return null;
    }
  });
  if (input && input !== '••••••••') {
    await context.secrets.store('deepseek.tavilyApiKey', input.trim());
    vscode.window.showInformationMessage('Tavily API key saved securely.');
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