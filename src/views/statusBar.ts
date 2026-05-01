import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { ConfigManager } from '../utils/config';
import { ConversationManager } from '../events';
import { DEFAULT_MODEL_ID } from '../models/registry';

export class StatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private deepSeekClient: DeepSeekClient;
  private conversationManager: ConversationManager;
  private config: ConfigManager;
  private totalTokens: number = 0;

  constructor(deepSeekClient: DeepSeekClient, conversationManager: ConversationManager) {
    this.deepSeekClient = deepSeekClient;
    this.conversationManager = conversationManager;
    this.config = ConfigManager.getInstance();

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    this.statusBarItem.tooltip = 'DeepSeek Moby - Click to open chat';
    this.statusBarItem.command = 'moby.startChat';
  }

  start() {
    if (this.config.get<boolean>('showStatusBar')) {
      this.update();
      this.statusBarItem.show();
    }
  }

  async update() {
    const model = this.config.get<string>('model') || DEFAULT_MODEL_ID;

    // Get stats from chat history
    const stats = await this.conversationManager.getSessionStats();
    this.totalTokens = stats.totalTokens;

    this.statusBarItem.text = `$(robot) ${this.totalTokens.toLocaleString()} tk`;
    this.statusBarItem.tooltip = `DeepSeek Moby\nModel: ${model}\nTotal Tokens: ${this.totalTokens.toLocaleString()}\nTotal Sessions: ${stats.totalSessions}\nTotal Messages: ${stats.totalMessages}`;
  }

  updateModel(_model: string) {
    // Model name no longer in the status bar text — refresh tooltip via update().
    void this.update();
  }

  async updateLastResponse() {
    await this.update();
  }

  resetTokenCount() {
    this.totalTokens = 0;
    this.update();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
