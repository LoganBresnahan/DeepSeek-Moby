/**
 * Adapter from InputAreaShadowActor to the narrow {@link ComposerHost} the
 * autocomplete actor sees.
 *
 * The attach side is injected rather than taken from the input area: routing a
 * path into the attach pipeline needs the extension round-trip that the files
 * provider owns, and the input area should not grow a dependency on it.
 */

import type { ComposerHost } from './types';

/** The slice of InputAreaShadowActor this adapter needs. */
export interface ComposerTextSurface {
  getValue(): string;
  getCaret(): number;
  replaceRange(start: number, end: number, text: string): void;
  focus(): void;
}

export function createComposerHost(
  surface: ComposerTextSurface,
  attachFile: (path: string) => void
): ComposerHost {
  return {
    getText: () => surface.getValue(),
    getCaret: () => surface.getCaret(),
    replaceRange: (start, end, text) => surface.replaceRange(start, end, text),
    attachFile,
    focus: () => surface.focus()
  };
}
