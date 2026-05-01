# Streaming code blocks

**Status:** Parked — UX polish, not capability. Revisit after subagents + instrumentation land.
**Date:** 2026-05-01

## Context

Today, when the model emits a fenced code block, the user sees nothing inline until the closing fence arrives. The pipeline at [MessageTurnActor.ts:formatContent](../../media/actors/turn/MessageTurnActor.ts) only extracts **complete** fences via `extractCodeBlocks`; trailing unclosed fences are stripped from the prose at line 2121 to prevent malformed-fence leak. The turn-level activity label says *"Generating code..."* / *"Writing X..."* but the message body itself is silent for the duration.

For a 500-line code block at typical streaming speed, that's a 20-30s blank wait. Every modern AI coding UI (Claude Code, Cursor, ChatGPT, Aider TUI, Codeium) renders code as it streams. The asymmetry shows.

This plan captures the design space for changing that.

## Decision

Render in-progress fenced code blocks **as they stream**, with the action buttons (Apply / Diff / Copy) disabled until the closing fence arrives. Once the fence closes, swap in the final rendered block (with buttons enabled, language possibly re-inferred from `# File:` header) — same shape `formatContent` produces today.

Hybrid approach: keep the existing `extractCodeBlocks` pre-extract for closed fences; add a separate "render the trailing unclosed fence as a streaming variant" path. The two paths produce structurally identical DOM (`<div class="code-block">...`) so swapping doesn't reflow.

## Why not just let markdown-it do it natively

CommonMark says an unclosed fence implicitly closes at end of document. If we removed the pre-extract step, markdown-it (already integrated as of 0.3.0) would happily render streaming fences as `<pre><code>` line by line.

But we'd lose:
- Apply / Diff / Copy buttons
- `# File:` language inference (Moby-specific, not CommonMark)
- Expansion toggle
- Fence-flip / orphan-fence guards for R1 (`(`{3,})(`{3,})(\w*)` normalization)
- Our custom syntax highlighter (currently called from `formatContent`)

The hybrid keeps all of those.

## Sub-problems

### 1. Re-highlight cost

Syntax highlighter (`highlightCode` → likely Prism / Shiki / similar) re-parses the whole block on every render. Naïve "render on every chunk" = 100+ re-parses for a 500-line block.

**Mitigation:** throttle re-highlight to ~10Hz or every N lines. Render the raw text immediately on each chunk; re-highlight on the throttle. The `<pre><code>` content updates without needing a fresh DOM.

Worth measuring on a real streamed block before optimising. May be cheap enough not to throttle on small blocks.

### 2. Action buttons need a disabled state

Apply / Diff / Copy on incomplete code is dangerous — applying a half-streamed `edit_file` SEARCH/REPLACE block would corrupt files.

**Design:** while streaming, button row renders with `aria-disabled="true"` + a `.streaming` class for greyed-out styling + tooltip *"available when complete"*. On fence close, remove the class.

### 3. Language inference timing

`formatContent` infers TypeScript / Python / etc. from a `# File: foo.ts` header inside the block when the fence opener is generic (`bash`, `text`, `plaintext`). During streaming we may not have seen the header line yet.

**Design:** initial render uses fence-opener language. When the `# File:` line streams in, re-infer and re-highlight if the inferred language differs. One-time flicker on the first complete header line. Acceptable given the alternative is "wait for the whole block before showing anything."

### 4. The "current segment" pipeline is monolithic

`formatContent` runs over the entire `_currentSegmentContent` on every chunk. Adding "render the partial trailing fence as a streaming block" means special-casing the tail:

```
prose-with-placeholders [closed blocks already in placeholders]
+ trailing unclosed fence (if any) — render as streaming variant
```

**Design:** add a `extractTrailingOpenFence(content) → { prose, openFence: { language, body } | null }` helper to [shared/parsing/codeBlocks.ts](../../shared/parsing/codeBlocks.ts). Call it after `extractCodeBlocks` in `formatContent`. If `openFence` is non-null, render it as a streaming code-block div appended after the markdown-it-rendered prose.

The existing `hasIncompleteFence` already detects whether a fence is open at the tail; the new helper extends it to return the language + body.

### 5. SEARCH/REPLACE workflow

SEARCH/REPLACE blocks are the load-bearing edit format. Streaming a half-formed SEARCH/REPLACE looks like nonsense to the user until the closing `>>>>>>> REPLACE` arrives.

**Two options:**
- **Stream all blocks identically.** SEARCH/REPLACE blocks render with the same disabled-button treatment. Once complete, buttons go live. Visual inconsistency but uniform behaviour.
- **Detect SEARCH/REPLACE early and hide body until complete.** Show only the file header + a "Streaming edit..." placeholder, no body, until the closer arrives. Hides the noise but loses the live-typing affordance.

Recommend option 1 — uniformity beats fewer code paths.

## Phases

### Phase 1 — Streaming render of plain code blocks (½-1 day)

**Goal:** detect open fence at tail, render as a streaming code block, swap to final on close.

**Work:**
- New helper `extractTrailingOpenFence` in [shared/parsing/codeBlocks.ts](../../shared/parsing/codeBlocks.ts).
- `formatContent` calls it after `extractCodeBlocks`. Strips the tail from `withPlaceholders` before passing to markdown-it. Renders the tail as a streaming code-block div appended to the result.
- Streaming variant: same `<div class="code-block streaming">` structure but with `aria-disabled` buttons, `streaming` CSS class for visual distinction (subtle pulsing border or grey buttons).
- CSS: `.code-block.streaming .code-action-btn { opacity: 0.4; cursor: not-allowed; }` plus a small streaming indicator (subtle dot animation? "..." after the language label?).
- Strip the existing trailing-unclosed-fence guard at [MessageTurnActor.ts:2121](../../media/actors/turn/MessageTurnActor.ts#L2121) — replaced by the streaming render.

**Tests:**
- Open fence with no closer → renders as streaming variant with disabled buttons.
- Open fence + close mid-content → renders as final variant (existing path).
- Multiple closed blocks + one open at tail → both render correctly.
- Empty open fence (` ```typescript\n` with no body yet) → renders the empty body without crashing.

### Phase 2 — Throttled re-highlight (½ day, only if Phase 1 shows perf issue)

**Goal:** smooth rendering on long streamed blocks.

**Work:**
- Profile Phase 1 on a real 500-line streamed block. Measure render+highlight time per chunk.
- If > 16ms per chunk on average hardware, add a per-block render throttle: `requestAnimationFrame` or `setTimeout(0)` debouncer; raw text updates instantly, highlighter re-runs at most every 100ms.

Skip if Phase 1 doesn't show a problem.

### Phase 3 — Language re-inference on `# File:` line (½ day)

**Goal:** when fence opener says `bash` but the block contains `# File: foo.ts`, re-highlight as TypeScript once that line streams in.

**Work:**
- Detect `# File: <path>` lines in the streaming buffer per chunk. Cheap regex.
- If the inferred extension changes, replace the `<code class="language-X">` content with the re-highlighted version.
- One-time flicker per block. Acceptable.

## Risks

- **Re-render flicker.** Each chunk re-renders the whole streaming block's HTML. If we don't throttle, can stutter on slow machines. Profile + throttle.
- **DOM swap on fence close.** When the closing fence arrives, the streaming variant swaps to the finished variant. Risk: scroll jump if the height changed (it shouldn't — same content, different button state). Test on a long block with the chat scrolled to bottom.
- **SEARCH/REPLACE confusion.** Users may try to click Apply on a streaming SEARCH/REPLACE block before the disabled state lands visually. Tooltip + opacity should cover it but worth dev-host verification.
- **Highlighter cost.** If `highlightCode` synchronously parses 500 lines on every chunk, that's the throttle problem from Phase 2. Worst-case mitigation: render unhighlighted text + highlight only on close.

## What we are NOT doing

- **Streaming reasoning.** Reasoning content already streams in the thinking dropdown — separate path, not affected.
- **Streaming tool-call results.** Tool results render once when the result arrives (no streaming format from the API).
- **Full markdown-it native rendering of fences.** Documented above why — loses too much.
- **Streaming the activity label.** "Generating code..." stays as a turn-level fallback signal (and for screen readers).

## Why parked

The current state is *legible* — user sees "Generating code..." and the block appears when ready. It's just less modern than competitors. Streaming is a polish play, not a capability play.

Higher-leverage work for the next chunk of effort:
- Subagent routing ([subagents.md](subagents.md)) — measurable context savings, new capability surface.
- Per-request token instrumentation ([context-cleanup.md](context-cleanup.md) Phase 1) — unblocks all other context decisions.
- MCP client integration — ecosystem expansion.

Streaming code blocks revisits when those land or when a user complaint surfaces.

## Related

- [media/actors/turn/MessageTurnActor.ts](../../media/actors/turn/MessageTurnActor.ts) — `formatContent`, current monolithic pipeline.
- [shared/parsing/codeBlocks.ts](../../shared/parsing/codeBlocks.ts) — `extractCodeBlocks`, `hasIncompleteFence`. The new `extractTrailingOpenFence` would land here.
- CHANGELOG 0.3.0 → "Markdown rendering — markdown-it integration" — sibling change that reorganized this pipeline.
