import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { ConfigManager } from '../utils/config';
import { ChatHistoryManager } from '../chatHistory/ChatHistoryManager';

export class StatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private deepSeekClient: DeepSeekClient;
  private chatHistoryManager: ChatHistoryManager;
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private totalTokens: number = 0;

  constructor(context: vscode.ExtensionContext, deepSeekClient: DeepSeekClient, chatHistoryManager: ChatHistoryManager) {
    this.context = context;
    this.deepSeekClient = deepSeekClient;
    this.chatHistoryManager = chatHistoryManager;
    this.config = ConfigManager.getInstance();
    
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    
    this.statusBarItem.tooltip = 'DeepSeek Moby - Click to open chat';
    this.statusBarItem.command = 'deepseek.startChat';
    
    this.loadTokenCount();
  }

  start() {
    if (this.config.get<boolean>('showStatusBar')) {
      this.update();
      this.statusBarItem.show();
    }
  }

  async update() {
    const model = this.config.get<string>('model') || 'deepseek-chat';
    
    // Get stats from chat history
    const stats = await this.chatHistoryManager.getSessionStats();
    this.totalTokens = stats.totalTokens;
    
    this.statusBarItem.text = `$(robot) DeepSeek Moby ${model} | $(pulse) ${this.totalTokens.toLocaleString()} tokens`;
    this.statusBarItem.tooltip = `DeepSeek Moby\nModel: ${model}\nTotal Tokens: ${this.totalTokens.toLocaleString()}\nTotal Sessions: ${stats.totalSessions}\nTotal Messages: ${stats.totalMessages}`;
  }

  updateModel(model: string) {
    this.statusBarItem.text = `$(robot) DeepSeek Moby ${model}`;
  }

  async updateLastResponse() {
    // Update stats from chat history
    const stats = await this.chatHistoryManager.getSessionStats();
    this.totalTokens = stats.totalTokens;
    this.saveTokenCount();
    await this.update();
  }

  resetTokenCount() {
    this.totalTokens = 0;
    this.saveTokenCount();
    this.update();
  }

  private saveTokenCount() {
    this.context.globalState.update('totalTokens', this.totalTokens);
  }

  private loadTokenCount() {
    const saved = this.context.globalState.get<number>('totalTokens');
    if (saved !== undefined) {
      this.totalTokens = saved;
    }
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}