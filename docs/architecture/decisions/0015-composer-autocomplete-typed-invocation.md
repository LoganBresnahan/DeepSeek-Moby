# 0015. Composer autocomplete — typed invocation via a provider registry

**Status:** Accepted — phases 1–3 implemented (feature-complete); test/doc phases 4–5 and dev-host `/verify` outstanding.
**Date:** 2026-08-04 (amended 2026-08-05 with what implementation and dogfooding settled)

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

Three launch providers: **emoji** (`:`, vendored shortcode pairs, fully local), **commands** (`/`, the shared command catalog), **files** (`@`, reuses the existing `searchFiles` postMessage round-trip; accept routes into the existing attach-chip pipeline).

The actor reaches the composer through a narrow **`ComposerHost`** interface (`getText` / `getCaret` / `replaceRange` / `attachFile` / `runCommand` / `focus`) rather than through the input-area actor directly. Two reasons: the overlay and the composer are separate Shadow DOM actors and neither may reach into the other's root, and a fake host makes the accept mechanics testable without a real textarea. The two side effects are *injected* into the adapter rather than taken from the input area, so the composer never grows a dependency on the file-search round trip or on command routing.

`runCommand` is injected rather than a direct `executeCommand` post because **four commands open webview-local modals instead of reaching the extension** (history, system prompt, command rules, stats). `CommandsShadowActor` already owns that routing, so the provider calls into it; duplicating the list of exceptions is how the two doors would silently diverge.

Three further contract points, all discovered by building it:

- **`Suggestion.autoAccept`** — accept without waiting for a keystroke, honoured only when a provider returns exactly one suggestion. Exists for the closed emoji shortcode (`:smile:`), where the trailing colon is an unambiguous "I meant exactly this."
- **`SuggestionProvider.reset?()`** — called when a trigger dies, so an async provider stops treating an in-flight reply as its own.
- **Async providers cannot subscribe for themselves.** `EventStateManager` indexes subscriptions at actor-registration time, before any provider exists, so the *actor* declares the state keys (an optional `stateSubscriptions` constructor argument) and forwards to the provider. The files provider is fed its results; it never touches the manager.

*Why a registry rather than three bespoke overlays:* the three launch providers deliberately span all three accept semantics, which proves the interface before MCP arrives. MCP prompts become a `/` provider and MCP resources an `@` provider whose accept feeds `resources/read` output into the same ingestion seam as `droppedFileContents` — the webview never learns MCP exists.

### 2. The textarea stays a plain textarea, and `@` accept is a chip — not text

No contenteditable, no inline token rendering. Rich mentions would require rewriting the composer — a contenteditable with token spans, its own undo stack, IME handling, and paste sanitization — to buy cosmetics only. Instead, accept semantics keep richness *outside* the text: `@`-file accept produces an attach **chip** (the existing UI for "this thing rides the message"), commands fire immediately, emoji inserts a plain character. Nothing in the message text is ever a token that must survive editing.

**Reaffirmed 2026-08-05 after dogfooding, with a caveat that nearly sank it.** The first user reaction to `@` was "hitting enter doesn't render the path in the input box" — the design is *right*, but it is only defensible if the chip is visible, because a vanishing trigger with no feedback is indistinguishable from a no-op. Two latent defects meant it was not:

- `InputAreaShadowActor.updateFileChips()` had **zero callers repo-wide** — the composer's `Context:` chip row was dead UI, so neither the files popup nor `@` ever rendered a chip.
- `files.selected` is published as a `Map`, and `Map` values did not survive `EventStateManager`: [`deepClone`](../../../media/utils/deepClone.ts) had no `Map` branch (a Map cloned to `{}`), and [`deepEqual`](../../../media/utils/deepEqual.ts) had the same gap, so **any two Maps compared equal** and a change carrying one was never even detected. Nothing had ever subscribed to that key, so the hole was invisible until this feature used it.

So the rule this decision now carries: **an accept whose effect lives outside the text must produce visible feedback in the same beat**, and that feedback is the chip. Removal must round-trip to the owning actor (`files.removeSelected` → `FilesShadowActor`), because dropping only the composer's copy would leave the file in the model's context while the UI claimed it was gone.

### 3. Trigger discipline is per-provider, strictest for `:`

A trigger is live only when the caret sits after `<boundary><trigger><query>` where boundary = start-of-input or whitespace — equivalently, the trigger must be the *first* character of the whitespace-delimited run the caret sits in. The `:` provider additionally requires ≥2 query characters. This kills the false-positive space (`std::vector`, `http://`, "note:", pasted code) without a dismissal heuristic. Paste never opens the overlay — only keyed input advances a live trigger, discriminated by `InputEvent.inputType`, with an unrecognised type treated as silent so programmatic and synthetic edits can never pop UI. During IME composition detection idles entirely, tracked via `compositionstart`/`compositionend` because `selectionchange` carries no `isComposing`.

**Events are matched on `composedPath()`, not `event.target`.** Composed events from inside the composer's shadow root do retarget to its host, but relying on that couples detection to the DOM implementation performing retargeting; the path is the portable answer, and `contains()` never crosses a shadow boundary. (Caught by the end-to-end test, which would have passed in a real browser and failed only under the test DOM.)

The composer's *programmatic* edits — `setValue`, the send-clear — fire no input events at all, so a live span could outlive the text it pointed at. The actor additionally watches the published `input.value` and drops any span or Escape-dismissal the text no longer supports.

### 4. The overlay wins keyboard arbitration only while visible

While the overlay is open: ↑/↓ navigate, Enter/Tab accept, Esc dismisses — claimed in capture phase ahead of [InputAreaShadowActor](../../../media/actors/input-area/InputAreaShadowActor.ts)'s Enter-to-send handling, and *only* for keys the overlay consumes. Closed, the composer behaves byte-for-byte as today. This seam is the highest regression risk in the design (it sits on the most-used input surface in the product) and is pinned by harness e2e, not just unit tests.

### 5. Anchor to the composer box, not the caret

The overlay renders as a full-width bar above the input area — the VS Code suggest-widget shape — rather than tracking caret x-position. Caret mirroring in a Shadow DOM stack above a virtual list is fragile and buys little at this input width.

### 6. Emoji ships first

Build order is emoji → commands → files: the emoji provider is fully local and synchronous, so phase 1 proves the overlay, trigger detection, and keydown arbitration with no async plumbing and no extension-side changes. Files (phase 3) is the only phase that touches the extension side, and only to reuse an existing handler.

## Consequences

- MCP prompts and resources become thin providers instead of new UX. The resources capability moves from "deferred indefinitely" to "nearly free once this lands."
- The emoji dataset is the first large static asset in the webview bundle. [emojiData.ts](../../../media/actors/composer-autocomplete/providers/emojiData.ts) is **generated from `gemoji` v8.1.0** (MIT — the package tracking GitHub's own list): 1,913 shortcodes including aliases, reduced to `[shortcode, char]` pairs, 52.8KB of source. Measured bundle growth for *all* of phase 3 is **+78.5KB** (937,990 → 1,018,350), inside the predicted budget. Statically imported, no network fetch, so the pending webview-CSP work is unaffected. The regeneration recipe lives in the file header; hand edits are lost on regeneration.
- The commands button popup stays — autocomplete is an additional door, not a replacement. Divergence is prevented structurally: both read [commandCatalog.ts](../../../media/actors/commands/commandCatalog.ts), and both execute through `CommandsShadowActor.runCommand`.
- Keydown handling in the composer gains a second owner. Any future change to InputAreaShadowActor's key handling must consider overlay-open state; the capture-phase claim is the single choke point.
- New protocol surface is minimal: no new postMessage types at all. Phase 3 reuses `searchFiles` and `getFileContent`, so the protocol-drift detector's known-orphan list is untouched.
- **`Map` values now survive `EventStateManager`.** Fixing `deepClone`/`deepEqual` was forced by this feature but is not scoped to it — any state key carrying a `Map` or `Set` was silently broken before, and change detection for such keys did not fire at all.
- The composer now subscribes to `files.selected`, so context chips render for **both** doors. Previously the files popup showed selections only inside its own modal.

## Alternatives considered

**Contenteditable composer with inline mention tokens.** The rich-editor feel (colored `@file` pills inline). Rejected: rewrites the most battle-tested surface in the webview — undo, IME, paste, selection, the expand/collapse states of M10 — for presentation. Chips already express "attached to this message" without living inside the text.

**Extend each existing popup instead (filter field in commands popup, etc.).** Smallest diff, no new actor. Rejected: it entrenches the navigate-to-popup model this ADR exists to replace, and gives MCP prompts/resources no home that feels like invocation.

**Caret-anchored popup positioning.** Closer to editor-style UX. Rejected for v1: requires a hidden mirror div to measure caret coordinates inside a Shadow DOM; the full-width bar is steadier and the composer is narrow enough that precision buys nothing. Revisit only if the composer ever becomes multi-column.

**Inserting the file path as plain text on `@` accept** (`@src/foo.ts` staying in the message). Raised by the first dogfooding session, which expected exactly this. Rejected, but it is the closest call in this ADR. Against it: the path in the prompt is not what actually reaches the model — the *file contents* are, via `setSelectedFiles` — so the text would be a decoration that implies a mechanism it doesn't have, and it would drift the moment the user edits or partially deletes it. The chip states the true fact ("this file rides the message") and is removable as a unit. Reconsider only if dogfooding shows users want the path as prose *in addition to* attaching, in which case it is a per-provider accept option, not a change to this rule.

## Revisit triggers

- A provider needs multi-step accept (MCP prompts with required arguments) → extend `SuggestionAction` with a follow-up input step rather than bolting dialogs onto providers ad hoc. `autoAccept` is the opposite end of the same axis and does **not** generalise to it.
- Real-IME dev-host testing (manual backlog) shows composition breakage → the composition guard needs to extend to `selectionchange` handling too.
- ~~Bundle-size growth beyond the expected ~80KB~~ — **measured at +78.5KB, inside budget.** Re-check only if the dataset is regenerated from a much larger `gemoji`, in which case trim to a common subset.
- A second accept kind gains an effect outside the text (MCP resources will) → it needs its own visible in-composer feedback, per decision 2. Do not assume the chip row covers it.
- Users keep expecting the accepted path as prose → see the inline-path alternative above; make it a per-provider option, not a global rule change.
