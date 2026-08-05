/**
 * Tests for the three launch providers (slices 5, 6, 7)
 *
 * Ranking and filtering are pure functions; the files provider's async
 * behaviour (debounce, shared-channel discipline) uses injected timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { CommandsProvider, rankCommands } from '../../../media/actors/composer-autocomplete/providers/commandsProvider';
import { EmojiProvider, rankEmoji } from '../../../media/actors/composer-autocomplete/providers/emojiProvider';
import { EMOJI } from '../../../media/actors/composer-autocomplete/providers/emojiData';
import {
  FilesProvider,
  extractSearchResults,
  FILE_RESULT_LIMIT
} from '../../../media/actors/composer-autocomplete/providers/filesProvider';
import { DEFAULT_COMMANDS, getCommandCatalog } from '../../../media/actors/commands/commandCatalog';
import type { Suggestion } from '../../../media/actors/composer-autocomplete/types';

describe('EmojiProvider', () => {
  const provider = new EmojiProvider();

  describe('the dataset', () => {
    it('carries GitHub shortcodes including aliases', () => {
      const lookup = new Map(EMOJI);
      expect(lookup.get('smile')).toBe('😄');
      expect(lookup.get('rocket')).toBe('🚀');
      // Aliases resolve to the same emoji, as on GitHub.
      expect(lookup.get('+1')).toBe('👍');
      expect(lookup.get('thumbsup')).toBe('👍');
    });

    it('has no duplicate shortcodes', () => {
      const names = EMOJI.map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('is big enough to be the real list', () => {
      expect(EMOJI.length).toBeGreaterThan(1500);
    });
  });

  describe('ranking', () => {
    it('puts prefix matches above substring matches', () => {
      const ranked = rankEmoji(EMOJI, 'smile').map(([name]) => name);
      const firstSubstring = ranked.findIndex(name => !name.startsWith('smile'));
      const lastPrefix = ranked.reduce((last, name, i) => (name.startsWith('smile') ? i : last), -1);
      expect(firstSubstring === -1 || lastPrefix < firstSubstring).toBe(true);
    });

    it('prefers the shorter shortcode within a tier', () => {
      const ranked = rankEmoji(EMOJI, 'sm').map(([name]) => name);
      expect(ranked[0]).toBe('smile');
      expect(ranked.indexOf('smile')).toBeLessThan(ranked.indexOf('smiley'));
    });

    it('is case-insensitive', () => {
      expect(rankEmoji(EMOJI, 'SMILE')[0][0]).toBe('smile');
    });

    it('returns nothing for an empty query or no match', () => {
      expect(rankEmoji(EMOJI, '')).toEqual([]);
      expect(rankEmoji(EMOJI, 'zzzznotanemoji')).toEqual([]);
    });

    it('caps the list', () => {
      expect(rankEmoji(EMOJI, 'a').length).toBeLessThanOrEqual(30);
    });
  });

  describe('suggestions', () => {
    it('needs two characters before offering anything', () => {
      expect(provider.minQueryLength).toBe(2);
    });

    it('renders the emoji as its own icon and inserts the character', () => {
      const [first] = provider.getSuggestions('smile') as Suggestion[];
      expect(first.label).toBe(':smile:');
      expect(first.icon).toBe('😄');
      expect(first.action).toEqual({ kind: 'insertText', text: '😄' });
    });

    it('auto-accepts a closed shortcode', () => {
      const suggestions = provider.getSuggestions('smile:') as Suggestion[];
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].autoAccept).toBe(true);
      expect(suggestions[0].action).toEqual({ kind: 'insertText', text: '😄' });
    });

    it('offers nothing for a closed shortcode that does not exist', () => {
      expect(provider.getSuggestions('notreal:')).toEqual([]);
    });

    it('does not auto-accept a merely-prefixed query', () => {
      const suggestions = provider.getSuggestions('smile') as Suggestion[];
      expect(suggestions.every(s => !s.autoAccept)).toBe(true);
    });
  });
});

describe('CommandsProvider', () => {
  it('shares the catalog the popup renders', () => {
    expect(getCommandCatalog(false)).toEqual(DEFAULT_COMMANDS);
    expect(getCommandCatalog(true).length).toBeGreaterThan(DEFAULT_COMMANDS.length);
  });

  it('offers everything for an empty query', () => {
    const provider = new CommandsProvider(DEFAULT_COMMANDS);
    expect(provider.getSuggestions('')).toHaveLength(DEFAULT_COMMANDS.length);
  });

  it('ranks name prefix above name substring above description', () => {
    const catalog = [
      { id: 'a', name: 'Zebra Logs', description: 'nothing', icon: '1' },
      { id: 'b', name: 'Export Logs', description: 'nothing', icon: '2' },
      { id: 'c', name: 'Nothing', description: 'exports things', icon: '3' }
    ];
    const ranked = rankCommands(catalog, 'export').map(cmd => cmd.id);
    expect(ranked).toEqual(['b', 'c']);
  });

  it('matches the description too', () => {
    const provider = new CommandsProvider(DEFAULT_COMMANDS);
    const labels = (provider.getSuggestions('language servers') as Suggestion[]).map(s => s.label);
    expect(labels).toContain('Refresh LSP');
  });

  it('produces runCommand actions carrying the command id', () => {
    const provider = new CommandsProvider(DEFAULT_COMMANDS);
    const [first] = provider.getSuggestions('Export Logs') as Suggestion[];
    expect(first.action).toEqual({ kind: 'runCommand', id: 'moby.exportLogs' });
    expect(first.detail).toBe('Export all logs and traces');
  });

  it('is case-insensitive and returns nothing on no match', () => {
    const provider = new CommandsProvider(DEFAULT_COMMANDS);
    expect(provider.getSuggestions('EXPORT LOGS')).toHaveLength(1);
    expect(provider.getSuggestions('zzzz')).toEqual([]);
  });
});

describe('FilesProvider', () => {
  const setup = () => {
    const timers: Array<{ fn: () => void; handle: number }> = [];
    let next = 1;
    const postMessage = vi.fn();
    const onResults = vi.fn();
    const provider = new FilesProvider({
      postMessage,
      onResults,
      setTimeoutFn: (fn) => {
        const handle = next++;
        timers.push({ fn, handle });
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        const i = timers.findIndex(t => t.handle === (handle as unknown as number));
        if (i >= 0) timers.splice(i, 1);
      }
    });
    const flush = () => {
      const pending = [...timers];
      timers.length = 0;
      pending.forEach(t => t.fn());
    };
    return { provider, postMessage, onResults, flush, timers };
  };

  it('returns pending and searches after the debounce', () => {
    const { provider, postMessage, flush } = setup();
    expect(provider.getSuggestions('src')).toBe('pending');
    expect(postMessage).not.toHaveBeenCalled();

    flush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'searchFiles', query: 'src' });
  });

  it('debounces a burst into one search for the final query', () => {
    const { provider, postMessage, flush } = setup();
    provider.getSuggestions('s');
    provider.getSuggestions('sr');
    provider.getSuggestions('src');
    flush();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'searchFiles', query: 'src' });
  });

  it('maps results to attachFile suggestions with the basename as label', () => {
    const { provider, onResults, flush } = setup();
    provider.getSuggestions('index');
    flush();
    provider.handleResults({ results: ['src/actors/index.ts', 'README.md'] });

    expect(onResults).toHaveBeenCalledWith('index', [
      { label: 'index.ts', detail: 'src/actors/index.ts', icon: '📄', action: { kind: 'attachFile', path: 'src/actors/index.ts' } },
      { label: 'README.md', detail: 'README.md', icon: '📄', action: { kind: 'attachFile', path: 'README.md' } }
    ]);
  });

  it('reports results against the query that was outstanding', () => {
    const { provider, onResults, flush } = setup();
    provider.getSuggestions('sr');
    provider.getSuggestions('src');
    flush();
    provider.handleResults({ results: ['src/a.ts'] });

    expect(onResults.mock.calls[0][0]).toBe('src');
  });

  it('ignores a reply it did not ask for — the channel is shared with the files popup', () => {
    const { provider, onResults } = setup();
    // No getSuggestions call: this reply belongs to the popup's own search.
    provider.handleResults({ results: ['src/whatever.ts'] });
    expect(onResults).not.toHaveBeenCalled();
  });

  it('stops claiming replies after reset', () => {
    const { provider, onResults, flush } = setup();
    provider.getSuggestions('src');
    flush();
    provider.reset();
    provider.handleResults({ results: ['src/a.ts'] });
    expect(onResults).not.toHaveBeenCalled();
  });

  it('reset cancels a search that has not fired yet', () => {
    const { provider, postMessage, flush } = setup();
    provider.getSuggestions('src');
    provider.reset();
    flush();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('caps the number of results', () => {
    const { provider, onResults, flush } = setup();
    provider.getSuggestions('a');
    flush();
    provider.handleResults({ results: Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`) });
    expect(onResults.mock.calls[0][1]).toHaveLength(FILE_RESULT_LIMIT);
  });

  it('reports an empty list rather than nothing when a search finds no files', () => {
    const { provider, onResults, flush } = setup();
    provider.getSuggestions('zzz');
    flush();
    provider.handleResults({ results: [] });
    expect(onResults).toHaveBeenCalledWith('zzz', []);
  });

  describe('extractSearchResults', () => {
    it('accepts both payload shapes and rejects junk', () => {
      expect(extractSearchResults({ results: ['a.ts'] })).toEqual(['a.ts']);
      expect(extractSearchResults(['a.ts'])).toEqual(['a.ts']);
      expect(extractSearchResults(undefined)).toEqual([]);
      expect(extractSearchResults({ results: 'nope' })).toEqual([]);
      expect(extractSearchResults({ results: [1, 'a.ts', null] })).toEqual(['a.ts']);
    });
  });
});
