/**
 * Composer autocomplete actor exports
 */
export { ComposerAutocompleteActor } from './ComposerAutocompleteActor';
export { ProviderRegistry } from './providerRegistry';
export { createComposerHost } from './composerHost';
export { TriggerDetectionController } from './TriggerDetectionController';
export { detectTriggerSpan, MAX_TRIGGER_SPAN_LENGTH } from './triggerDetection';
export { composerAutocompleteShadowStyles } from './shadowStyles';

export { CommandsProvider, rankCommands } from './providers/commandsProvider';
export { EmojiProvider, rankEmoji, EMOJI_RESULT_LIMIT } from './providers/emojiProvider';
export {
  FilesProvider,
  extractSearchResults,
  FILE_SEARCH_DEBOUNCE_MS,
  FILE_RESULT_LIMIT
} from './providers/filesProvider';
export { EMOJI } from './providers/emojiData';

export type { ComposerTextSurface, ComposerSideEffects } from './composerHost';
export type { EmojiEntry } from './providers/emojiData';
export type { FilesProviderDeps } from './providers/filesProvider';
export type {
  ComposerHost,
  Suggestion,
  SuggestionAction,
  SuggestionProvider,
  TriggerChar,
  TriggerSpan
} from './types';
