/**
 * Adapter from InputAreaShadowActor to the narrow {@link ComposerHost} the
 * autocomplete actor sees.
 *
 * The side effects are injected rather than taken from the input area:
 * routing a path into the attach pipeline and running a command both need
 * collaborators the composer has no business knowing about.
 */

import type { ComposerHost } from './types';

/** The slice of InputAreaShadowActor this adapter needs. */
export interface ComposerTextSurface {
  getValue(): string;
  getCaret(): number;
  replaceRange(start: number, end: number, text: string): void;
  focus(): void;
}

export interface ComposerSideEffects {
  attachFile(path: string): void;
  runCommand(id: string): void;
}

export function createComposerHost(
  surface: ComposerTextSurface,
  effects: ComposerSideEffects
): ComposerHost {
  return {
    getText: () => surface.getValue(),
    getCaret: () => surface.getCaret(),
    replaceRange: (start, end, text) => surface.replaceRange(start, end, text),
    attachFile: (path) => effects.attachFile(path),
    runCommand: (id) => effects.runCommand(id),
    focus: () => surface.focus()
  };
}
