# 0015. Composer autocomplete — typed invocation via a provider registry

**Status:** Accepted — not yet implemented.
**Date:** 2026-08-04

Plan: [docs/plans/composer-autocomplete.md](../../plans/composer-autocomplete.md). Sequenced ahead of MCP client integration, whose prompts/resources phase lands on this surface.

## Context

Moby has no typed invocation. Commands are a button-opened popup menu ([CommandsShadowActor.ts](../../../media/actors/commands/CommandsShadowActor.ts)), file search lives inside the files popup ([FilesShadowActor.ts](../../../media/actors/files/FilesShadowActor.ts)), and the composer textarea intercepts nothing — no trigger characters, no suggestion overlay. Every invokable surface is a separate popup the user must navigate *to*, rather than a suggestion that comes to the cursor.

Two pressures made this worth deciding now:

- **MCP client integration** (2026-08-04 scope decision, CLAUDE.md Next-up #3) wants prompts surfaced as slash commands and resources as attachable context. Without a typed-invocation surface, both would be buried in popup menus — functional but dead-feeling, and the resources capability was priced as "big webview design work" almost entirely because of the missing surface.
- Standalone value exists regardless of MCP: `/` for existing commands, `@` for file attach, `:` for emoji are all immediately useful against the features Moby already has.

## Decision

### 1. One overlay actor, many providers

A single new webview actor — **ComposerAutocompleteActor** — owns trigger detection on the textarea, the anchored suggestion overlay, and keyboard arbitration. Content comes from a **provider registry**: each provider declares a trigger character (`/`, `@`, `:`), a minimum query length, and a `getSuggestions(query)` that is synchronous or async-by-later-publish.

Accepting a suggestion always deletes the trigger+query span, then performs a typed action:

```ts
type SuggestionAction =
  | { kind: 'insertText'; text: string }
  | { kind: 'runCommand'; id: string }
  | { kind: 'attachFile'; path: string };
```

Three launch providers: **emoji** (`:`, bundled gemoji-derived shortcode pairs, fully local), **commands** (`/`, the existing `DEFAULT_COMMANDS` list, posts the same `executeCommand` message the popup posts), **files** (`@`, reuses the existing `searchFiles` postMessage round-trip; accept routes into the existing attach-chip pipeline).

The actor reaches the composer through a narrow **`ComposerHost`** interface (`getText` / `getCaret` / `replaceRange` / `attachFile` / `focus`) rather than through the input-area actor directly. Two reasons: the overlay and the composer are separate Shadow DOM actors and neither may reach into the other's root, and a fake host makes the accept mechanics testable without a real textarea. `attachFile` is *injected* into the adapter rather than taken from the input area, so the composer never grows a dependency on the file-search round-trip.

*Why a registry rather than three bespoke overlays:* the three launch providers deliberately span all three accept semantics, which proves the interface before MCP arrives. MCP prompts become a `/` provider and MCP resources an `@` provider whose accept feeds `resources/read` output into the same ingestion seam as `droppedFileContents` — the webview never learns MCP exists.

### 2. The textarea stays a plain textarea

No contenteditable, no inline token rendering. Rich mentions would require rewriting the composer — a contenteditable with token spans, its own undo stack, IME handling, and paste sanitization — to buy cosmetics only. Instead, accept semantics keep richness *outside* the text: `@`-file accept produces an attach **chip** (the existing UI for "this thing rides the message"), commands fire immediately, emoji inserts a plain character. Nothing in the message text is ever a token that must survive editing.

### 3. Trigger discipline is per-provider, strictest for `:`

A trigger is live only when the caret sits after `<boundary><trigger><query>` where boundary = start-of-input or whitespace. The `:` provider additionally requires ≥2 query characters. This kills the false-positive space (`std::vector`, `http://`, "note:", pasted code) without a dismissal heuristic. Paste never opens the overlay — only keyed input advances a live trigger. During IME composition (`event.isComposing`), detection idles.

### 4. The overlay wins keyboard arbitration only while visible

While the overlay is open: ↑/↓ navigate, Enter/Tab accept, Esc dismisses — claimed in capture phase ahead of [InputAreaShadowActor](../../../media/actors/input-area/InputAreaShadowActor.ts)'s Enter-to-send handling, and *only* for keys the overlay consumes. Closed, the composer behaves byte-for-byte as today. This seam is the highest regression risk in the design (it sits on the most-used input surface in the product) and is pinned by harness e2e, not just unit tests.

### 5. Anchor to the composer box, not the caret

The overlay renders as a full-width bar above the input area — the VS Code suggest-widget shape — rather than tracking caret x-position. Caret mirroring in a Shadow DOM stack above a virtual list is fragile and buys little at this input width.

### 6. Emoji ships first

Build order is emoji → commands → files: the emoji provider is fully local and synchronous, so phase 1 proves the overlay, trigger detection, and keydown arbitration with no async plumbing and no extension-side changes. Files (phase 3) is the only phase that touches the extension side, and only to reuse an existing handler.

## Consequences

- MCP prompts and resources become thin providers instead of new UX. The resources capability moves from "deferred indefinitely" to "nearly free once this lands."
- The emoji dataset (~60–80KB, statically imported) is the first large static asset in the webview bundle; esbuild inlines it. No network fetch, so the pending webview-CSP work is unaffected.
- The commands button popup stays — autocomplete is an additional door, not a replacement. Divergence between the two lists is prevented by both reading the same `DEFAULT_COMMANDS` source.
- Keydown handling in the composer gains a second owner. Any future change to InputAreaShadowActor's key handling must consider overlay-open state; the capture-phase claim is the single choke point.
- New protocol surface is minimal: no new postMessage types for phases 1–2; phase 3 reuses `searchFiles` (the protocol-drift detector's known-orphan list is untouched).

## Alternatives considered

**Contenteditable composer with inline mention tokens.** The rich-editor feel (colored `@file` pills inline). Rejected: rewrites the most battle-tested surface in the webview — undo, IME, paste, selection, the expand/collapse states of M10 — for presentation. Chips already express "attached to this message" without living inside the text.

**Extend each existing popup instead (filter field in commands popup, etc.).** Smallest diff, no new actor. Rejected: it entrenches the navigate-to-popup model this ADR exists to replace, and gives MCP prompts/resources no home that feels like invocation.

**Caret-anchored popup positioning.** Closer to editor-style UX. Rejected for v1: requires a hidden mirror div to measure caret coordinates inside a Shadow DOM; the full-width bar is steadier and the composer is narrow enough that precision buys nothing. Revisit only if the composer ever becomes multi-column.

## Revisit triggers

- A provider needs multi-step accept (MCP prompts with required arguments) → extend `SuggestionAction` with a follow-up input step rather than bolting dialogs onto providers ad hoc.
- Real-IME dev-host testing (manual backlog, on landing) shows composition breakage → the `isComposing` guard needs to extend to selectionchange handling too.
- Bundle-size growth beyond the expected ~80KB → trim the emoji set to the GitHub-common subset.
