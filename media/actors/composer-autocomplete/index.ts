/**
 * Composer autocomplete actor exports
 */
export { ComposerAutocompleteActor } from './ComposerAutocompleteActor';
export { ProviderRegistry } from './providerRegistry';
export { createComposerHost } from './composerHost';
export { TriggerDetectionController } from './TriggerDetectionController';
export { detectTriggerSpan, MAX_TRIGGER_SPAN_LENGTH } from './triggerDetection';
export { composerAutocompleteShadowStyles } from './shadowStyles';
export type { ComposerTextSurface } from './composerHost';
export type {
  ComposerHost,
  Suggestion,
  SuggestionAction,
  SuggestionProvider,
  TriggerChar,
  TriggerSpan
} from './types';
