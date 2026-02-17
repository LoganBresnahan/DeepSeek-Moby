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
  // Chat section
  { id: 'deepseek.newChat', name: 'New Chat', description: 'Start a new conversation', icon: '✨', section: 'Chat' },
  // History section
  { id: 'deepseek.showChatHistory', name: 'Show History', description: 'View chat history', icon: '📚', section: 'History' },
  { id: 'deepseek.exportChatHistory', name: 'Export History', description: 'Export all chats', icon: '📤', section: 'History' },
  { id: 'deepseek.searchChatHistory', name: 'Search History', description: 'Search past chats', icon: '🔍', section: 'History' },
  // Trace section
  { id: 'deepseek.exportTrace', name: 'Export Trace', description: 'Save trace to file', icon: '💾', section: 'Trace' },
  { id: 'deepseek.copyTrace', name: 'Copy Trace', description: 'Copy trace to clipboard', icon: '📋', section: 'Trace' },
  { id: 'deepseek.viewTrace', name: 'View Trace', description: 'Show in output panel', icon: '👁️', section: 'Trace' },
  { id: 'deepseek.traceStats', name: 'Trace Stats', description: 'View trace statistics', icon: '📊', section: 'Trace' },
  { id: 'deepseek.clearTrace', name: 'Clear Trace', description: 'Clear trace buffer', icon: '🗑️', section: 'Trace' },
  // Logs section
  { id: 'deepseek.exportLogsAI', name: 'Export Logs (AI)', description: 'LLM-optimized log export', icon: '🤖', section: 'Logs' },
  { id: 'deepseek.exportLogsHuman', name: 'Export Logs (Full)', description: 'Full detail log export', icon: '📝', section: 'Logs' },
  // Settings section
  { id: 'deepseek.openCommandRules', name: 'Command Rules', description: 'Manage command approval rules', icon: '🛡️', section: 'Settings' }
];

// ============================================
// CommandsShadowActor
// ============================================

export class CommandsShadowActor extends PopupShadowActor {
  private _commands: CommandItem[] = DEFAULT_COMMANDS;
  private _onCommand: CommandHandler | null = null;

  constructor(manager: EventStateManager, element: HTMLElement, vscode: VSCodeAPI) {
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
    if (commandId === 'deepseek.showChatHistory' || commandId === 'deepseek.searchChatHistory') {
      log.debug('routing to history modal');
      this.manager.publishDirect('history.modal.open', true, this.actorId);
      return;
    }

    // Special handling for command rules - open rules modal
    if (commandId === 'deepseek.openCommandRules') {
      log.debug('routing to rules modal');
      this._vscode.postMessage({ type: 'getCommandRules' });
      this.manager.publishDirect('rules.modal.open', true, this.actorId);
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
