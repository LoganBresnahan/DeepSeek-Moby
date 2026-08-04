# Composer Autocomplete

_Status: design accepted 2026-08-04 — decisions recorded in [ADR 0015](../architecture/decisions/0015-composer-autocomplete-typed-invocation.md). Precedes MCP client integration (phase 3 of [mcp.md](mcp.md) lands on this surface)._

## Why

Moby has no typed invocation. Commands live in a button-opened popup ([CommandsShadowActor.ts](../../media/actors/commands/CommandsShadowActor.ts)), file search lives inside the files popup ([FilesShadowActor.ts:154](../../media/actors/files/FilesShadowActor.ts#L154)), and the input textarea intercepts nothing. A typed trigger (`/`, `@`, `:`) with an at-cursor suggestion overlay is what makes commands, file attach, and — later — MCP prompts and resources feel like true invocation instead of menu spelunking.

Strategic weight: this is the landing surface for MCP phase 3. With `@`-autocomplete in place, MCP *resources* become nearly free (an `@`-suggestion whose accept calls `resources/read` and feeds the existing `droppedFileContents` ingestion seam → chip → digest → blob persistence), and MCP *prompts* become `/`-entries. Without it, both would be buried in popups.

## Shape

One new webview actor — **ComposerAutocompleteActor** — owning:

- **Trigger detection** on the textarea (input + selectionchange). A trigger is live when the caret sits after `<boundary><trigger-char><query>` where boundary = start-of-input or whitespace.
- **A suggestion overlay** anchored above the input area (PopupShadowActor is the base, but this popup is keyboard-driven and position-anchored, not button-toggled).
- **Keyboard arbitration** while open: ↑/↓ move, Enter/Tab accept, Esc dismisses. Enter-to-send and Esc-to-whatever in [InputAreaShadowActor](../../media/actors/input-area/InputAreaShadowActor.ts) must *defer* to the overlay when it is open — this is the fiddly seam; the overlay claims the keydown in capture phase and stops propagation only for keys it consumes.
- **A provider registry.** The actor knows triggers and rendering; providers know content.

```ts
interface SuggestionProvider {
  trigger: '/' | '@' | ':';
  minQueryLength: number;              // ':' needs 2; '/' and '@' fire at 0
  getSuggestions(query: string): Suggestion[] | 'pending';  // async providers publish results later
}

interface Suggestion {
  label: string;
  detail?: string;
  icon?: string;                       // emoji char doubles as its own icon
  action: SuggestionAction;
}

type SuggestionAction =
  | { kind: 'insertText'; text: string }     // emoji; MCP-prompt-with-args later reuses insertText for templates
  | { kind: 'runCommand'; id: string }       // existing moby.* commands; MCP prompts later
  | { kind: 'attachFile'; path: string };    // @-files → existing attach pipeline; MCP resources later
```

Accept always deletes the trigger+query span from the textarea, then performs the action. The textarea stays a plain textarea — no contenteditable, no inline token rendering. `@`-file accept produces an attach **chip**, not inline text, which is why we escape the contenteditable tax entirely.

Providers at launch:

1. **Emoji** (`:`) — bundled gemoji-derived `[shortcode, char]` pairs (~1.8K entries, trimmed to ~60–80KB, statically imported so esbuild inlines it; no network, CSP-clean). Trigger requires ≥2 query chars and a boundary before `:` (kills `std::`, `http://`, "note:"). Prefix matches rank above substring matches. Polish: typing the closing colon on an exact shortcode (`:smile:`) replaces immediately, popup or no popup.
2. **Commands** (`/`) — the existing `DEFAULT_COMMANDS` list (+ dev commands under devMode), filtered by name/description. Accept posts the same `executeCommand` message the popup posts today. The button popup stays; this is an additional door, not a replacement.
3. **Files** (`@`) — reuses the existing `searchFiles` postMessage round-trip and its extension-side handler. Async: provider returns `'pending'`, results arrive by postMessage, stale-query replies are discarded by query-token match. Debounce ~150ms. Accept routes into the same attach path the files popup uses.

## Build checklist (design-plan workflow, 2026-08-04)

Eleven slices, effort-ranked and dependency-ordered. Only two are hard-reasoning (Fable + adversarial verify); everything else is Opus throughput work. Effort tracks reasoning difficulty, not size.

| # | Slice | Effort | Hardness | Model | Verify pass | Risk | Depends on |
|---|-------|--------|----------|-------|-------------|------|------------|
| 1 | ~~`autocomplete-actor-core`~~ **DONE 2026-08-04** — actor shell, provider registry, typed actions, accept mechanics | medium | moderate | opus | — | medium | — |
| 2 | ~~`trigger-detection`~~ **DONE 2026-08-04** — boundary scan, IME (`compositionstart/end` — selectionchange lacks `isComposing`), paste guards via `inputType` | high | hard-reasoning | **fable** | **passed** | medium | 1 |
| 3 | ~~`keydown-arbitration`~~ **DONE 2026-08-04** — capture-phase claim ahead of InputAreaShadowActor's bubble-phase Enter-to-send delegate ([InputAreaShadowActor.ts:147](../../media/actors/input-area/InputAreaShadowActor.ts#L147), `handleTextareaKeydown` at [:194](../../media/actors/input-area/InputAreaShadowActor.ts#L194)) | high | hard-reasoning | **fable** | **passed** | **high** | 1 |
| 4 | `overlay-positioning-render` — full-width bar above composer, PopupShadowActor-derived | medium | moderate | opus | — | low | 1 |
| 5 | `emoji-provider` — bundled dataset, prefix-over-substring rank, closing-colon replace | medium | moderate | opus | — | low | 1, 2 |
| 6 | `commands-provider` — hoist `DEFAULT_COMMANDS` to a shared module; reuse `executeCommand` post | low | mechanical | opus | — | low | 1 |
| 7 | `files-provider-async` — pending/debounce/stale-discard; **reply channel is shared with FilesShadowActor and carries no query token**, so the actor tracks its own last-query token ([chatProvider.ts:849](../../src/providers/chatProvider.ts#L849) handler reused) | medium | moderate | opus | — | medium | 1, 2 |
| 8 | `unit-test-matrix` — boundary matrix, ranking, stale discard, one dispatch test per action kind | medium | mechanical | opus | — | low | 1, 2, 5, 6, 7 |
| 9 | `bundle-size-guard` — measure esbuild growth, trim to GitHub-common subset only if >~80KB | low | mechanical | opus | — | low | 5 |
| 10 | `harness-e2e-interplay` — headless-Chromium specs for the overlay/InputArea seam; joins the `/shipshape` harness tier | medium | moderate | opus | — | medium | 1–7 |
| 11 | `manual-backlog-entries` — IME/CJK, positioning feel, emoji fonts, M10 force-expanded interplay | low | mechanical | opus | — | low | 2, 4, 5 |

**Phases** (batched by model — one Fable batch, minimal model switches):

- **Phase 1 (opus): actor shell + interfaces — LANDED 2026-08-04.** [media/actors/composer-autocomplete/](../../media/actors/composer-autocomplete/): `types.ts` (the contract), `providerRegistry.ts` (pure), `ComposerAutocompleteActor.ts` (PopupShadowActor-derived), `composerHost.ts` (adapter). `getCaret`/`replaceRange` added to [InputAreaShadowActor](../../media/actors/input-area/InputAreaShadowActor.ts). 22 tests; suites 3,269 → 3,291; typecheck + webpack clean. **Deliberately unwired** — nothing constructs it until the overlay slice, because there is no detection to open it and nothing to render. Contract additions beyond the ADR: `ComposerHost` (recorded in ADR 0015 decision 1) and `TriggerSpan`. Known soft spot: `updateSuggestions` keys staleness on the query string rather than a monotonic token, so an in-flight reply for an earlier *identical* query is accepted — benign (same query, same results) but revisit if a provider's results become time-varying.
- **Phase 2 (fable): hard input seams — LANDED 2026-08-04.** [triggerDetection.ts](../../media/actors/composer-autocomplete/triggerDetection.ts) (pure scan: the trigger must START the whitespace-delimited run — one rule kills `std::`/`http://`/`note:` and allows `@src/:ab`) + [TriggerDetectionController.ts](../../media/actors/composer-autocomplete/TriggerDetectionController.ts) (document-level only: `input`/`composition*`/`focusin` retarget to the composer host, `selectionchange` is document-native; keyed-vs-silent via `inputType` allowlist, unknown = silent). Arbitration in the actor: document CAPTURE keydown attached only while visible — capture at document precedes the contentRoot bubble delegate by DOM dispatch order, and the ordering claim is pinned by a test that fails if the listener goes bubble-phase. Wired inert in chat.ts (zero providers). **Adversarial verify ran (two refutation agents), both slices: core contracts held — including capture-vs-bubble ordering, listener lifecycle, and stopPropagation-across-phases — but the pass caught one real defect and two latent ones, all fixed + regression-pinned:** (1) Escape-dismissal memory survived the draft — one Esc at offset 0 suppressed every draft-initial trigger for the session; now keyed on (start, trigger) and dropped via an `input.value` subscription when the text no longer carries the trigger. (2) Programmatic edits (`setValue`, send-clear) fire no input events; the same subscription now text-validates the live span (the caret-equality backstop alone missed same-length replacements). (3) `updateSuggestions` re-checks span text so a late async reply can't resurrect a cleared draft. 79 module tests; suites 3,348 green twice; harness e2e 45/45 against the built bundle (the phase-boundary drive). Residual for phase 5's backlog entries: real-IME behaviour is dev-host-only; the interrupt-path `clearInput` doesn't publish `input.value` (pre-existing input-area gap, affects any subscriber — noted, not fixed here).
- **Phase 3 (opus): overlay + all three providers** — slices 4, 6, 5, 7. Feature-complete point: first moment `:smi → Enter → 😄` is drivable end-to-end. `/verify` (headless harness) pays off here; explicitly check files-popup cross-talk on the shared `searchResults` channel. `/shipshape`.
- **Phase 4 (opus): automated verification + guards** — slices 8, 9, 10 (fold 9 into 8's commit window). Watch each new spec fail first — a vacuously-green harness spec is this phase's own failure mode. `/shipshape`.
- **Phase 5 (opus): docs on landing** — slice 11, written last so entries describe shipped behavior; the IME entry feeds ADR 0015's revisit trigger. Final `/shipshape` covers docs currency.

**Critical path:** `autocomplete-actor-core → trigger-detection → emoji-provider → harness-e2e-interplay`.

**Verify-pass discipline:** ONLY slices 2 and 3 warrant adversarial verification. Everything else fails loudly — a second pass on them is waste. Closed-overlay byte-for-byte composer behavior must hold from phase 2 onward.

**Later, out of scope here** — MCP prompts + resources providers (see [mcp.md](mcp.md) phase 3): extension posts suggestion lists per connected server; webview stays MCP-ignorant.

## Risks / fiddly bits

- **Keydown arbitration** with InputAreaShadowActor's existing Enter-send and expand/collapse handling. The overlay must win Enter/Esc/↑/↓ *only while visible*, and must never eat plain typing. Regression risk to the most-touched input surface in the product — phase 1 needs harness e2e on the interplay, not just unit tests.
- **Caret-anchored positioning** in a Shadow DOM stack above a virtual list. Mitigation: anchor to the input area's box (full-width bar above the composer, like VS Code's own suggest widget), *not* to the caret x-position. Simpler, steadier, good enough.
- **IME / composition events**: while `isComposing`, trigger detection must idle, or CJK input breaks. Check `event.isComposing` in every key handler.
- **Paste containing trigger chars** must not pop the overlay (only keyed input advances the query; on paste, re-detect silently and require a further keystroke to open).
- **Bundle size**: the emoji dataset is the first large static asset in the webview bundle. Confirm esbuild output growth is the expected ~60–80KB and no more.

## Verification roster

- Unit (vitest, happy-dom): trigger-boundary matrix (`:sm` at start / after space / after `std:` / inside `http://`), provider filtering + ranking, stale-async discard, action dispatch per kind.
- Harness e2e (no model calls): type `:smi` → overlay appears → Enter inserts 😄; `/exp` → Enter fires command message; `@` → mock searchFiles reply → Enter yields chip; Enter-with-overlay-closed still sends; Esc closes overlay and does not clear input; composition-event guard.
- Dev-host manual (backlog items on landing): real IME input, feel of positioning, emoji font rendering across platforms, interaction with force-expanded textarea state (M10 territory).
