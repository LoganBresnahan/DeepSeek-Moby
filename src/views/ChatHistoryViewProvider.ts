import * as vscode from 'vscode';
import { ChatHistoryManager } from '../chatHistory/ChatHistoryManager';
import { ChatProvider } from '../providers/chatProvider';
import { DeepSeekClient } from '../deepseekClient';

export class ChatHistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-history-view';
  private _view?: vscode.WebviewView;
  private chatHistoryManager: ChatHistoryManager;
  private chatProvider: ChatProvider;
  private deepSeekClient: DeepSeekClient;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    chatHistoryManager: ChatHistoryManager,
    chatProvider: ChatProvider,
    deepSeekClient: DeepSeekClient
  ) {
    this.chatHistoryManager = chatHistoryManager;
    this.chatProvider = chatProvider;
    this.deepSeekClient = deepSeekClient;
    
    // Listen for session changes
    this.chatHistoryManager.onSessionsChangedEvent(() => {
      this.refreshHistory();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'loadSessions':
          await this.loadSessions();
          break;
        case 'switchToSession':
          await this.switchToSession(data.sessionId);
          break;
        case 'deleteSession':
          await this.deleteSession(data.sessionId);
          break;
        case 'renameSession':
          await this.renameSession(data.sessionId, data.newTitle);
          break;
        case 'requestRename':
          await this.requestRename(data.sessionId, data.currentTitle);
          break;
        case 'exportSession':
          await this.exportSession(data.sessionId, data.format || 'json');
          break;
        case 'searchSessions':
          await this.searchSessions(data.query);
          break;
        case 'clearAllHistory':
          await this.clearAllHistory();
          break;
        case 'exportAllHistory':
          await this.exportAllHistory(data.format);
          break;
        case 'getStats':
          await this.getStats();
          break;
      }
    });

    // Initial load
    this.loadSessions();
  }

  public reveal() {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  private async loadSessions() {
    const sessions = await this.chatHistoryManager.getAllSessions();
    if (this._view) {
      this._view.webview.postMessage({
        type: 'sessionsLoaded',
        sessions
      });
    }
  }

  private async switchToSession(sessionId: string) {
    await this.chatHistoryManager.switchToSession(sessionId);

    // Load the session into the chat view
    await this.chatProvider.loadSession(sessionId);

    // Reveal the chat panel
    this.chatProvider.reveal();

    // Notify history view of the switch
    if (this._view) {
      this._view.webview.postMessage({
        type: 'sessionSwitched',
        sessionId
      });
    }
  }

  private async deleteSession(sessionId: string) {
    const result = await vscode.window.showWarningMessage(
      'Delete this chat session?',
      { modal: true },
      'Delete',
      'Cancel'
    );
    
    if (result === 'Delete') {
      await this.chatHistoryManager.deleteSession(sessionId);
      vscode.window.showInformationMessage('Session deleted');
    }
  }

  private async renameSession(sessionId: string, newTitle: string) {
    await this.chatHistoryManager.renameSession(sessionId, newTitle);
  }

  private async requestRename(sessionId: string, currentTitle: string) {
    const newTitle = await vscode.window.showInputBox({
      prompt: 'Enter new title for this chat',
      value: currentTitle,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Title cannot be empty';
        }
        return null;
      }
    });

    if (newTitle && newTitle !== currentTitle) {
      await this.renameSession(sessionId, newTitle);
    }
  }

  private async exportSession(sessionId: string, format: 'json' | 'markdown' | 'txt' = 'json') {
    const content = await this.chatHistoryManager.exportSession(sessionId, format);
    const language = format === 'json' ? 'json' : format === 'markdown' ? 'markdown' : 'plaintext';
    const doc = await vscode.workspace.openTextDocument({
      content,
      language
    });
    await vscode.window.showTextDocument(doc);
  }

  private async searchSessions(query: string) {
    const sessions = await this.chatHistoryManager.searchHistory(query);
    if (this._view) {
      this._view.webview.postMessage({
        type: 'searchResults',
        sessions,
        query
      });
    }
  }

  private async clearAllHistory() {
    const result = await vscode.window.showWarningMessage(
      'Delete ALL chat history? This will also clear your current chat.',
      { modal: true },
      'Delete All',
      'Cancel'
    );

    if (result === 'Delete All') {
      await this.chatHistoryManager.clearAllHistory();
      // Also clear the current chat in the chat view
      await this.chatProvider.clearConversation();
      vscode.window.showInformationMessage('All chat history deleted');
    }
  }

  private async exportAllHistory(format: 'json' | 'markdown' | 'txt') {
    const content = await this.chatHistoryManager.exportAllSessions(format);
    const language = format === 'json' ? 'json' : format === 'markdown' ? 'markdown' : 'plaintext';
    
    const doc = await vscode.workspace.openTextDocument({
      content,
      language
    });
    await vscode.window.showTextDocument(doc);
  }

  private async getStats() {
    const stats = await this.chatHistoryManager.getSessionStats();

    // Fetch balance from DeepSeek API
    let balance = null;
    try {
      balance = await this.deepSeekClient.getBalance();
    } catch (e) {
      // Silently fail if balance fetch fails
    }

    if (this._view) {
      this._view.webview.postMessage({
        type: 'statsLoaded',
        stats,
        balance
      });
    }
  }

  public async showStatsModal() {
    // Reveal the history view first to ensure webview is available
    this.reveal();

    // Get stats and send to webview
    await this.getStats();
  }

  private refreshHistory() {
    this.loadSessions();
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'history.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'history.css')
    );

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Chat History</title>
        <link href="${styleUri}" rel="stylesheet">
      </head>
      <body>
        <div class="history-container">
          <div class="header">
            <h2>Chat History</h2>
            <div class="actions">
              <button id="exportAllBtn" title="Export All">Export</button>
              <button id="clearAllBtn" title="Delete All">Delete All</button>
            </div>
          </div>

          <div class="search-box">
            <input type="text" id="searchInput" placeholder="Search chats...">
          </div>

          <div id="sessionsList" class="sessions-list"></div>
        </div>
        
        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}