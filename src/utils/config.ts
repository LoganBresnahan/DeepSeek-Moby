import * as vscode from 'vscode';

export class ConfigManager {
  private static instance: ConfigManager;

  private constructor() {}

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  // Get fresh config on each access to avoid stale cached values
  private getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('deepseek');
  }

  get<T>(key: string): T | undefined {
    return this.getConfig().get<T>(key);
  }

  async update(key: string, value: any, target?: vscode.ConfigurationTarget) {
    await this.getConfig().update(key, value, target);
  }

  getApiKey(): string | undefined {
    return this.get<string>('apiKey');
  }

  getModel(): string {
    return this.get<string>('model') || 'deepseek-chat';
  }

  shouldAutoFormat(): boolean {
    return this.get<boolean>('autoFormat') ?? true;
  }
}
