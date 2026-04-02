import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConfigManager } from '../utils/config';
import { ConversationManager } from '../events';


export class CommandProvider {
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private config: ConfigManager;
  private conversationManager: ConversationManager;
  private getCurrentSessionId: () => string | null;

  constructor(
    deepSeekClient: DeepSeekClient,
    statusBar: StatusBar,
    conversationManager: ConversationManager,
    getCurrentSessionId: () => string | null
  ) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.config = ConfigManager.getInstance();
    this.conversationManager = conversationManager;
    this.getCurrentSessionId = getCurrentSessionId;
  }

  // Chat History Commands

  async switchModel() {
    const currentModel = this.config.get<string>('model');
    const newModel = currentModel === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';

    // Set model immediately on client (VS Code config has propagation delay)
    this.deepSeekClient.setModel(newModel);
    await this.config.update('model', newModel);

    vscode.window.showInformationMessage(`Switched to ${newModel} model`);
    this.statusBar.updateModel(newModel);
  }

  // Chat History Commands
  async exportChatHistory() {
    const format = await vscode.window.showQuickPick(
      ['JSON', 'Markdown', 'Text'],
      { placeHolder: 'Select export format' }
    );
    
    if (!format) return;
    
    const formatLower = format.toLowerCase() as 'json' | 'markdown' | 'txt';
    const content = await this.conversationManager.exportAllSessions(formatLower);
    
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: formatLower === 'json' ? 'json' : formatLower === 'markdown' ? 'markdown' : 'plaintext'
    });
    
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Chat history exported as ${format}`);
  }

  async importChatHistory() {
    const fileUri = await vscode.window.showOpenDialog({
      filters: { 'JSON Files': ['json'] },
      canSelectMany: false
    });
    
    if (!fileUri || fileUri.length === 0) return;
    
    try {
      const fileContent = await vscode.workspace.fs.readFile(fileUri[0]);
      const content = Buffer.from(fileContent).toString('utf8');
      
      const session = await this.conversationManager.importSession(content);
      if (session) {
        vscode.window.showInformationMessage(`Chat session "${session.title}" imported successfully`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to import chat history: ${error.message}`);
    }
  }

  async clearChatHistory() {
    const result = await vscode.window.showWarningMessage(
      'Delete ALL chat history? This cannot be undone.',
      { modal: true },
      'Delete All',
      'Cancel'
    );

    if (result === 'Delete All') {
      await this.conversationManager.clearAllHistory();
      vscode.window.showInformationMessage('All chat history deleted');
    }
  }

  async searchChatHistory() {
    const query = await vscode.window.showInputBox({
      prompt: 'Search chat history',
      placeHolder: 'Enter search keywords'
    });

    if (!query) return;

    const sessions = await this.conversationManager.searchHistory(query);

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No matching chat sessions found');
      return;
    }

    const items = sessions.map(session => ({
      label: session.title,
      description: `${session.eventCount} events`,
      detail: session.lastActivityPreview || session.firstUserMessage || '',
      session
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a chat session to open'
    });

    if (selected) {
      vscode.commands.executeCommand('moby.showChatHistory');
    }
  }

  async exportCurrentSession() {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      vscode.window.showWarningMessage('No active chat session');
      return;
    }
    const currentSession = await this.conversationManager.getSession(sessionId);
    if (!currentSession) {
      vscode.window.showWarningMessage('No active chat session');
      return;
    }

    const content = await this.conversationManager.exportSession(currentSession.id);

    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'json'
    });

    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Session "${currentSession.title}" exported`);
  }

}