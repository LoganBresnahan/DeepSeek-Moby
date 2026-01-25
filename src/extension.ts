import * as vscode from 'vscode';
import { DeepSeekClient } from './deepseekClient';
import { ChatProvider } from './providers/chatProvider';
import { CompletionProvider } from './providers/completionProvider';
import { CommandProvider } from './providers/commandProvider';
import { StatusBar } from './views/statusBar';
import { ConfigManager } from './utils/config';
import { ChatHistoryManager } from './chatHistory/ChatHistoryManager';
import { ChatHistoryViewProvider } from './views/ChatHistoryViewProvider';
import { logger } from './utils/logger';

let chatProvider: ChatProvider;
let completionProvider: CompletionProvider;
let commandProvider: CommandProvider;
let statusBar: StatusBar;
let deepSeekClient: DeepSeekClient;
let chatHistoryManager: ChatHistoryManager;
let chatHistoryViewProvider: ChatHistoryViewProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log('DeepSeek Moby extension is now active!');

  // Initialize configuration
  const config = ConfigManager.getInstance();
  
  // Initialize DeepSeek client
  deepSeekClient = new DeepSeekClient(context);
  
  // Initialize chat history manager
  chatHistoryManager = new ChatHistoryManager(context);
  
  // Initialize status bar
  statusBar = new StatusBar(context, deepSeekClient, chatHistoryManager);
  
  // Initialize chat provider (sidebar)
  chatProvider = new ChatProvider(
    context.extensionUri, 
    deepSeekClient, 
    statusBar,
    chatHistoryManager
  );
  
  // Initialize chat history view provider
  chatHistoryViewProvider = new ChatHistoryViewProvider(
    context.extensionUri,
    chatHistoryManager,
    chatProvider
  );
  
  // Initialize completion provider (inline suggestions)
  completionProvider = new CompletionProvider(deepSeekClient);
  
  // Initialize command provider (code actions)
  commandProvider = new CommandProvider(deepSeekClient, statusBar, chatHistoryManager);

  // Register providers
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    
    // Register chat history view
    vscode.window.registerWebviewViewProvider(
      ChatHistoryViewProvider.viewType,
      chatHistoryViewProvider,
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
  await checkApiKey();
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
    { name: 'showChatHistory', handler: () => chatHistoryViewProvider.reveal() },
    { name: 'exportChatHistory', handler: () => commandProvider.exportChatHistory() },
    { name: 'importChatHistory', handler: () => commandProvider.importChatHistory() },
    { name: 'clearChatHistory', handler: () => commandProvider.clearChatHistory() },
    { name: 'searchChatHistory', handler: () => commandProvider.searchChatHistory() },
    { name: 'exportCurrentSession', handler: () => commandProvider.exportCurrentSession() },
    { name: 'showStats', handler: () => chatHistoryViewProvider.showStatsModal() },
    { name: 'showLogs', handler: () => logger.show() }
  ];

  commands.forEach(({ name, handler }) => {
    const disposable = vscode.commands.registerCommand(`deepseek.${name}`, handler);
    context.subscriptions.push(disposable);
  });
}

async function checkApiKey() {
  const config = vscode.workspace.getConfiguration('deepseek');
  const apiKey = config.get<string>('apiKey');
  
  if (!apiKey) {
    const result = await vscode.window.showInformationMessage(
      'DeepSeek Moby: API key is not set. Would you like to configure it now?',
      'Configure', 'Later'
    );
    
    if (result === 'Configure') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek.apiKey');
    }
  }
}

export function deactivate() {
  if (statusBar) {
    statusBar.dispose();
  }
  if (deepSeekClient) {
    deepSeekClient.dispose();
  }
  logger.dispose();
}