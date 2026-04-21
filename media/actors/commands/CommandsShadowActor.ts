/**
 * CommandsShadowActor
 *
 * Shadow DOM actor for the commands dropdown menu.
 * Provides quick access to extension commands like New Chat,
 * History, Export, etc.
 *
 * Publications:
 * - commands.popup.visible: boolean - whether the popup is open
 *
 * Subscriptions:
 * - commands.popup.open: boolean - request to open/close popup
 */

import { PopupShadowActor, PopupConfig } from '../../state/PopupShadowActor';
import { EventStateManager } from '../../state/EventStateManager';
import type { VSCodeAPI } from '../../state/types';
import { commandsShadowStyles } from './shadowStyles';
import { createLogger } from '../../logging';
import { webviewTracer } from '../../tracing';

const log = createLogger('CommandsPopup');

// ============================================
// Types
// ============================================

export interface CommandItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  shortcut?: string;
  section?: string;
}

export type CommandHandler = (commandId: string) => void;

// ============================================
// Default Commands
// ============================================

const DEFAULT_COMMANDS: CommandItem[] = [
  // History section
  { id: 'moby.exportChatHistory', name: 'Export History', description: 'Export all chats', icon: '📤', section: 'History' },
  // Logs section
  { id: 'moby.exportLogs', name: 'Export Logs', description: 'Export all logs and traces', icon: '📝', section: 'Logs' },
  // Settings section
  { id: 'moby.editSystemPrompt', name: 'System Prompt', description: 'Edit system prompt', icon: '✏️', section: 'Settings' },
  { id: 'moby.openCommandRules', name: 'System Rules', description: 'Manage command approval rules', icon: '🛡️', section: 'Settings' },
  // Info section
  { id: 'moby.showStats', name: 'Account Stats', description: 'DeepSeek & Tavily usage', icon: '📊', section: 'Info' }
];

// ============================================
// CommandsShadowActor
// ============================================

export class CommandsShadowActor extends PopupShadowActor {
  private _commands: CommandItem[];
  private _onCommand: CommandHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
    // Build command list — include dev commands when devMode is enabled
    const isDevMode = document.body.getAttribute('data-dev-mode') === 'true';
    const commands = [...DEFAULT_COMMANDS];
    if (isDevMode) {
      commands.push(
        { id: 'moby.exportTestFixture', name: 'Export Test Fixture', description: 'Export session for testing', icon: '🧪', section: 'Dev' },
        { id: 'moby.exportTurnAsJson', name: 'Export Turn as JSON', description: 'Dump live/saved/hydrated events', icon: '🔬', section: 'Dev' }
      );
    }
    const config: PopupConfig = {
      manager,
      element,
      vscode,
      header: 'Commands',
      position: 'bottom-right',
      width: '250px',
      publications: {},
      subscriptions: {},
      additionalStyles: commandsShadowStyles,
      openRequestKey: 'commands.popup.open',
      visibleStateKey: 'commands.popup.visible'
    };

    super(config);
    this._commands = commands;

    // Re-render now that instance properties are initialized
    // (base class renders during construction when properties are undefined)
    this.updateBodyContent(this.renderPopupContent());
  }

  // ============================================
  // Abstract Method Implementations
  // ============================================

  protected renderPopupContent(): string {
    // Defensive check: _commands may be undefined during base class construction
    const commands = this._commands || [];

    // Group commands by section
    const sections = new Map<string, CommandItem[]>();

    commands.forEach(cmd => {
      const section = cmd.section || 'General';
      if (!sections.has(section)) {
        sections.set(section, []);
      }
      sections.get(section)!.push(cmd);
    });

    // Render sections
    let html = '';
    sections.forEach((commands, sectionName) => {
      html += `<div class="commands-section-title">${this.escapeHtml(sectionName)}</div>`;
      html += commands.map(cmd => this.renderCommandItem(cmd)).join('');
    });

    return html;
  }

  private renderCommandItem(cmd: CommandItem): string {
    return `
      <div class="command-item" data-command="${this.escapeHtml(cmd.id)}">
        <span class="command-icon">${cmd.icon}</span>
        <div class="command-info">
          <div class="command-name">${this.escapeHtml(cmd.name)}</div>
          <div class="command-desc">${this.escapeHtml(cmd.description)}</div>
        </div>
        ${cmd.shortcut ? `<span class="command-shortcut">${this.escapeHtml(cmd.shortcut)}</span>` : ''}
      </div>
    `;
  }

  protected setupPopupEvents(): void {
    // Command item click (via delegation)
    this.delegate('click', '.command-item', (e, element) => {
      const commandId = element.getAttribute('data-command');
      if (commandId) {
        log.debug(`command clicked: ${commandId}`);
        this.executeCommand(commandId);
        this.close();
      }
    });
  }

  // ============================================
  // Command Execution
  // ============================================

  private executeCommand(commandId: string): void {
    log.debug(`executeCommand: ${commandId}`);
    webviewTracer.trace('user.click', `command:${commandId}`, { level: 'info', data: { commandId } });

    // Special handling for history commands - open modal instead
    if (commandId === 'moby.showChatHistory') {
      log.debug('routing to history modal');
      this.manager.publishDirect('history.modal.open', true, this.actorId);
      return;
    }

    // Special handling for system prompt - open modal
    if (commandId === 'moby.editSystemPrompt') {
      log.debug('routing to system prompt modal');
      this.manager.publishDirect('systemPrompt.modal.open', true, this.actorId);
      return;
    }

    // Special handling for command rules - open rules modal
    if (commandId === 'moby.openCommandRules') {
      log.debug('routing to rules modal');
      this._vscode.postMessage({ type: 'getCommandRules' });
      this.manager.publishDirect('rules.modal.open', true, this.actorId);
      return;
    }

    // Special handling for stats - fetch data and open modal
    if (commandId === 'moby.showStats') {
      log.debug('routing to stats modal');
      this._vscode.postMessage({ type: 'getStats' });
      this.manager.publishDirect('stats.modal.open', true, this.actorId);
      return;
    }

    // Call custom handler if set
    if (this._onCommand) {
      this._onCommand(commandId);
    }

    // Send to extension
    this._vscode.postMessage({ type: 'executeCommand', command: commandId });
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Set a custom command handler.
   */
  onCommand(handler: CommandHandler): void {
    this._onCommand = handler;
  }

  /**
   * Update the commands list.
   */
  setCommands(commands: CommandItem[]): void {
    this._commands = commands;
    this.updateBodyContent(this.renderPopupContent());
  }

  /**
   * Add a command to the list.
   */
  addCommand(command: CommandItem): void {
    this._commands.push(command);
    this.updateBodyContent(this.renderPopupContent());
  }

  /**
   * Get the current commands.
   */
  getCommands(): CommandItem[] {
    return [...this._commands];
  }
}
