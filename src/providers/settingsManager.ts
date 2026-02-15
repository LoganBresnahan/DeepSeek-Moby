/**
 * SettingsManager — Owns settings read/write/sync with VS Code configuration.
 *
 * Extracted from ChatProvider (Phase 4 of ChatProvider refactor).
 * Communicates via vscode.EventEmitter — ChatProvider subscribes to events
 * and forwards them to the webview via postMessage.
 *
 * No state variables live here — settings are read on-demand from
 * vscode.workspace.getConfiguration('deepseek'). This class consolidates
 * the 12 settings methods and provides a clean event-based interface.
 */

import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';
import { SettingsSnapshot } from './types';

/** Payload for model change events */
export interface ModelChangedEvent {
  model: string;
}

/** Payload for default system prompt requests */
export interface DefaultPromptEvent {
  model: string;
  prompt: string;
}

/** Input for updateSettings() */
export interface SettingsUpdateInput {
  model?: string;
  temperature?: number;
  maxToolCalls?: number;
  maxShellIterations?: number;
  maxTokens?: number;
  autoSaveHistory?: boolean;
}

export class SettingsManager {
  // ── Events ──

  private readonly _onSettingsChanged = new vscode.EventEmitter<SettingsSnapshot>();
  private readonly _onModelChanged = new vscode.EventEmitter<ModelChangedEvent>();
  private readonly _onDefaultPromptRequested = new vscode.EventEmitter<DefaultPromptEvent>();
  private readonly _onSettingsReset = new vscode.EventEmitter<void>();

  readonly onSettingsChanged = this._onSettingsChanged.event;
  readonly onModelChanged = this._onModelChanged.event;
  readonly onDefaultPromptRequested = this._onDefaultPromptRequested.event;
  readonly onSettingsReset = this._onSettingsReset.event;

  constructor(private deepSeekClient: DeepSeekClient) {}

  // ── Public Methods ──

  /**
   * Update core model/generation settings.
   * Persists to VS Code config and fires onSettingsChanged + onModelChanged as appropriate.
   */
  async updateSettings(settings: SettingsUpdateInput): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.model !== undefined) {
      // Set model immediately on client (VS Code config has propagation delay)
      this.deepSeekClient.setModel(settings.model);
      await config.update('model', settings.model, vscode.ConfigurationTarget.Global);
      logger.modelChanged(settings.model);
      this._onModelChanged.fire({ model: settings.model });
      // Sync full settings back so token limits, temperature etc. stay in sync
      this._onSettingsChanged.fire(this.getCurrentSettings());
    }

    if (settings.temperature !== undefined) {
      await config.update('temperature', settings.temperature, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('temperature', settings.temperature);
    }

    if (settings.maxToolCalls !== undefined) {
      await config.update('maxToolCalls', settings.maxToolCalls, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxToolCalls', settings.maxToolCalls);
    }

    if (settings.maxShellIterations !== undefined) {
      await config.update('maxShellIterations', settings.maxShellIterations, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxShellIterations', settings.maxShellIterations);
    }

    if (settings.maxTokens !== undefined) {
      await config.update('maxTokens', settings.maxTokens, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxTokens', settings.maxTokens);
    }

    if (settings.autoSaveHistory !== undefined) {
      await config.update('autoSaveHistory', settings.autoSaveHistory, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('autoSaveHistory', settings.autoSaveHistory);
    }
  }

  /**
   * Update log-related settings (logLevel, logColors).
   */
  async updateLogSettings(settings: { logLevel?: string; logColors?: boolean }): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.logLevel !== undefined) {
      await config.update('logLevel', settings.logLevel, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('logLevel', settings.logLevel);
    }

    if (settings.logColors !== undefined) {
      await config.update('logColors', settings.logColors, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('logColors', settings.logColors);
    }
  }

  /**
   * Update webview log level setting.
   * Fires onSettingsChanged so webview can apply the new log level immediately.
   */
  async updateWebviewLogSettings(settings: { webviewLogLevel?: string }): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.webviewLogLevel !== undefined) {
      await config.update('webviewLogLevel', settings.webviewLogLevel, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('webviewLogLevel', settings.webviewLogLevel);
      // Send settings back to webview so it applies the new log level immediately
      this._onSettingsChanged.fire(this.getCurrentSettings());
    }
  }

  /**
   * Update tracing enabled/disabled setting.
   * Also updates the tracer directly for immediate effect.
   */
  async updateTracingSettings(settings: { enabled?: boolean }): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.enabled !== undefined) {
      await config.update('tracing.enabled', settings.enabled, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('tracing.enabled', settings.enabled);
      // Also update the tracer directly
      tracer.enabled = settings.enabled;
    }
  }

  /**
   * Update reasoner-specific settings (allowAllShellCommands).
   */
  async updateReasonerSettings(settings: { allowAllCommands?: boolean }): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.allowAllCommands !== undefined) {
      await config.update('allowAllShellCommands', settings.allowAllCommands, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('allowAllShellCommands', settings.allowAllCommands ? 'enabled (Wild Side)' : 'disabled');
    }
  }

  /**
   * Update the system prompt.
   */
  async updateSystemPrompt(prompt: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('deepseek');
    await config.update('systemPrompt', prompt, vscode.ConfigurationTarget.Global);
    logger.settingsChanged('systemPrompt', prompt ? `${prompt.substring(0, 50)}...` : '(default)');
  }

  /**
   * Get the default system prompt for the current model and fire an event.
   */
  sendDefaultSystemPrompt(): void {
    const config = vscode.workspace.getConfiguration('deepseek');
    const model = config.get<string>('model') || 'deepseek-chat';
    const isReasoner = model.includes('reasoner');

    const prompt = isReasoner
      ? this.getReasonerDefaultPrompt()
      : this.getChatDefaultPrompt();

    this._onDefaultPromptRequested.fire({
      model: isReasoner ? 'DeepSeek Reasoner (R1)' : 'DeepSeek Chat',
      prompt
    });
  }

  /**
   * Read all current settings from VS Code config and return a snapshot.
   * Also syncs tracer.enabled to match config.
   */
  getCurrentSettings(): SettingsSnapshot {
    const config = vscode.workspace.getConfiguration('deepseek');
    const tracingEnabled = config.get<boolean>('tracing.enabled') ?? true;

    // Sync tracer enabled state
    tracer.enabled = tracingEnabled;

    return {
      model: config.get<string>('model') || 'deepseek-chat',
      temperature: config.get<number>('temperature') ?? 0.7,
      maxToolCalls: config.get<number>('maxToolCalls') ?? 100,
      maxShellIterations: config.get<number>('maxShellIterations') ?? 100,
      maxTokens: config.get<number>('maxTokens') ?? 8192,
      logLevel: config.get<string>('logLevel') || 'WARN',
      webviewLogLevel: config.get<string>('webviewLogLevel') || 'WARN',
      tracingEnabled,
      logColors: config.get<boolean>('logColors') ?? true,
      systemPrompt: config.get<string>('systemPrompt') || '',
      autoSaveHistory: config.get<boolean>('autoSaveHistory') ?? true,
      allowAllCommands: config.get<boolean>('allowAllShellCommands') ?? false,
      webSearch: {
        searchDepth: 'basic',
        creditsPerPrompt: 1,
        maxResultsPerSearch: 5,
        cacheDuration: 15
      }
    };
  }

  /**
   * Reset all settings to their defaults.
   * Clears VS Code config, resets tracer and logger, fires onSettingsReset.
   */
  async resetToDefaults(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('deepseek');

      // Reset all settings to defaults
      await config.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
      await config.update('webviewLogLevel', undefined, vscode.ConfigurationTarget.Global);
      await config.update('tracing.enabled', undefined, vscode.ConfigurationTarget.Global);
      await config.update('logColors', undefined, vscode.ConfigurationTarget.Global);
      await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxTokens', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxToolCalls', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxShellIterations', undefined, vscode.ConfigurationTarget.Global);
      await config.update('editMode', undefined, vscode.ConfigurationTarget.Global);
      await config.update('autoSaveHistory', undefined, vscode.ConfigurationTarget.Global);

      // Reset tracer to enabled
      tracer.enabled = true;

      // Reset logger
      logger.minLevel = 'INFO';

      logger.info('[SettingsManager] Settings reset to defaults');

      // Fire events
      this._onSettingsChanged.fire(this.getCurrentSettings());
      this._onSettingsReset.fire();
    } catch (error) {
      logger.error(`[SettingsManager] Failed to reset settings: ${error}`);
    }
  }

  // ── Private Methods ──

  private getChatDefaultPrompt(): string {
    return `You are a highly capable AI programming assistant integrated into VS Code. Your role is to help developers write, understand, and improve code.

Key capabilities:
- Analyze code and explain its functionality
- Help debug issues and suggest fixes
- Write new code following best practices
- Refactor and optimize existing code
- Answer programming questions

When providing code changes, use the SEARCH/REPLACE format for precise edits.

Always be concise, accurate, and helpful.`;
  }

  private getReasonerDefaultPrompt(): string {
    return `You are a highly capable AI programming assistant with shell access for exploring and modifying codebases.

You can run shell commands using <shell> tags:
<shell>cat src/file.ts</shell>
<shell>grep -rn "function" src/</shell>

To create new files, use shell commands:
<shell>cat > path/to/newfile.ts << 'EOF'
// file contents
EOF</shell>

To edit existing files, use the SEARCH/REPLACE format:
\`\`\`typescript
# File: path/to/file.ts
<<<<<<< SEARCH
exact code to find
======= AND
replacement code
>>>>>>> REPLACE
\`\`\`

Always:
1. Explore the codebase first using shell commands
2. Create new files with shell commands (cat > file << 'EOF')
3. Edit existing files with SEARCH/REPLACE
4. Complete tasks in a single response`;
  }

  /**
   * Dispose all event emitters.
   */
  dispose(): void {
    this._onSettingsChanged.dispose();
    this._onModelChanged.dispose();
    this._onDefaultPromptRequested.dispose();
    this._onSettingsReset.dispose();
  }
}
