/**
 * `/` — commands.
 *
 * Filters the shared catalog the commands popup renders, so the two doors can
 * never drift. Accept routes through `ComposerHost.runCommand`, which is
 * CommandsShadowActor's own routing — several commands open webview-local
 * modals rather than posting to the extension.
 */

import { getCommandCatalog, type CommandItem } from '../../commands/commandCatalog';
import type { Suggestion, SuggestionProvider } from '../types';

export function rankCommands(commands: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;

  const scored = commands
    .map(cmd => ({ cmd, score: scoreCommand(cmd, q) }))
    .filter(entry => entry.score > 0);

  // Stable: equal scores keep catalog order, which is grouped by section.
  scored.sort((a, b) => b.score - a.score);
  return scored.map(entry => entry.cmd);
}

/** 3 = name prefix, 2 = name substring, 1 = description substring, 0 = no match. */
function scoreCommand(cmd: CommandItem, query: string): number {
  const name = cmd.name.toLowerCase();
  if (name.startsWith(query)) return 3;
  if (name.includes(query)) return 2;
  if (cmd.description.toLowerCase().includes(query)) return 1;
  return 0;
}

export class CommandsProvider implements SuggestionProvider {
  readonly trigger = '/' as const;
  readonly minQueryLength = 0;

  constructor(private readonly _catalog: CommandItem[] = getCommandCatalog()) {}

  getSuggestions(query: string): Suggestion[] {
    return rankCommands(this._catalog, query).map(cmd => ({
      label: cmd.name,
      detail: cmd.description,
      icon: cmd.icon,
      action: { kind: 'runCommand', id: cmd.id }
    }));
  }
}
