/**
 * The command catalog — one source for the commands popup and the `/`
 * autocomplete provider. Adding an entry here surfaces it in both doors.
 */

export interface CommandItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  shortcut?: string;
  section?: string;
}

export const DEFAULT_COMMANDS: CommandItem[] = [
  // History section
  { id: 'moby.exportChatHistory', name: 'Export History', description: 'Export all chats', icon: '📤', section: 'History' },
  // Logs section
  { id: 'moby.exportLogs', name: 'Export Logs', description: 'Export all logs and traces', icon: '📝', section: 'Logs' },
  // Settings section
  { id: 'moby.editSystemPrompt', name: 'System Prompt', description: 'Edit system prompt', icon: '✏️', section: 'Settings' },
  { id: 'moby.openCommandRules', name: 'System Rules', description: 'Manage command approval rules', icon: '🛡️', section: 'Settings' },
  { id: 'moby.refreshLspAvailability', name: 'Refresh LSP', description: 'Re-probe language servers (use after installing an LSP outside VS Code)', icon: '🔄', section: 'Settings' },
  // Info section
  { id: 'moby.showStats', name: 'Account Stats', description: 'DeepSeek & Tavily usage', icon: '📊', section: 'Info' }
];

export const DEV_COMMANDS: CommandItem[] = [
  { id: 'moby.exportTestFixture', name: 'Export Test Fixture', description: 'Export session for testing', icon: '🧪', section: 'Dev' },
  { id: 'moby.exportTurnAsJson', name: 'Export Turn as JSON', description: 'Dump live/saved/hydrated events', icon: '🔬', section: 'Dev' }
];

/** Dev commands are appended only when the host marked the body dev-mode. */
export function getCommandCatalog(isDevMode = document.body.getAttribute('data-dev-mode') === 'true'): CommandItem[] {
  return isDevMode ? [...DEFAULT_COMMANDS, ...DEV_COMMANDS] : [...DEFAULT_COMMANDS];
}
