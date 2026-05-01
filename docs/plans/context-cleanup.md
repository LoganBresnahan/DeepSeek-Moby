# Context cleanup — trim noise, instrument, swap blanket inclusion for opt-in

**Status:** Phase 2 shipped (0.3.0) — orientation-only header. Phase 3 (selection chip) dropped: tool surface covers it. Phase 1 (instrumentation), Phase 4 (cleanups) pending.
**Date:** 2026-05-01

## Context

A review of what actually lands in the LLM request (system prompt + tools array + conversation messages + snapshots) surfaced a handful of noisy paths that aren't paying their token cost on agentic models. The same review turned up open questions around the snapshot / summarization UX and a few stale event-sourcing artifacts worth mentioning here so they don't get forgotten.

This plan is the punch list.

### Per-request cost breakdown (today)

Every request to the LLM concatenates:

**System prompt** ([requestOrchestrator.ts:1142-1239](../../src/providers/requestOrchestrator.ts#L1142-L1239)) — built fresh:

| Section | Always present? | Approx tokens |
|---|---|---|
| Identity + gate | yes | ~200 |
| `buildToolGuidance` (or R1 shell prompt) | yes (per model) | ~400-700 |
| LSP declaration | when at least one language available | ~30-80 |
| Code edit format (SEARCH/REPLACE block) | yes | ~150 |
| **Editor context (active file FULL CONTENT + related files)** | when an editor is active | **20-200K+** |
| Modified files context | when there are pending diffs | varies |
| Web search results (manual mode) | when triggered | 500-3000 |
| Active plans context | plan mode only | varies |
| User custom instructions | when set | varies |

**Tools array:**
- Workspace tools: ~1200 tokens
- LSP tools (5): ~600 tokens (gated on per-language availability)
- Web search: ~150
- Shell: ~200

**Conversation messages** via [contextBuilder.ts](../../src/context/contextBuilder.ts) — fill newest-first, cap at `totalContext - maxOutputTokens - safetyMargin`. Tool-call/tool-result pairs preserved across cutoff.

**Snapshot summary** (only when truncating): fake user message + canned assistant ack.

### What we found

The dominant cost on real sessions is **the active editor's full file body, repeated every turn**. [fileContextManager.ts:364-404](../../src/providers/fileContextManager.ts#L364-L404):

- No size cap.
- Re-injected every request.
- Plus a "related files" block built by spawning `find` / `rg` / `grep` subprocesses (~3 strategies, total worst-case ~15s of subprocess work per request, no caching, ~50-200 tokens of paths).

A 5K-line TS file ≈ 20-40K tokens. A 50K-line file ≈ 200K — fits V4's 1M but blows V3/R1's 128K. Either way, the agentic models already have `read_file` and the LSP nav tools. They don't need this thrown at them on every turn.

A handful of smaller items are listed below.

## Decision

Three changes plus instrumentation, in order:

1. **Per-request token-breakdown log first.** Don't change anything until we can see the spend. Log shape: `[Context] system=N tools=N messages=N (kept K/T) editor=N relatedFiles=N snapshot=N total=N/budget`. Cheap — every section already has counted tokens. Lets us measure the impact of each cut.
2. **Drop "blanket open file" injection on agentic models.** When `caps.toolCalling === 'native'` (V4 series, V3 chat, custom native-tool models), skip the FULL FILE CONTENT block and the RELATED FILES block. Keep the header (`Current File: X / Path: Y / Language: Z / Total Lines: N / Cursor at line A`) — orientation, ~20 tokens. The model can `read_file` or `outline` if it actually wants the body. Local non-tool-calling models keep the current path (they have no escape hatch).
3. **Per-message selection injection** — opt-in by virtue of having a selection at send time. When `vscode.window.activeTextEditor.selection` is non-empty when the user clicks send, inject a bounded preamble:
   ```
   The user has highlighted lines <a>-<b> in <relPath>:
   \`\`\`<lang>
   <selection text>
   \`\`\`
   ```
   InputArea shows a chip — *"📎 Selection (foo.ts:42-58)"* — with × to clear before sending. The chip renders only when selection is non-empty at compose time. If the user clears the editor selection between chip render and send, the chip auto-dismisses and nothing is injected.

Together these mean: agentic models no longer pay to re-receive the open file every turn, but the user's *intent gesture* (highlighting code they want help with) still flows through cheaply and visibly.

## Phases

### Phase 1 — Instrumentation (≤½ day)

**Goal:** measure before changing.

Add a single log line per request summarizing token spend by section:

```
[Context] system=2143 (identity=200 tools=1850 lsp=80 editor=12000 …)
          tools_array=1800 messages=8400 (kept=12/47 dropped=35) snapshot=312
          total=24655/120000 (V4-pro budget)
```

Implementation:
- Decorate `buildSystemPrompt` to emit per-section counts as it concatenates. Each section already has its raw text — `tokenCounter.count(...)` per piece.
- `ContextBuilder.build` already logs `[Context] N/budget tokens | M dropped | summary injected` — extend with per-section breakdown.
- Output channel only — not user-facing UI. Optional: emit a `tokenUsageDetail` postMessage so the StatusPanel can show a breakdown on hover (defer, separate phase).

Acceptance: real sessions surface where the budget actually goes; the next phases are gated on "did we measurably move the needle?"

### Phase 2 — Orientation-only editor header ✅ Shipped (0.3.0)

**Decision when shipping:** dropped the file body, related-files block, cursor line, and inline selection text **unconditionally** rather than gating on `caps.toolCalling`. Pre-release with no users to break. The original plan to keep a `caps.toolCalling !== 'native'` fallback path was discarded as over-engineering — non-native models still have R1's shell tool / `cat`/`sed` to fetch content, and the cliff edge of "sometimes we inject, sometimes we don't" creates more problems than it solves.

**Shipped:**
- `getEditorContext` returns a 4-line header: `Current File / Full Path / Language / Total Lines`.
- Removed: `--- FULL FILE CONTENT ---` block, `--- RELATED FILES IN WORKSPACE ---` block, `findRelatedFiles` (with `child_process` + `path` imports), `Cursor at line N` line, and the `Selected code (lines A-B): <text>` block.
- 4 `getEditorContext` tests rewritten as regression guards: header present, no body, no related-files, no cursor, no selection text, `cp.spawnSync` not called.

**Token impact:** orientation header is ~20 tokens regardless of file size or selection. Was 20-200K+. Ctrl+A no longer matters.
**Latency impact:** removes 100-500ms typical (and worst-case 15s) of subprocess work per request.

### Phase 3 — Selection-as-context ❌ Dropped

**Why:** the tool surface already covers it. Native-tool models route "look at lines 42-58 of foo.ts" → `read_file path=foo.ts start_line=42 end_line=58` natively. LSP nav (`outline`, `find_symbol`, `get_symbol_source`, `find_definition`, `find_references`) covers symbol-shaped lookups. R1 covers the same ground via shell tools.

Adding a selection chip would have introduced:
- Pub/sub plumbing for selection state across the extension/webview boundary
- Threshold tuning + Ctrl+A guardrails + multi-cursor handling
- Setting (`selectionLineCap`) + tests + docs
- Yet another UI element to learn about

For a pre-release with no users demanding it, the simpler answer is: trust the tools. If real usage surfaces a clear "I keep highlighting code expecting Moby to see it" pattern, revisit.

### Phase 4 — Cleanups not strictly context-related but adjacent

These came up while auditing context. Track here so they don't get lost.

- **Modified-files block grows linearly with session edits.** [DiffManager.getModifiedFilesContext](../../src/providers/diffManager.ts) emits one bullet per applied file plus the boilerplate "Do NOT re-edit these files unless..." header. ~95 tokens with a single edit; 30 edits in a session ≈ 600+ tokens injected on every turn. Two options:
  - **Cap with overflow message.** Show last N (e.g. 20) modified files + `(... and M earlier files this session)`.
  - **Replace the boilerplate with a one-line summary.** `Files already modified this session (do not re-edit unless asked): a.ts, b.ts, c.ts`. Same signal, ~½ the tokens.
  - Either is cheap. Pick one after Phase 1 instrumentation shows real session profiles.
- **Edit format block is fixed cost (~150 tokens) and worth keeping.** High signal — model needs the exact SEARCH/REPLACE template every turn or it emits malformed edits. Not a candidate for trimming. Documented here so it doesn't keep coming up in future audits.
- **Snapshot `keyFacts` + `filesModified` are produced and persisted but not injected** ([src/context/contextBuilder.ts:182](../../src/context/contextBuilder.ts#L182) sends only `summary`). Either wire them in (more grounded context on truncation) or stop computing them. Decide which.
- **Dead writes in `saveToHistory`** — `recordToolCall` / `recordToolResult` / `recordAssistantReasoning` are still written but no consumer reads them post-Phase-3 of [ADR 0003](../architecture/decisions/0003-events-table-sole-source-of-truth.md). Already tracked in CLAUDE.md → "Events-table follow-ups → Small cleanups." Surfaces here because they're event-sourcing noise.
- **`_unused` placeholder param on `recordAssistantMessage`** — drop it + update call sites in one PR.
- **`contentIterations` field audit** — may be redundant now that structural events stamp per-iteration boundaries.

### Phase 5 — Tool array reduction (cross-references subagents plan)

The tools array (~1850 tokens for the full set) is always-on regardless of what the user is asking. A "what is X?" question doesn't need `delete_file` / `run_shell` / `edit_file` schemas advertised. Per-turn tool subsetting — read-only tools by default, modify tools attached only when the user's intent looks like an edit — is the natural complement to subagent routing.

This work belongs to [subagents.md](subagents.md) (the routing infrastructure is shared) but is captured here so it isn't forgotten as a context-spend lever. See [subagents.md → Phase 4](subagents.md) for the design.

## Summarization UX (separate question, related)

Surfaced during this audit; not a context-spend problem but worth fixing while we're in the area.

Today, when context pressure crosses 80% and `RequestOrchestrator` triggers a snapshot, `ChatProvider` queues incoming user messages until summarization finishes. The user sees a single transient toast — *"Queued — optimizing context..."* — that **auto-clears after 30s regardless of whether summarization actually finished**. There's no completion message when the queue drains.

**Issues:**
- 30s auto-clear is the wrong proxy. Big sessions can summarize for longer; toast disappears mid-process.
- Drain happens silently. User who queued 3 messages doesn't know which one is currently sending.
- Multiple sends during summarization overwrite the same toast slot (`showMessage` resets timer).

**Minimal fix (worth doing alongside Phase 1):**
- New `activity.label` value: *"Summarizing context"* (or `summarization` discrete state) bound to `_summarizing`. Lives in StatusPanel's activity slot, not the auto-clearing message slot. Persists for the duration.
- Per-drain toast: *"Sending queued message N of M"* on each `drainQueue` step.
- Drop the 30s auto-clear for this specific message — the persistent activity badge replaces it.

**Bigger:** queue-depth chip in InputArea with the messages user queued. Defer unless usage data shows users actually queue more than 1-2 messages during a single summarization.

## Risks

- **Models trained on always-getting-the-file may regress.** V3 chat in particular has been observed assuming the open file's content is implicitly available. Mitigation: orientation header still names the file; model can `read_file` to fetch what it needs. Watch the first turn of fresh sessions on V3 chat post-Phase-2 for regressions; if frequent, capability-gate the body back in for non-native models.
- **`findRelatedFiles` subprocess work is buried.** Removed unconditionally. Worth a quick search for `--- RELATED FILES ---` references in tests and prompts to confirm nothing else depended on it. As of shipping the only references were in the function itself.

## What we are NOT doing

- **Replacing the manual File Context Selection feature.** That stays — it's the right tool for "I want this file pinned for the whole session."
- **Selection auto-injection via chip.** See Phase 3 above — tool surface already covers this without adding UI.
- **Live editor context streaming.** Re-fetching the editor's content as the user types between turns. Out of scope; the model has `read_file` for fresh-state queries.
- **Per-section budget caps.** Don't pre-allocate "20% for editor / 30% for tools / etc." The newest-first message fill already handles overall budget; per-section caps add complexity without observable upside today.
- **Context compaction across conversations.** Cross-session memory is its own larger plan ([CLAUDE.md → Cross-session memory, deferred](../../CLAUDE.md)).

## Why this approach over alternatives

**A. Hard cap on file body size (e.g., truncate at 1000 lines for everyone).** Simpler than capability gating, but lossy in different ways: native-tool models need 0 lines (they have read_file) while non-native models need full content (no escape hatch). Capability split is cheaper for everyone.

**B. Always inject the full file but compress with a structured summary on size threshold.** Adds a summarization pass per turn — the inverse of what we're trying to do. Snapshots already pay for compression where it makes sense (long sessions); per-turn file compression is paying twice.

**C. Keep current behavior; rely on `ContextBuilder` to drop messages when budget hits.** The current behavior: `ContextBuilder` drops conversation messages first, keeping the bloated system prompt intact. This means a long session with a big open file silently loses chat history while the system prompt eats most of the budget. Fixing the system prompt at the source is more honest than relying on downstream truncation to save us.

The chosen approach (drop everything, lean on tool surface) is simpler than A and B and trusts the model to fetch what it needs.

## Open questions

- **Should the orientation header include nearest-symbol context?** ("In `function validateToken`.") Cheap if we have document symbols cached from LSP discovery, valuable for the model. Defer until Phase 1 instrumentation shows whether the bare orientation is actually too thin.
- **V3 chat regression watch.** V3 has been observed in past sessions assuming the file body is implicitly available. If post-0.3.0 V3 turns degrade — wrong file references, asking "what file?" when it's right there — capability-gate the body back in for V3 only.

## Related

- [docs/architecture/backend/event-sourcing.md](../architecture/backend/event-sourcing.md) — recently updated to flag dead writes, snapshot field gap.
- [docs/architecture/integration/lsp-integration.md](../architecture/integration/lsp-integration.md) — LSP nav tools that reduce the model's reliance on full-file injection.
- [docs/plans/subagents.md](subagents.md) — the digest-routing plan for cheaper-model summarization passes.
- [src/context/contextBuilder.ts](../../src/context/contextBuilder.ts) — message-budget logic.
- [src/providers/fileContextManager.ts](../../src/providers/fileContextManager.ts) — `getEditorContext` impl (orientation-only post-0.3.0).
