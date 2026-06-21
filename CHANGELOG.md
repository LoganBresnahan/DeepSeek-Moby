# Changelog

## [Unreleased]

### Interrupting a generation no longer kills the new turn or races a second backend loop (ADR 0008)

Closes the on-stage interrupt failure: interrupting a running generation left the new turn's UI dead (`shellExecuting: NO CURRENT TURN ID — dropping message`) and, worse, let **two model loops run concurrently** and race on the same `write_file`, clobbering a file down to an empty shell. Two coordinated fixes:

- **Awaited teardown serialization.** `stopGeneration()` is now async and fires `generationStopped` only **after** the in-flight loop reaches its `finally` (a per-turn teardown signal resolved there). The webview's stop→`generationStopped`→send interrupt flow therefore can't begin the next turn while the prior loop is still unwinding, and the `sendMessage` handler also tears down + awaits any in-flight turn before starting (covering a bare concurrent send with no preceding stop). Only one `handleMessage` loop ever runs — the concurrent-`write_file` race is closed at the source. ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts), [src/providers/chatProvider.ts](src/providers/chatProvider.ts))
- **Request-scoped lifecycle events.** Every turn now carries a `requestId`; the chatProvider relay stamps it on the `startResponse` / `endResponse` / `shellExecuting` messages (read synchronously at fire time, so a dying request's late event carries its *own* id). The webview (`VirtualMessageGatewayActor`) routes turn state by it: a late `endResponse` from a **superseded** request is ignored instead of clearing the live turn, and a superseded shell event is dropped quietly instead of logging the misleading `NO CURRENT TURN ID`. This is defense-in-depth + diagnostics layered on top of the serialization. ([media/actors/message-gateway/VirtualMessageGatewayActor.ts](media/actors/message-gateway/VirtualMessageGatewayActor.ts))
- Decision + alternatives: [ADR 0008](docs/architecture/decisions/0008-request-scoped-stream-lifecycle-and-interrupt-teardown.md); reference: [docs/plans/interrupt-lifecycle.md](docs/plans/interrupt-lifecycle.md).
- Tests: teardown ordering (`generationStopped` fires only after the loop's `finally`) ([tests/unit/providers/requestOrchestrator.test.ts](tests/unit/providers/requestOrchestrator.test.ts)) and requestId scoping — stale end is a no-op, matching end clears, a superseded shell is not routed, version-skew back-compat ([tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts](tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts)).

### Verification-gated turn completion (ADR 0011)

A turn can no longer report **done** on a broken build or an empty/missing deliverable. This extends ADR 0006's invariant ("never report success on an edit that broke the build") from the edit-*batch* boundary to the *turn-completion* boundary, and closes the exact `914pm` failure: `Slide3Demo.razor` was clobbered down to an empty `<div>`, which **compiles fine**, so the build verdict was `clean` and the turn completed "successfully" — the user had to ask to restore it the next session. Build-pass ≠ artifact-produced.

- **Re-consults the build verdict at stop.** `EditValidator` now remembers its last batch verdict (`getLastVerdict`/`getLastBatch`); at the loop's terminal break, a trailing no-edit "done" after a `regression` gets one bounded repair pass (the captured build errors fed back) instead of completing on a broken tree. ([src/providers/editValidator.ts](src/providers/editValidator.ts))
- **Language-agnostic artifact-presence check.** A file the turn just wrote that reads back empty/whitespace holds the turn open with a "re-read and produce the content" nudge. Deliberately loose — it confirms only "present and non-empty," never "correct" — and ships **zero** language knowledge. It flags only *present-but-empty* files, never *missing* ones (a missing file is ambiguous — an intentional delete, or an unresolved path). ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- **No new loop primitive.** Bounded by the budgets ADR 0006 already owns — the per-file `maxRepairAttempts` repair tracker (an empty file `maxRepairAttempts`× in a row stops re-injecting and warns) plus the iteration cap — and a one-shot guard for the regression re-inject so it can't loop even under an unbounded (`maxToolCalls ≥ 100`) iteration cap. Yields to 0006's terminal halt; never fights it. Wired into the streaming and legacy `runToolLoop` paths; the R1 reasoner-shell path is a documented follow-up. Config: `moby.editSafety.verifyOnStop` (default `true`). Decision: [ADR 0011](docs/architecture/decisions/0011-verification-gated-turn-completion.md); reference: [edit-safety.md](docs/architecture/integration/edit-safety.md).
- 13 new tests: `EditValidator` last-verdict accessors ([tests/unit/providers/editValidator.test.ts](tests/unit/providers/editValidator.test.ts)) and the stop-boundary gate — regression re-inject (one-shot), clean+non-empty accepts, clean-but-empty holds open, per-file budget bound + warning, inconclusive accepts, missing-not-flagged, `verifyOnStop:false`, non-auto no-op ([tests/unit/providers/requestOrchestrator.test.ts](tests/unit/providers/requestOrchestrator.test.ts)).

### Web search — query ledger + near-duplicate cache (ADR 0010)

Stops the near-duplicate **search storm**: a traced auto-mode turn issued **71 `web_search` calls** (≈140 `deepseek-v4-flash` digest calls), the overwhelming majority trivial rephrasings of the same handful of targets. Pairs with ADR 0007, which deliberately makes the model search *more* for time-sensitive facts — this bounds that so it can't degenerate into a storm.

- **Normalized cache key (cost).** The web-search cache key was exact-match (`query.toLowerCase().trim()`), so `worldcup2026 schedule` and `what is the worldcup2026 schedule` were different keys and the second sailed past the cache as a miss — re-running both the provider fetch **and** the digest subagent. A conservative `normalizeQueryKey` now collapses trivial rephrasings (lowercase, punctuation→space so `salah/worldcup2026` ≡ `salah worldcup2026`, whitespace-collapse, a tiny stopword strip). It is conservative by direction: a wrong normalization degrades to a cache **miss** (harmless re-fetch), never a wrong-answer **hit** — and it deliberately does **not** token-sort, so order-distinct queries (`dog bites man` ≠ `man bites dog`) don't collide. Because a hit returns the stored post-digest string, a near-duplicate now reaches **neither** the provider **nor** the subagent — zero fetches, zero digest calls. Settings (`depth`/`maxResults`) stay in the key, so a settings change still re-fetches. ([src/providers/webSearchManager.ts](src/providers/webSearchManager.ts))
- **Per-turn search ledger (behavior).** A cache only makes a redundant search *cheap* — the model still *issues* it and burns iterations. `WebSearchManager` now keeps a per-turn ledger of the searches the model ran (keyed by normalized query, with a one-line outcome incl. `0 results (nothing found…)` dead-end notes), reset each turn in `setRecentUserPrompt`. The orchestrator appends `renderSearchLedger()` to the `web_search` tool result (`dispatchToolCall`, and the R1 path) — on the result rather than the system prompt, because the prompt is built once per turn and can't carry a ledger that grows *during* the tool loop. **A ledger, not a limit:** a hard block reads as a dead end and makes the model stop the turn; the ledger informs without halting, so it declines the redundant call but keeps working. ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- Decision + alternatives: [ADR 0010](docs/architecture/decisions/0010-web-search-query-ledger-and-cache.md); full pipeline + settings: [docs/guides/web-search.md](docs/guides/web-search.md). The `read_file` generalization is a deliberate guarded fast-follow (it's correctness-sensitive — a wrong "unchanged" feeds stale content), tracked in the ADR.
- 17 new tests: `normalizeQueryKey` (collapse, the order-distinct false-collision guard, degenerate fallback), normalized hits skipping provider + subagent, settings/TTL/`clearCache` partitioning, the per-turn ledger (rendering, near-duplicate collapse, zero-result/error dead ends, turn reset, cross-turn cache-hit ledgering) ([tests/unit/providers/webSearchManager.test.ts](tests/unit/providers/webSearchManager.test.ts)), and the orchestrator ledger-append wiring ([tests/unit/providers/requestOrchestrator.test.ts](tests/unit/providers/requestOrchestrator.test.ts)).

### System-prompt temporal grounding — always-present date + staleness directive (ADR 0007)

Closes the *confidently-stale* failure mode: a model answering a time-sensitive question from training memory and never reaching for `web_search`, because nothing in the prompt told it its knowledge might predate the event (the traced 9:14pm session asserted "the 2026 World Cup hasn't happened yet" and never searched).

- **Today's date and a staleness directive are now in the system prompt on _every_ turn**, not only when a manual-mode web search happened to pre-fetch results. Previously the date entered the prompt in exactly one place — the `--- WEB SEARCH RESULTS (<date>) ---` header — so a normal (non-search) turn carried no date and no "your knowledge may be stale" cue at all. A new always-present **`--- TEMPORAL CONTEXT ---`** block (section 4.5 of `buildSystemPrompt`, between the web-search section and active plans) supplies today's date plus an explicit instruction: for time-sensitive facts — current events, live scores/standings, prices, latest library versions, who currently holds a title — do **not** answer from memory; call `web_search` first and prefer fresh results over prior knowledge. The directive is model-agnostic ("may be out of date", no hard-coded cutoff) since Moby runs an open model registry, and degrades gracefully when search is unavailable that turn. Decision + alternatives: [ADR 0007](docs/architecture/decisions/0007-system-prompt-temporal-grounding.md); section-by-section reference: [docs/guides/system-prompt.md](docs/guides/system-prompt.md). ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- **One source of truth for the date.** `new Date().toLocaleDateString(...)` is hoisted out of the `if (webSearchContext)` branch so it is computed once per prompt build; the temporal block and the web-search header share that single value and can't drift.
- **Subagent prompts stay clean.** Per-role subagent prompts (e.g. the web-search-digest role) are built separately and do **not** inherit the temporal block — a digester ranking already-fetched results must not be told to "search first". Locked in by test.
- Pairs with [ADR 0010](docs/architecture/decisions/0010-web-search-query-ledger-and-cache.md) (per-turn search ledger + near-duplicate cache), which bounds the extra searches this directive encourages — 0007 raises search propensity, 0010 caps the cost.
- 6 new tests: temporal block present on a no-search turn, a deterministic date under a mocked clock, ordering before active plans, a single shared date source on a web-search turn, presence on the reasoner path ([tests/unit/providers/requestOrchestrator.test.ts](tests/unit/providers/requestOrchestrator.test.ts)), and the subagent exemption ([tests/unit/subagents/roles/webSearchDigest.test.ts](tests/unit/subagents/roles/webSearchDigest.test.ts)).

## [0.5.0] - 2026-06-19

### Edit safety — checkpoint + differential validation gate (ADR 0006)

Closes the *match-but-garbled* corruption case (a SEARCH that matches but a REPLACE the model emitted with dropped/mangled tokens — diagnosis in [docs/plans/improve-file-corruption.md](docs/plans/improve-file-corruption.md)). Invariant: never leave a file worse than found; never report success on an edit that broke the build.

- **Auto-mode edits are now wrapped in a fail-safe transaction.** Before each auto-applied edit — both `edit_file` SEARCH/REPLACE and `write_file` full rewrites — the file's pre-edit content is checkpointed; the tool-iteration's edits form an atomic batch. After the batch, the project's **own** check command — discovered from workspace markers (`dotnet build` / `npm run build|typecheck|test` / `make check|build` / `cargo check` / `go build`), gated by the command-approval system, no bundled language parsers — runs once. **Auto mode stays Auto** — it never demotes to per-edit approval; when an edit can't be applied safely the turn **halts** with files at last-good. Disable via `moby.editSafety.validate = off`; checkpoint-only via `moby.editSafety.checkpoint`. Decision + alternatives: [ADR 0006](docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md); reference + test matrix: [edit-safety.md](docs/architecture/integration/edit-safety.md). ([src/providers/diffManager.ts](src/providers/diffManager.ts), [src/providers/editValidation.ts](src/providers/editValidation.ts), [src/providers/editValidator.ts](src/providers/editValidator.ts), [src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- **Differential attribution — works from any starting state, not just a clean one.** The gate measures the project on the *pristine* tree before the turn's first edit (a one-time baseline probe), then classifies each batch against it: `clean` (builds), `regression` (clean→broken, or a *new* compiler error that wasn't there before — **reverted**), `held` (still broken but no new error — **kept**; the model is making progress), or `inconclusive` (no command / timeout / unapproved / unparseable — committed with a note, **never** reverted). Errors are compared as a line-shift-invariant set, so an edit that merely moves an existing error down the file isn't mistaken for a new one. The effect is a ratchet: a model fixing an already-broken file ratchets its errors down without false reverts, and only a batch that introduces a *new* break is rolled back — even from a broken start.
- **A regression reverts the batch to last-good and feeds the build errors back to the model to repair, autonomously, in the same turn.** The repair budget is **per file**: a file halts the turn only when *it* reverts with the **same** error `moby.editSafety.maxRepairAttempts` (default 3) times in a row — independent failures across different files never accumulate, and a *changing* error resets that file's budget (progress earns fresh attempts). Files repaired earlier in the turn stay committed.
- **`applyEdit` rejections no longer masquerade as success** — an edit the editor declines is no longer saved-and-reported-as-applied; it fails so the re-read loop retries.
- Reviewed adversarially before landing: a user **Stop** during the validation build, a missing toolchain (`ENOENT`), and idempotent no-op applies are all treated as inconclusive (commit, no spurious revert), never regressions. `dotnet build` / `make check` / `make build` are in the default command allowlist so the gate isn't dormant out-of-the-box. Validated end to end across every verdict (clean→clean, clean→regression→revert, broken→held, broken→clean). Known follow-ups (reverted-file "Modified Files" UX, last-iteration repair messaging, a `go build` error matcher) tracked in ADR 0006.

### Fixes — streamed responses no longer drop data on chunk boundaries

- **An SSE frame split across a network chunk boundary was silently dropped.** `streamChat` decoded and `split('\n')` each `fetch` chunk in isolation with no carryover buffer, so when one `data:` frame straddled two chunks the truncated tail failed `JSON.parse` (swallowed) and the head of the next chunk no longer started with `data: ` — losing the whole delta (content, reasoning, or a tool-call argument fragment). A multibyte UTF-8 character split across a `Buffer` boundary also decoded to U+FFFD. The stream is now framed with a persistent line buffer and a streaming `TextDecoder` (which retains an incomplete trailing code point), processing only complete newline-terminated lines and flushing any trailing partial line on stream end; CRLF endings are tolerated. This is independent of the diff-engine corruption work — model garble applies via exact match — but is documented alongside it in [docs/plans/improve-file-corruption.md](docs/plans/improve-file-corruption.md). ([src/deepseekClient.ts](src/deepseekClient.ts))
- 6 new regression tests: a content frame and a tool-call args frame each split mid-line across two chunks, complete-lines-plus-trailing-partial carryover, a multibyte char split across a byte boundary, a final frame without a trailing newline flushed on end, and CRLF framing. ([tests/unit/deepseekClient.streamChat.test.ts](tests/unit/deepseekClient.streamChat.test.ts))

## [0.4.1] - 2026-06-18

### Fixes — live "Modified Files" dropdown

- **The final auto-applied file could be missing from the live "Modified Files" dropdown** (it still showed correctly after a reload). The live dropdown is driven by a batched notification flushed at tool-batch boundaries, while restore replays the per-file `file-modified` structural events — so the last file's batch flush could be skipped before the turn ended, leaving the live dropdown one short. A final, idempotent `emitAutoAppliedChanges()` flush now runs before each end-of-response (normal / stop / error). It's incremental (`_lastNotifiedDiffIndex`), so it's a no-op when the tail was already sent, and it never touches the persisted events (restore is unaffected). Root cause and the planned single-source fix are documented as **Phase 3c** in [ADR 0003](docs/architecture/decisions/0003-events-table-sole-source-of-truth.md). ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))

### Sessions open at the latest message

- **Opening a chat now lands at the bottom (the most recent turn) instead of the top**, as if you'd scrolled all the way through. The wrinkle was the virtual list: off-screen turns carry an estimated height until they bind and measure, so the running total — and thus the true bottom — only settles as the tail turns render. `VirtualListActor.scrollToEnd()` jumps to the bottom, binds and measures the tail, and repeats synchronously until the height stabilizes, so the first paint is already pinned to the bottom with no top-then-jump flash. Called at the end of `handleLoadHistory`. ([media/actors/virtual-list/VirtualListActor.ts](media/actors/virtual-list/VirtualListActor.ts), [media/actors/message-gateway/VirtualMessageGatewayActor.ts](media/actors/message-gateway/VirtualMessageGatewayActor.ts))

### Fixes — edit application no longer silently corrupts files

- **Auto-applied edits could clobber a file and still report success.** The diff engine's last-resort *location/anchor* matching reconstructed the target region from a few distinctive lines and wrote the model's REPLACE block over it — so a single misremembered line in the SEARCH (e.g. `this.turn` rewritten as an invented `this.current`) overwrote the file's real line instead of being rejected. Compounding it, a total no-match hit the idempotent-skip path in `applyCodeDirectlyForAutoMode` and returned `true`, so the model was told the edit applied and never re-read — driving a retry-then-corrupt loop. Now: location/anchor matching is **removed**, patch matching runs at `fuzzFactor: 0` (strict context; only whitespace differences tolerated), and an unmatched block **hard-fails** (`success: false`, file unchanged) so `RequestOrchestrator` surfaces its "re-read and resend a verbatim SEARCH" guidance. ([src/utils/diff.ts](src/utils/diff.ts), [src/providers/diffManager.ts](src/providers/diffManager.ts), [src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- **Malformed `edit_file` payloads no longer masquerade as success.** A JSON parse failure on the tool arguments was logged and swallowed, leaving the generic tool acknowledgement in place; it now returns a parseable failure so the model resends. ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))
- 6 new regression tests covering the above: no-clobber on a misremembered SEARCH and whitespace-only edits still applying ([tests/unit/utils/diff.test.ts](tests/unit/utils/diff.test.ts)); no-match returns false, writes nothing, and increments the failed-apply count ([tests/unit/providers/diffManager.test.ts](tests/unit/providers/diffManager.test.ts)); auto `edit_file` surfaces the re-read guidance to the model on failure ([tests/unit/providers/requestOrchestrator.test.ts](tests/unit/providers/requestOrchestrator.test.ts)).

### Fixes — sticky scroll

- **Auto-scroll now follows every kind of streamed content, not just markdown prose.** The follow used to depend on a cached `_nearBottom` flag plus a `mousemove` handler that disengaged on any mouse nudge during streaming, so discrete content — a dropdown host or a new text container appearing in one height jump — often failed to stick the way token-by-token text did. Follow is now driven purely by an `_autoScroll` intent: it sticks while engaged, disengages only on a genuine **drag-up** (a scroll that *decreases* `scrollTop` away from the bottom — content growth and programmatic follow never qualify), and re-engages when the user returns within 100px of the bottom. The `mousemove`-to-disengage behavior is removed. Still hard-gated on `_isStreaming`, so idle virtual-list churn never scrolls the viewport. ([media/actors/scroll/ScrollActor.ts](media/actors/scroll/ScrollActor.ts))
- **A debounced follow could yank a reader who scrolled away mid-window.** `trailScroll` is queued on a 16ms debounce; it now re-checks engagement at fire time so a drag-up during that window can't snap the user back to the bottom. A numeric `scroll.request` also syncs the drag-up baseline so a programmatic jump isn't misread as a user gesture.
- **The view settled a few pixels short of the bottom when a response finished.** The end-of-stream re-renders (finalizing the last markdown, dropping the streaming cursor, completing the thinking/tool dropdowns) nudge the height *after* `_isStreaming` flips off, so the resize-driven follow ignored them. On stream end, if the user was still following, the viewport now re-snaps to the true bottom once those renders settle.
- **The "Thinking" dropdown no longer steals your scroll.** When a new reasoning step arrived, coalescing replaced the dropdown's `innerHTML` and recreated the inner scroll body at the top — yanking a reader to the top of the dropdown. `renderThinkingGroup` now preserves the body's scroll position across the re-render (pinned to the bottom if you were following it, otherwise your exact offset), and a redundant double-render per step was dropped. ([media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts))
- New `ScrollActor`/`MessageTurnActor` regression tests: follow on discrete growth, no-yank after drag-up, the debounce-window race, the scroll-request baseline, mouse-move no longer disengaging, and thinking-body scroll preservation. Change cleared a three-lens adversarial review (regression / follow / coalescing).

## [0.4.0] - 2026-06-17

### Subagent web-search digest

- **Tool-routing compression layer for web search.** Verbose web-search output is now routed through a cheap secondary model that digests it before it reaches the main model, with a fully transparent fallback to raw output on any failure (worst case it's a no-op). Entry point `SubagentRouter.route()` ([src/subagents/router.ts](src/subagents/router.ts)); the `web-search-digest` role ([src/subagents/roles/webSearchDigest.ts](src/subagents/roles/webSearchDigest.ts)); wired into both the manual (`searchForMessage`) and auto (`searchByQuery`) paths of [src/providers/webSearchManager.ts](src/providers/webSearchManager.ts). Off by default (`moby.subagents.web-search-digest`), with a user-tunable max-results cap. Declared on `deepseek-v4-flash-thinking` and `deepseek-v4-pro-thinking`.
- Added auto-mode (`searchByQuery`) routing tests, closing the prior coverage gap.

### UI — smooth dropdown open animations

- **Thinking, tools, shell, and pending dropdowns now open with the same smooth `max-height` transition as the code block.** Root cause: their click handlers re-rendered `innerHTML` on toggle, destroying the element mid-transition so it snapped open. They now flip the host `expanded` class + toggle glyph on the *persistent* element instead ([media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts)), while streaming-driven re-renders still restore the open state from the persisted flag.

### UI — coalesced thinking & tool dropdowns

- **Thinking iterations and tool batches now collapse into one dropdown per text-delimited section.** Assistant text output is the sole section delimiter; within a section every tool batch merges into a single "Used N tools" container and every reasoning pass merges into one "Thinking — N steps" container, generalizing the existing Modified/Pending Files coalescing. Previously the R1 reason→act loop produced a separate dropdown per iteration, scattering one logical turn across many boxes; interleaved tools/thinking no longer split each other. Contained entirely to [media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts) — live streaming, history restore, and scroll-rebind all funnel through the same `startToolBatch` / `startThinkingIteration` methods, so all three paths coalesce identically. Single-iteration sections render byte-identically to before.
- **Appended items slide in.** A tool call or thinking step joining an already-visible dropdown plays a one-shot entrance (`.item-enter`) instead of popping when the body re-renders; the first item of a fresh dropdown rides the container's bubble-in, status/content re-renders never replay the animation, and history restore stays silent (gated to live streaming).
- 9 new `MessageTurnActor` regression tests (merge, section split, offset-mapped status updates, group toggle, append animation, restore silence); the thinking-coalescing change additionally cleared a three-lens adversarial review (restore / streaming / CSS) with zero findings.

### Model selector defaults to V4

- The webview pre-load model state now defaults to `deepseek-v4-pro-thinking` instead of the legacy `deepseek-chat`, so fresh installs land on a current model. Reasoner-specific controls remain intact when `deepseek-reasoner` is selected. ([media/actors/model-selector/ModelSelectorShadowActor.ts](media/actors/model-selector/ModelSelectorShadowActor.ts))

### Fixes

- **V4 context budget was silently capped at 128K.** `ContextBuilder` now sources each model's input budget from the model registry's new `contextWindow` capability instead of a separate hardcoded table that never knew about V4. V4 Pro/Flash budget off their real 1,048,576-token window (reserve = the model's registered max output); Reasoner's reserve matches its registered 65K output. ([src/context/contextBuilder.ts](src/context/contextBuilder.ts), [src/models/registry.ts](src/models/registry.ts))
- **"Modified files" dropdown missing on history restore.** Auto-mode edits now always pass `filePath` to `sendCodeAppliedStatus`, so the `file-modified` structural event records — the only input that drives the restore dropdown. The previous gate on `!skipNotification` dropped it, since the real auto path passes `skipNotification=true`. ([src/providers/diffManager.ts](src/providers/diffManager.ts))
- **Sticky scroll stopped following streamed content.** User-driven scroll re-engages auto-scroll on the 100px near-bottom threshold (was an unreachable 5px while content streams), while passive content-resize stays strict so reading just above the bottom isn't yanked down. Combined with the earlier idle-scroll fix (resize-driven follow now gated on `_isStreaming`), the viewport only chases new content when you're actually at the bottom of a live stream. ([media/actors/scroll/ScrollActor.ts](media/actors/scroll/ScrollActor.ts))
- **Max output tokens slider looked dead.** `setMaxTokens` was the only slider bypassing `SettingsManager`, so it emitted no debug output and appeared to do nothing; it now logs via `settingsChanged`, sends the model id to avoid a wrong per-model-key write, and the slider label divides by 1000. ([src/providers/chatProvider.ts](src/providers/chatProvider.ts), [media/actors/model-selector/ModelSelectorShadowActor.ts](media/actors/model-selector/ModelSelectorShadowActor.ts))
- **Crash on ask-mode multi-tool batches.** An ask-mode `edit_file` opens a blocking diff approval that resets the batch mid-iteration (`closesBatch`); a later tool in the same iteration then indexed into the emptied array (`TypeError: Cannot set properties of undefined`), error-finalizing the turn. The running-status update is now wrapped in the same bounds guard the final-status block already used, in both `runStreamingToolCallsLoop` and `runToolLoop`. ([src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts))

### Housekeeping

- Dropped the invalid `"AI"` marketplace category (not an official VS Code category).
- Added `shared/**` to `.vscodeignore`.

## [0.3.0] - 2026-05-01 (Pre-Release)

### Markdown rendering — markdown-it integration

- **Replaced inline regex transforms with `markdown-it`** ([media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts) `formatContent`). The previous pipeline did a manual `escapeHtml` pass plus regexes for `<code class="inline-code">`, `<strong>`, `<em>`, and `<br>`; everything else (tables, headings, lists, blockquotes, links) leaked through as literal text. Now markdown-it (`html: false, breaks: true, linkify: true, typographer: false`) handles the prose end-to-end:
  - Tables (`| a | b |`) render properly.
  - Headings (`#`, `##`, etc.) render as `<h1>`/`<h2>`.
  - Bullet and numbered lists render as `<ul>`/`<ol>`.
  - Blockquotes (`>`) render as `<blockquote>`.
  - Links (`[text](url)`) render as anchors; bare URLs with an explicit scheme (`https://...`) auto-linkify.
  - Nested bold/italic (`**outer *inner* outer**`) handled cleanly — the previous regex couldn't.
- **HTML-escape pass subsumed.** `html: false` is markdown-it's built-in escape, so model-emitted raw HTML (`<a>`, `<u>`, `<font>`, `<script>`) still lands as escaped text rather than live DOM. Drops the manual two-pass `escapeHtml` middleware that shipped earlier in the 0.3.0 cycle as a stopgap. Closes the "purple highlighting" bug originally observed when V4-thinking emitted raw `<a href>` anchors for layout under `reasoning_effort=max`.
- **Linkify-it fuzzy modes disabled** (`fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false`). Without this, linkify-it auto-links any `name.tld`-shaped string — `tictactoe.py`, `server.io`, `build.sh`, `crate.rs`, `main.dev`, `module.co` are all real ccTLDs and were rendering as live links pointing at speculative URLs. Explicit `https://...` URLs and `[label](url)` markdown still autolink.
- **Code blocks unchanged in shape and behavior.** Fenced blocks are still pre-extracted with the apply/diff/copy buttons + `# File:` language inference + R1 fence-flip and orphan-fence guards from before. They never reach markdown-it — placeholders are surrounded by blank lines so they render as their own paragraph and the rendered code-block `<div>` doesn't end up nested inside `<p>`.
- **`.inline-code` class preserved** via a markdown-it `code_inline` renderer override; existing CSS keeps hitting.
- **Streaming-safe.** Trailing unclosed fence still stripped before markdown-it sees the prose, so mid-stream backticks don't leak as malformed inline code. Partial bold/italic mid-stream renders as text until the closer arrives — same behavior as before. Streaming code blocks themselves remain hidden until the closer arrives; the activity label still signals "Generating code..." at the turn level. Inline streaming code-block design captured in [docs/plans/streaming-code-blocks.md](docs/plans/streaming-code-blocks.md) for a future release.
- System-prompt nudge: *"Output renders as markdown. Use markdown syntax (links, tables, lists), not raw HTML tags."* added to both minimal and standard prompt variants.
- 117 `MessageTurnActor` tests pass — including 4 new linkify regression cases (file-name patterns don't autolink, explicit URLs and markdown links still do) and the existing HTML-escape guards (`<a>raw</a>` rendering as text, `<script>` not executing).

### Context cleanup — orientation-only editor header

- **Editor context shrunk to a 4-line orientation header.** `FileContextManager.getEditorContext` ([src/providers/fileContextManager.ts](src/providers/fileContextManager.ts)) now returns only `Current File / Full Path / Language / Total Lines`. Removed in this pass:
  - `--- FULL FILE CONTENT ---` block (was 20-200K+ tokens per turn for non-trivial files)
  - `--- RELATED FILES IN WORKSPACE ---` block (paths-without-content, marginal value)
  - `findRelatedFiles` subprocess work — up to 6 `find` / `rg` / `grep` spawns per request with 2-3s timeouts each (worst-case ~15s of subprocess work before the LLM call even started; typical 100-500ms)
  - `Cursor at line N` line
  - `Selected code (lines A-B): <text>` block — was a Ctrl+A / large-selection blast-radius hazard
- **Why all of it:** native-tool models (V4 series, V3 chat) have `read_file`, `outline`, `find_symbol`, `get_symbol_source`, `find_definition`, `find_references`. They can fetch precisely what they need on demand cheaper than always-on injection. R1's shell tool covers the same ground via `cat`/`sed`/etc. The orientation header still names the file the user has focused, so the model has the entry point.
- **Token impact:** sessions with the active editor open used to pay 20-40K tokens per turn for a 5K-line file (up to 200K for a 50K-line file). Now ~20 tokens regardless of file size or selection. Ctrl+A no longer matters.
- **Latency impact:** removes the per-request subprocess spend entirely.
- 40 fileContextManager unit tests still pass; tests directly asserting on the removed blocks were rewritten as regression guards (no body, no related-files, no cursor, no selection text, no `spawnSync` calls).
- See [docs/plans/context-cleanup.md](docs/plans/context-cleanup.md) for the full audit + remaining phases (instrumentation, snapshot keyFacts wiring, dead-write cleanup).

### LSP integration

- **Five LSP-backed navigation tools** for native-tool models (V3 chat, V4-flash-thinking, V4-pro-thinking):
  - `outline(path)` — symbol tree of a file (functions, classes, methods) without reading bodies. Cheap orientation for large files.
  - `get_symbol_source(path, symbol)` — slice one symbol's body without reading the whole file. Handles overloads (returns all matches).
  - `find_symbol(name, maxResults?)` — workspace-wide symbol search via `executeWorkspaceSymbolProvider`.
  - `find_definition(path, line?|symbol?, maxResults?)` — jump from a reference to its declaration. Accepts `(file, line)` or `(file, symbol)`. Handles modern `LocationLink` and legacy `Location` shapes.
  - `find_references(path, line?|symbol?, maxResults?)` — list every place a symbol is used. More accurate than grep on names; ignores comments; handles dynamic dispatch through interfaces.
- All tools call VS Code's command proxies (`executeDocumentSymbolProvider` / `executeDefinitionProvider` / `executeReferenceProvider` / `executeWorkspaceSymbolProvider`). No custom indexer, no daemon. The LSP is already running for any language the user has installed.
- Per-model gating via new `lspTools?: boolean` capability axis. Default `false`. R1 explicitly excluded (xml-shell transport doesn't surface LSP results).
- Result formatter returns absolute paths (ADR 0004 B-pattern), trimmed snippet per match, configurable `maxResults` cap (default 20, max 100), truncation note when over.
- **Per-language `LspAvailability` service** ([src/services/lspAvailability.ts](src/services/lspAvailability.ts)) — replaces the earlier global `LspProbe` (Phase 3a) which lied in mixed-language workspaces because the built-in TypeScript server made any JS-containing repo report `true` regardless of what the other languages had. The new service maps each languageId in the workspace to one of three states (`available` / `unavailable` / `untested`), feeds the partition into the system prompt as *"LSP works for: X. No LSP for: Y. Untested: Z."*, and self-corrects on every tool call via `reportToolResult(languageId, hadSymbols)`. `false → true` flips immediately on success; `true → false` requires two consecutive empties so a single stub file can't poison a whole language.
- **Reactive recovery for cold + late-installed language servers.** Five triggers populate or refresh the map: activation + 3s warmup, `onDidChangeWorkspaceFolders`, `vscode.extensions.onDidChange`, a 30s post-discovery retry that catches slow-cold servers (rust-analyzer, gopls, kotlin-lsp routinely exceed the 5s probe timeout on first launch), and an `onDidChangeActiveTextEditor` listener that schedules a 1s retry probe when the user focuses a tab in a language currently marked unavailable — so fixing your LSP setup mid-session (`gem install`, `asdf install`, editing `~/.profile`) gets reflected as soon as you click a relevant file.
- **Timeout safety wrapper** ([src/utils/lspTimeout.ts](src/utils/lspTimeout.ts)) — every `vscode.commands.executeCommand` call into an LSP is wrapped in `withLspTimeout` (5s). VS Code's command proxy doesn't expose a timeout natively, so a deadlocked Pylance / hung gopls indexer / mid-cold-start rust-analyzer would otherwise leave a tool call awaiting forever and stall the chat. Tools surface `Error: LSP request timed out after 5s — try again or fall back to grep + read_file` so the model can recover; the probe treats timeout as `unavailable` and lets the post-discovery retry catch slow-cold cases.
- **`Moby: Refresh LSP Availability` command** for users who install LSP support outside VS Code (`gem install`, `asdf install`, etc.) where no `extensions.onDidChange` event fires.
- 80 unit tests covering tool dispatch, position resolution, multi-result truncation, error paths, no-LSP fallbacks, timeout behavior, adaptive feedback, the editor-focus listener, post-discovery retry firing, and per-language threshold flips.
- See [docs/architecture/integration/lsp-integration.md](docs/architecture/integration/lsp-integration.md) for the runtime architecture and [docs/plans/partial/lsp-integration.md](docs/plans/partial/lsp-integration.md) for the design/rationale.

### DeepSeek V4 tokenizer

- **Bundled `deepseek-v4.json.br`** (1.37 MB brotli-compressed). V4 shares V3's BPE base (same 128K vocab, same merges, same pre-tokenizer/decoder/normalizer) but adds 465 new special tokens (`<think>`, `</think>`, `｜DSML｜`, file/repo markers, multimodal placeholders). Counting V4 with V3's vocab missed those tokens.
- **Auto-load on activation + session-restore.** Previously `tokenService.selectModel()` fired only on the webview's model-dropdown click — extension activation defaulted to V3 even when the restored model was V4. Now activation calls `selectModel(restoredModel)` after `initialize()`, and `chatProvider.onModelChanged` also routes to it so any model-switch path keeps the WASM vocab in sync.
- TokenCV delta on V4 turns drops from ~77% (V3 vocab) to ~10% (V4 vocab + remaining gap from server-side chat-template wrappers and tool-array overhead).
- TokenService log line includes vocab name on load: `[TokenService] Loaded "deepseek-v4" in 372ms (128000 tokens)` and emits a `Switched active vocab X → Y` line on switches.

### Database recovery

- **Auto-recovery from `SQLITE_NOTADB`** on activation. If `moby.db` exists but can't be decrypted (typically a crashed first activation that left a partial file), `openDbWithRecovery` quarantines files ≤4096 bytes (one SQLite page — structurally cannot hold user data) and starts fresh. Larger files surface a descriptive error pointing at `Moby: Manage Database Encryption Key` rather than auto-deleting potentially-real history.
- Reproduced on a clean M1 Mac install: extension crashed during first activation after creating an empty `moby.db`, leaving a zero/garbage file; subsequent activations couldn't decrypt it. Auto-recovery path resolves this case without data loss.
- Helper extracted to [src/events/dbRecovery.ts](src/events/dbRecovery.ts) for testing against real SQLCipher (8 unit tests covering both quarantine and refuse-to-discard branches).
- New user-facing guide: [docs/guides/database-recovery.md](docs/guides/database-recovery.md) with mermaid flowcharts of the auto-recovery decision tree and per-OS database file paths.

### Logging fixes

- **`[ApiCall] iter=N` counter mislabel.** `logger.setIteration` is now wired in both the streaming-tool-calls loop and the legacy `runToolLoop`. Previously only R1's shell loop pushed to the counter, so V4 turns logged `iter=1` for every iteration regardless of how many ran. The summary line now shows the actual loop iteration.
- **`VirtualList` "actor NOT bound" warnings** during session restore downgraded from WARN to debug. Off-screen turns bind only when scrolled into view; the bind-time replay loop reconstructs stored data correctly. The old WARN message (*"will be stored but not rendered"*) was misleading — data IS rendered at bind. Updated message clarifies the deferred-render pattern.

### Developer experience

- **F5 launches an isolated VS Code profile.** `.vscode/launch.json` "Run Extension" now passes `--profile=moby-dev`, so the Extension Development Host gets its own clean profile (no marketplace Moby, no inherited extensions) without needing to disable extensions globally. Survives across F5 runs; persists settings within the profile.
- **README Help section** links to recovery guides (database, custom models, logging, shell execution) plus a pointer to `Moby: Show Logs` for issue triage.
- Plan docs reorganized: completed plans moved to [docs/plans/completed/](docs/plans/completed/); partial/in-progress plans (LSP integration) live in [docs/plans/partial/](docs/plans/partial/).

## [0.1.2] - 2026-04-27 (Pre-Release)

### Fixed

- **Model selector dropdown showed only V3 + R1 on fresh installs.** `sendModelList()` was only called from `loadCurrentSessionHistory()`, which early-returns when there's no active session — so the webview kept its hardcoded V3+R1 fallback list, and V4 entries from `moby.customModels` never reached the UI. Now fires on `webviewReady` regardless of session state.

## [0.1.1] - 2026-04-27 (Pre-Release)

### Fixed

- **Extension hung in "Activating..." with no logs after 0.1.0 install.** `node_modules/node-gyp-build` was excluded from the VSIX by `.vscodeignore`, but `@signalapp/sqlcipher`'s entry module requires it at load time to locate the prebuild. Result: silent `Cannot find module 'node-gyp-build'` thrown before the extension's logger could initialize. `.vscodeignore` now whitelists `node_modules/node-gyp-build/**` alongside `@signalapp/**`.
- **`list_directory`, `read_file`, `file_metadata` failed on absolute paths inside the workspace.** `path.join(workspacePath, '/abs/path')` produced `/workspace/abs/path` (POSIX `path.join` doesn't reset on absolute second args). V4 emits absolute paths often; tools returned `Error: Directory not found` 50%+ of the time. Switched to `path.resolve` + `path.relative` boundary check so absolute-paths-inside-workspace resolve correctly while traversal escapes still get blocked.
- **VSIX shipped a 10 MB README preview gif and stale compiled `vitest.config.js`.** Added `dist/media/*.gif` and `dist/media/*.mp4` to `.vscodeignore`; build script no longer copies preview media into `dist/`. VSIX size dropped 18.97 MB → 8.95 MB.

## [0.1.0] - 2026-04-27 (Pre-Release)

### Models

- DeepSeek V4 — `deepseek-v4-flash-thinking` and `deepseek-v4-pro-thinking` — registered with full capability metadata (1M-token context, 384K-token output cap, native tool calling, inline reasoning, streaming-tool-calls pipeline)
- Default model is now `deepseek-v4-pro-thinking` — most capable native-tool + inline-reasoning + shell-access tier
- Display labels drop the "(Thinking)" qualifier (`DeepSeek V4 Pro` / `DeepSeek V4 Flash`) — V4 always reasons, the distinction was misleading and the non-thinking SKUs 400'd on iter 2 when the API expected `reasoning_content` to be echoed back
- DeepSeek V3 (`deepseek-chat`) and R1 (`deepseek-reasoner`) remain available, flagged as retiring 2026-07-24
- Per-model `reasoningEffort` override (`high` / `max`) via `moby.modelOptions` for V4 entries
- `thinking: { type: 'enabled' }` request param + `reasoning_content` echoing on tool turns for V4 compliance

### Streaming Pipeline (Phase 4.5)

- Single streaming pipeline for the V4 family: content + reasoning + tool_calls deltas surface in parallel, tools dispatch inline as they arrive, no separate non-streaming probe
- Replaces the runToolLoop + streamAndIterate split for any model with `streamingToolCalls: true` — all V4 entries opt in
- V3 chat (`deepseek-chat`) stays on the legacy split. V3 interleaves `delta.content` and `delta.tool_calls` in the same SSE stream, which can render text segments out of order relative to tool dropdowns. V3 retires 2026-07-24, so the fix would land on a sunsetting model — punting in favor of V4
- Reasoning tokens stream live during tool decisions on `-thinking` variants — visible work instead of silent gaps
- Pre-announce on tool-call metadata (id + name) so the user sees `write_file` immediately rather than waiting for argument streaming to complete
- Iteration-boundary tool-batch close mirrors the Modified Files dropdown — back-to-back tool calls collapse into one batch, breaks across iterations split into separate dropdowns
- Per-index tool-call accumulator handles fragmented OpenAI-format streaming deltas correctly

### Custom Models

- `moby.customModels` setting registers any OpenAI-compatible endpoint as a first-class model (Ollama, LM Studio, llama.cpp Server, OpenAI, Groq, Moonshot/Kimi, OpenRouter, etc.)
- Capability flags (`toolCalling`, `reasoningTokens`, `editProtocol`, `shellProtocol`, `streamingToolCalls`, `sendThinkingParam`, `reasoningEffort`, `reasoningEcho`, `promptStyle`) decide which protocols each model supports
- New commands: **Add Custom Model**, **Set Custom Model API Key**, **Clear Custom Model API Key**
- Per-model API keys stored encrypted in VS Code SecretStorage; falls back to global `moby.apiKey` when omitted
- Walkthrough docs at [docs/guides/custom-models.md](docs/guides/custom-models.md) covering Ollama, LM Studio, llama.cpp, OpenAI, Groq, Kimi

### Web Search

- Provider abstraction — `moby.webSearch.provider` toggles between `tavily` (hosted, paid) and `searxng` (self-hosted, free, no API key)
- SearXNG support: `moby.webSearch.searxng.endpoint` for instance URL, `moby.webSearch.searxng.engines` for engine selection (default: google, bing, duckduckgo)
- New **Set SearXNG Endpoint** command for one-shot config
- Tavily configuration unchanged: `moby.tavilySearchDepth`, `moby.tavilySearchesPerPrompt`

### Persistence (ADR 0003)

- Events table is the sole source of truth for session history — blob-based persistence path retired
- Session-agnostic events table + `event_sessions` join table provides M:N mapping with per-session sequencing
- Zero-copy session forking via `INSERT...SELECT` on the join table; fork metadata (`parent_session_id`, `fork_sequence`) carried separately
- Crash-recovery: partial assistant content restores with a distinct `*[Interrupted by shutdown — partial response restored]*` marker on next launch
- Live structural events == hydrated `turnEvents` round-trip pinned by fidelity tests
- Hydration perf: 10K events ~340ms

### R1 Reasoner

- Path-semantics guards (ADR 0004) — prompt rules + absolute-path ground truth in shell tool results, prevents thrash from cwd confusion across `<shell>` heredocs and SEARCH/REPLACE blocks
- `isLongRunningCommand` strips heredoc bodies before pattern matching (ADR 0002) — large heredocs no longer trigger spurious long-running detection
- File Edit Loops budget (`moby.maxFileEditLoops`) for R1 post-edit continuations
- Stop marker unification — extension owns the marker text consistently across user-stop / backend-abort / shutdown paths

### UI

- Stop button discards partial content on user-initiated stop (ADR 0001) — `*[User interrupted]*` marker without partial leakage; backend aborts keep partial content with `*[Generation stopped]*`
- Inline `<shell>` execution with per-command approval gate
- Directory click in Modified Files dropdown reveals in explorer (was erroring)
- Unfenced SEARCH/REPLACE markers no longer leak to chat UI

### Core (carried from earlier 0.1.0 snapshot)

- DeepSeek V3 (Chat) and R1 (Reasoner) model support with per-model settings
- Event-sourced conversation database with SQLCipher encryption (AES-256-CBC)
- WASM tokenizer with per-model vocabulary support
- Platform-specific VSIX packaging (6 targets)
- Three edit modes: Auto (apply immediately), Ask (accept/reject), Manual (VS Code diff tabs)
- SEARCH/REPLACE diff engine with exact, patch, fuzzy, and location-based matching
- Accept/Reject buttons in diff editor toolbar
- File watcher for shell-modified and deleted files
- Auto-continuation when code edits fail to apply (file creation nudge)

### Shell Security

- Three-layer command validation: regex blocklist, approval rules, user prompts
- Per-command approval with persistent allow/block rules
- Command Rules modal for managing rules
- Git Bash detection on Windows for cross-platform compatibility

### Sidebar / Webview

- Shadow DOM actor architecture with EventStateManager pub/sub
- Virtual scroll with actor pooling for large conversations
- Thinking dropdowns with per-iteration content
- Shell command dropdowns with output display
- Modified/Pending Files dropdowns with per-file status (applied, rejected, expired, deleted)
- Code block rendering with syntax highlighting, copy, diff, and apply actions
- "Seeking/Developing/Diving..." animation during code generation
- Expand/collapse toggle for input area

### History & Sessions

- Auto-save conversations to encrypted database
- Session forking with fork metadata
- History modal with search, date grouping, rename, export (JSON/Markdown/TXT), delete
- Expired status for unresolved pending changes on history restore

### Commands

- 26 commands under "Moby" category
- Drawing server for phone-based sketching input
- Unified log export (extension Logger + TraceCollector + WebviewTracer + WebviewLogBuffer)
- `Moby: Export Turn as JSON (Debug)` for live event-stream snapshots in devMode

### Known Limitations

- WSL2 file watcher may miss deletion events from chained shell commands (B25)
- Cross-platform coverage is incomplete — primary development is on Linux/WSL2; macOS and native Windows paths have had limited manual exercise
- Real R1 trace fixtures for regression testing are still synthetic (parked follow-up)
- V3 chat may occasionally render text segments out of order relative to tool dropdowns when content and tool_calls interleave mid-stream. V3 stays on the legacy non-streaming tool path to avoid this; V4 family uses the streaming pipeline and is unaffected
