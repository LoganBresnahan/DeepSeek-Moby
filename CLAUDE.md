# DeepSeek Moby — Work Tracker

This file tracks pending bugs, in-progress work, and future ideas. Keep entries concise — link to plan files in [docs/plans/](docs/plans/) for full context.

## Architecture (read first)

- **Extension** (`src/`) — Node.js. VS Code APIs, request orchestration, persistence.
- **Webview** (`media/`) — Browser. UI rendered via Shadow DOM actors. Bundled separately by esbuild.
- **NEVER cross-import** between `src/` and `media/`. Define shared types locally.
- **Communication** — Webview ↔ Extension via `postMessage`. Inside webview, actors use `EventStateManager` pub/sub.
- Full reference: [docs/architecture/](docs/architecture/)
- Significant decisions are recorded as ADRs: [docs/architecture/decisions/](docs/architecture/decisions/)

## Skills & workflows

The development loop: orient → (design doc/ADR → design-plan) → implement phase-by-phase → shipshape at phase boundaries → verify in the dev host → pin surprises to the tracker/backlog.

- `/orient` — session-start bearing: commits + CLAUDE.md tracker + docs reconciled against memory, drift flagged. Read-only. Run on fresh sessions and after model switches.
- `/shipshape` — pre-commit verification: compile + `test:all` green twice + e2e, docs (ADRs/tracker/backlog/plans) current, conventions hold (bundle isolation, command parity, model-scope). Proposes fixes, doesn't apply them.
- `/verify` — runtime verification recipe: headless webview harness (~5s) or full extension in real VS Code via WSLg (~60s), no real API key needed. This is Moby's deploy-gate analog — `/shipshape` green does not discharge manual-test-backlog items; `/verify` (or hand-testing in the dev host) does.
- `design-plan` workflow ([.claude/workflows/design-plan.js](.claude/workflows/design-plan.js)) — decompose an accepted design doc or ADR into an effort-ranked, dependency-ordered, model-batched build checklist before implementing. Skip it for small changes where the decomposition would just restate the doc. Write the output into the plan doc (phases + verification roster).

## Release 0.7.0 — SHIPPED 2026-08-04

**`v0.7.0` published to the Marketplace, all six platforms, 2026-08-04 22:29 UTC** ([release run](https://github.com/LoganBresnahan/DeepSeek-Moby/releases/tag/v0.7.0) — 6/6 `vsce publish` succeeded, GitHub Release carries all six VSIXes). Tagged from `beea73a` after `release/0.7.0` fast-forwarded into main.

Gates that were run before the tag, for the record:

- `npm run typecheck` clean; `npm run test:all` green **twice** (3,269 tests)
- `test:e2e:harness` 45/45
- **`npm run test:e2e` (full tier, real DeepSeek tokens): 116 passed, 0 failed, 0 skipped, 8.2m.** Zero skips matters — the real-API specs self-skip silently without a key, and CI runs this same command keyless. Durations confirm real execution (W1's agentic turn 1.2m, W10's R1 shell 32.7s).

Note `release.yml` fires on the `v*` tag and publishes straight to the Marketplace across six platforms, and it runs **only** the four vitest suites — no typecheck, no e2e. Those are manual gates by construction.

**Shipped with eyes open:** the dev-host items in the [manual-test backlog](docs/plans/manual-test-backlog.md) were deliberately left undone (user call, 2026-08-04) — M37 S0/S3, M41 (phone), M40 (real-provider residuals), M42 (non-native local model), plus the fork/dedupe/GC steps of M34, M38, M39. Walk them against the shipped build; anything found is 0.7.1 material.

The five bugs below were found while exercising the image work and are all fixed (2026-08-03). Real-provider residuals are tracked as M40:

1. ~~**401 names DeepSeek on any provider**~~ — **FIXED 2026-08-03** (see Recently Fixed).
2. ~~**Timeout inert on streams; `chat()` drops its abort signal**~~ — **FIXED 2026-08-03** (see Recently Fixed; ADR 0008 follow-up updated).
3. ~~**`thinkingMode: 'disabled'` no-op on custom models**~~ — **FIXED 2026-08-03** via `disableThinkingParam` (see Recently Fixed). Release notes should still carry the guidance: a custom entry that declares no off-knob keeps paying the reasoning tax on sub-calls — pick a fast non-reasoning model for subagent roles.
4. ~~**Registry booleans that need values**~~ — **ADDRESSED 2026-08-03** (see Recently Fixed): `temperatureFixedValue` pins Kimi's must-be-1; `disableThinkingParam` covers the thinking knob (#3); `streamingToolCalls` was already runtime-valid for custom entries but invisible — now in the JSON schema so entries can declare it without a squiggle. Residual: the Kimi templates don't enable `streamingToolCalls` yet (needs one dev-host turn to confirm Moonshot streams tool deltas before the template claims it).
5. ~~**Token over-count on image turns (~2.4×)**~~ — **FIXED 2026-08-03** (see Recently Fixed; root cause was tools-JSON asymmetry, not the image data URI — the hypothesis is falsified and recorded).

Detail for each is in Recently Fixed below.

## Active Bugs

- **LSP availability probe: false negative on symbol-less sample files (found 2026-08-06, user boot logs).** The probe marks a language unavailable when its sampled file legitimately has zero symbols — `probeLanguage` treats `symbolCount > 0` as the availability signal, and discovery takes the *first* file per language ([lspAvailability.ts:304](src/services/lspAvailability.ts#L304)). Observed: `javascript: unavailable` in a workspace whose only `.js` file is the ASP.NET template's `site.js` — 4 lines of comments, so 0 symbols is the *correct* LSP answer and TS/JS (built into VS Code) was almost certainly working. Worse, the 30s post-discovery retry re-probes the **same** `state.sampledFile` ([:344](src/services/lspAvailability.ts#L344)), so it can never recover; and the editor-focus retry only helps if the user opens a *different* file of that language. Net effect: the prompt tells the model "No LSP for: javascript — use grep" for the whole session. (The `csharp: unavailable` in the same logs is likely real: the dev host launches with `--profile=moby-dev`, a separate profile with its own extension set — no C# extension there.) Candidate fixes if we keep the service: probe a file only if it's non-trivial (size/line floor), or fall back to a second sampled file on 0 symbols, or treat 0-symbols-without-error as `untested` rather than `unavailable`. **But see the deprecation question first** — [docs/plans/mcp.md](docs/plans/mcp.md) § "Relationship to the built-in LSP tools"; don't invest here until that's decided.

- **Intermittent unit-test failure — NOW NAMED (2026-08-03).** It is [`TraceCollector.test.ts` → *time-based eviction* → *evicts old events when maxAgeMs is set*](tests/unit/tracing/TraceCollector.test.ts#L585), not the `hydration-perf` wall-clock assertion previously guessed. Caught on the second of two back-to-back `test:all` runs. **Reproduction needs load:** 8 consecutive runs of that file alone were green, as were 3 further full `test:all` runs. Shape: the test sets `maxAgeMs: 50`, traces one event, sleeps 100ms, calls `evictOldEvents()` directly, and asserts `size === 0`. For it to fail the event must *survive*, and the most promising lead is [TraceCollector.ts:125](src/tracing/TraceCollector.ts#L125) — `evictOldEvents` returns early when `maxAgeMs <= 0`, so anything that resets the config between `configure()` and the manual evict (a stale `setInterval` from an earlier test's `configure`, which starts a timer at [:108](src/tracing/TraceCollector.ts#L108) and is only cleared by `dispose`) leaves the event in place and the size at 1. Unconfirmed — but it is a config-lifetime race, not a timing-margin one, and the 50ms margin against a 100ms sleep is too wide to explain it.

## Recently Fixed

- **`Map` values never survived the webview state manager (2026-08-05).** Found by dogfooding `@`-autocomplete: accepting a file silently attached nothing visible. Root cause was two gaps in core utils, not the feature — [`deepClone`](media/utils/deepClone.ts) had no `Map`/`Set` branch, so a Map fell through to the plain-object path where `Object.keys()` is empty and the clone came out `{}`; [`deepEqual`](media/utils/deepEqual.ts) had the same gap, so **any two Maps compared equal** and a state change carrying one was never detected — subscribers were never notified at all. `files.selected` has always been published as a `Map`, and nothing ever subscribed to it, which is why this sat undiscovered. Both utils now handle `Map`/`Set` (keys by SameValueZero, values deeply). Separately, the composer's context-file chip row was dead UI: `InputAreaShadowActor.updateFileChips()` had **zero callers repo-wide**, so neither the files popup nor `@` ever rendered a chip. The input area now subscribes to `files.selected`, and its chip `×` publishes `files.removeSelected` back to FilesShadowActor (which owns the selection and tells the extension) — removing only the local copy would have left the file in the model's context while the UI said it was gone.

- **Two defects from the 2026-08-04 driver verification pass (both shipped in 0.7.0).**
  - **Non-native custom models paid for every turn twice.** The legacy pipeline branch keyed on `!isReasonerModel`, so any entry without `streamingToolCalls` entered `runToolLoop` — including `toolCalling: 'none'` entries. The client only attaches tools for native tool callers ([deepseekClient.ts:438](src/deepseekClient.ts#L438)), so the probe went out with no tools, could never return a tool call, broke immediately, and had its whole answer discarded when `streamAndIterate` regenerated it. The wire log showed **four** main-model requests for a two-turn session; it now shows two. Gated on `caps.toolCalling === 'native'` at [requestOrchestrator.ts:1246](src/providers/requestOrchestrator.ts#L1246). V3 chat (the only built-in on this path) is untouched; non-native entries now behave like R1, which already skipped the loop. **Scope note:** like R1, they now sit outside [ADR 0011](docs/architecture/decisions/0011-verification-gated-turn-completion.md)'s verification gate — consistent with that ADR's stated native-tool-loop scope, but it *is* a behaviour change for local-model users. Real-provider check tracked as M42. Sharpens the earlier release-gate note that framed this as a Kimi/image-specific 41.9s observation: it is structural and per-turn. Kimi itself is unaffected — both templates are `toolCalling: 'native'` and still want `streamingToolCalls: true` (M40.2).
  - **A multi-file drop attached in encode-completion order.** [`ingestFiles`](media/actors/input-area/InputAreaShadowActor.ts#L212) fired every file concurrently and each appended its chip when its own decode finished, so a small image overtook a large one. Three dropped screenshots became chips ordered 1, 3, 2 — **and the vision calls and the digests in the main model's message followed that same scrambled order**, so a dropped sequence reached the model out of order with nothing signalling it. Both ingest seams (real `File` drops and extension-read `droppedFileContents`, which carries Explorer drags and phone drawings) are now sequential. The encodes are local and fast; the concurrency worth having is in digest routing, which is network-bound and later.

- **Freeform phone drawing revived, gated on live subagent availability (2026-08-04).** The `/draw` canvas page (parked behind compile-time `IMAGE_MODE_ENABLED = false` since before vision existed) is back, gated per request on `isImageDescribeAvailable()` ([src/subagents/availability.ts](src/subagents/availability.ts) — the same double gate the router enforces). Four consultation points: the ASCII editor's Draw Mode button (substituted at serve time, not module load), the `/draw` route (302 → ASCII when unavailable), `/health` (`imageMode` field, so an open phone page can poll), and a server-side `/upload` gate that refuses an image with a named reason when no vision model is configured — a page opened before a config change can't dead-end silently. Received drawings now ride the **one image pipeline** — posted as `droppedFileContents` into the composer (attach chip → digest on send → blob persistence → transcript thumbnail) instead of the retired `drawingReceived` path, which minted a transcript-only drawing turn the model never saw and whose restore case was a projector no-op. The QR popup shows draw-mode availability so the person starting the server learns it there, not on the phone. Cleanup note: `requestOrchestrator.recordDrawing` and the webview drawing-segment machinery are now caller-less on the live path (kept for old DBs' structural events); fold removal into the next orchestrator pass. **Drawings also flatten onto opaque white at export** — the canvas is transparent where undrawn, so the white seen while drawing was page CSS, not pixels; exported raw, the PNG composited onto the chat's dark background and handed the vision model alpha to interpret. Verified headless: zero transparent pixels across 341,040, corners opaque white, stroke intact. Dev-host verification: M41.

- **Registry axes widened for real custom models (2026-08-03, release-gate #4).** `temperatureFixedValue` on `ModelCapabilities` pins the request temperature per model (Kimi accepts only 1; the boolean could only express all-or-nothing, forcing the *global* temperature to 1 for everyone) — both Kimi templates now carry it. `streamingToolCalls` surfaced in the customModels JSON schema (runtime already accepted it; `additionalProperties: false` made declaring it an editor error, which is why kimi-as-main ran the legacy double-generation path — 41.9s for one image turn). Templates deliberately do NOT enable it until a dev-host turn confirms Moonshot streams tool deltas.
- **Custom models can declare their provider's thinking-off knob (2026-08-03, release-gate #3).** New optional `disableThinkingParam` on `moby.customModels` entries — an object of request params (e.g. `{"enable_thinking": false}`) merged into the body whenever a caller asks for `thinkingMode: 'disabled'`, which every subagent role does. We still never *invent* a param (a wrong guess is a 400): no declaration → no merge, and the practical guidance remains "point subagent roles at a fast non-reasoning model". The observed cost this closes: a 30s Kimi image digest burning reasoning tokens the router had explicitly asked to skip. Needs a dev-host check against a real provider knob before the release notes claim it works end-to-end.
- **Token "over-count on image turns" fixed — and the data-URI hypothesis falsified (2026-08-03, release-gate #5).** The image bytes never entered any counted payload. Two real defects: (a) the probe's `crossValidateTokens` counted the tools-definition JSON while the streaming site passed no `tools` at all — same turn, same messages, ours-side disagreement equal to the entire tools share (this was the 08-02 "probe counts 2.4× more" signature; ~11 tool schemas ≈ 4K tokens); (b) the calibration sample's char count covered message content only while `prompt_tokens` bills messages+tools, so every short tool-bearing turn inflated the ratio — the observed `ratio=0.7642` (~3× the English norm) came from exactly such a sample, and it alone explains `ours=10,187 api=3,012` on the kimi probe with no data URI anywhere. Image turns correlated only because they are short turns where the tools share dominates. Fix: `countRequestChars` mirrors `countRequestTokens`' traversal (content + tool_calls + tools JSON) as the calibration numerator, and the streaming validate site now passes `requestBody.tools`. The `hasImageContent` skip stays — it guards the separate digest-path shape. Also relabeled the `(with images)` request log to "(attachments on this turn)": it was attachment metadata, not wire content, and it sent the 08-03 investigation chasing a wire leak that never existed.
- **401/500/ENOTFOUND now name the active provider (2026-08-03, release-gate #1).** `handleError` derives the provider from the active model's `apiEndpoint` host (sub-clients are isolated per modelId, so `this.getModel()` at error time is the failing model); custom models are pointed at *Set Custom Model API Key* instead of the DeepSeek key setting.
- **Abort + timeout reach every request shape (2026-08-03, release-gate #2, ADR 0008 follow-up).** Three parts: `httpClient` combines caller signal + timeout via `AbortSignal.any` instead of choosing one (a caller abort keeps its `AbortError` identity; only the timeout controller maps to `ECONNABORTED`); `chat()` forwards `options.signal` so Stop cancels a non-streaming probe; and `streamChat`'s inactivity watchdog **rejects** on its zero-data branch — previously that branch did nothing and never re-armed, which was the actual mechanism behind "a hung stream never self-terminates". Timeout on streams bounds time-to-headers; the 30s watchdog owns the body.

- **Request timeout is configurable (2026-08-03).** `moby.requestTimeoutMs` (default 60000, floor 5000). Resolved **per request** via a function rather than pinned at construction — `HttpClient`s are cached per endpoint, so a fixed number would freeze whatever the setting was when that endpoint was first used. Fixes turns lost mid-loop on slow providers.
- **Image-bearing requests no longer poison token calibration (2026-08-03).** `crossValidateTokens` measured the same image two incompatible ways: `countRequestTokens` scored it as the literal `'[image]'` (~2 tokens) while the calibration char count stringified the whole base64 data URI (~21,600 chars) — `1133/21646 = 0.052`, matching the observed `ratio=0.0499`. Neither models what the API bills, so an image-bearing request is now skipped as a calibration sample entirely (`hasImageContent` guard). Modelling image tokens properly is a separate follow-up.
- **Attachments now survive a reload (2026-08-02, ADR 0014 — Phase 0 of image-describe).** Attachment bodies persist to a content-addressed `attachment_blobs` table (schema v1 → v2, the first versioned upgrade) linked via `event_blobs`; `events.data` carries only a reference, so hydration stays cheap. `formatAttachmentsForContext` ([attachmentContext.ts](src/events/attachmentContext.ts)) has a **single** call site — `getSessionMessagesCompat` — and the live injection in the orchestrator is **deleted**, because record-before-read means two callers would double-inject the current turn. Persisted bodies are capped at 256KB with an explicit truncation marker. Blob GC rides `deleteSession`'s existing orphan-cleanup transaction. Still needs dev-host `/verify` (reload + fork) — see the manual-test backlog.
- Agentic-loop hardening (shipped in 0.6.0, ADRs 0005–0013):
  - TypeScript module resolution pinned to `preserve` + `bundler` — [ADR 0005](docs/architecture/decisions/0005-preserve-bundler-ts-module-resolution.md)
  - Edit safety: checkpoint, atomic batch, differential post-apply validation against a pre-edit baseline probe — [ADR 0006](docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md)
  - System-prompt temporal grounding: standing date + staleness directive (subagents exempt) — [ADR 0007](docs/architecture/decisions/0007-system-prompt-temporal-grounding.md)
  - Request-scoped stream lifecycle + serialized interrupt teardown (`requestId` stamping at the chatProvider relay) — [ADR 0008](docs/architecture/decisions/0008-request-scoped-stream-lifecycle-and-interrupt-teardown.md)
  - Active-plan recency pinning: change-driven re-pin with 6-iteration fade backstop, both agentic loops — [ADR 0009](docs/architecture/decisions/0009-active-plan-recency-pinning.md)
  - Web-search query ledger + near-duplicate cache (ledger rides on the tool result, not the system prompt) — [ADR 0010](docs/architecture/decisions/0010-web-search-query-ledger-and-cache.md)
  - Verification-gated turn completion for the native-tool loops (R1 reasoner-shell break deferred) — [ADR 0011](docs/architecture/decisions/0011-verification-gated-turn-completion.md)
  - Project-root awareness (workspace root ≠ project root) + shell-segment coalescing — [ADR 0012](docs/architecture/decisions/0012-project-root-awareness.md)
  - Temporal grounding II: data-seeding reframed as a time-sensitive lookup; behavioral recency pin designed but deferred — [ADR 0013](docs/architecture/decisions/0013-temporal-grounding-data-seeding.md)
- markdown-it integration in `formatContent` ([media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts)). Replaced inline regex transforms with `markdown-it` (`html: false, breaks: true, linkify: true`). Tables, headings, lists, blockquotes, autolinks all render correctly; manual `escapeHtml` pass subsumed by markdown-it's built-in escape. Fenced code blocks still pre-extracted with apply/diff/copy buttons + `# File:` language inference. `.inline-code` class preserved via renderer override. Streaming guards (R1 fence flip-flop, orphan fences, trailing unclosed fence) all intact.
- LSP-backed navigation tools (Phase 1+2+4): `outline`, `get_symbol_source`, `find_symbol`, `find_definition`, `find_references` via VS Code's command proxies. Per-model gating via `lspTools` capability + per-language `LspAvailability` service (replaces global `LspProbe` from Phase 3a). System prompt declares `LSP works for: X. No LSP for: Y.`; reactive recovery via 30s post-discovery retry + `onDidChangeActiveTextEditor` re-probe; 5s timeout wrapper on every `executeCommand` site. See [docs/architecture/integration/lsp-integration.md](docs/architecture/integration/lsp-integration.md) (runtime) and [docs/plans/partial/lsp-integration.md](docs/plans/partial/lsp-integration.md) (design).
- DeepSeek V4 tokenizer (`deepseek-v4.json.br`) shipped + auto-loaded for V4 entries on activation/session-restore (selectModel was previously only firing on webview dropdown clicks).
- `[ApiCall] iter=N` mislabel fixed — `logger.setIteration` now wired in both streaming-tool-calls and runToolLoop loops.
- HTML escape in `formatContent` ([MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts)) — model-emitted raw `<a>`/`<u>`/`<script>` tags now render as escaped text; markdown + fenced code blocks unaffected. Two-pass placeholder substitution preserves code-block extraction.
- SQLCipher `SQLITE_NOTADB` recovery: garbage <4KB partial-init files quarantined automatically; >4KB undecryptable files surface a descriptive error with hint to `Moby: Manage Database Encryption Key`. See [docs/guides/database-recovery.md](docs/guides/database-recovery.md).
- R1 path-semantics guards: prompt rules + absolute-path ground truth in shell tool results — see [ADR 0004](docs/architecture/decisions/0004-r1-path-semantics-guards.md)
- Events table is the sole source of truth for session history; blob persistence path retired — see [ADR 0003](docs/architecture/decisions/0003-events-table-sole-source-of-truth.md) and [plan](docs/plans/completed/events-table-sole-source-of-truth.md)
- Directory click in Modified Files dropdown now reveals in explorer instead of erroring
- Stop button discards partial content (user-initiated only) — see [ADR 0001](docs/architecture/decisions/0001-stop-button-discards-partial.md)
- `isLongRunningCommand` strips heredoc bodies before pattern matching — see [ADR 0002](docs/architecture/decisions/0002-strip-heredocs-before-long-running-check.md)
- ContentTransformBuffer shell tag execution
- Inline `<shell>` execution with per-command approval
- Stop marker unification (extension owns the marker text now)
- File Edit Loops budget for R1 post-edit continuations
- Unfenced SEARCH/REPLACE markers leaking to chat UI
- Command approval for full chained commands (no splitting)
- `measureTurnHeight` log spam (filtered to >50px deltas)
- R1 prompt strengthened to enforce `<shell>` tags

## Manual test backlog

Recent changes awaiting dev-host verification are tracked in [docs/plans/manual-test-backlog.md](docs/plans/manual-test-backlog.md). Keep that list current as new user-visible changes land.

## Verification — exercise in dev host

### Testable right now

Everything ADR 0003 promises, plus the R1 path-semantics fix from ADR 0004:

- **Happy-path turns.** New chat, multi-iteration R1 reasoning + shell, code blocks, approvals, file edits, tool calls — all render the same as before.
- **Crash-recovery (the original bug).** Start a turn, wait for an approval prompt (or any mid-stream point), kill VS Code, reopen → partial content restores with a distinct `*[Interrupted by shutdown — partial response restored]*` marker. Whole motivation for ADR 0003; worth exercising.
- **ADR 0001 markers still work.** User-initiated stop shows `*[User interrupted]*`, backend abort shows `*[Generation stopped]*`. Distinct from the shutdown marker.
- **Session switch / history sidebar.** Loading older sessions hits the new hydration path.
- **Fork.** Still zero-copy via the join table; structural events follow automatically.
- **`Moby: Export Turn as JSON (Debug)`** — in devMode, opens a live snapshot of the extension-authored event stream. Useful for seeing what Phase 1–2.5 actually emits.
- **Large sessions.** Perf test shows 10K events in ~340ms; real sessions of normal size should feel instant.
- **R1 path semantics (ADR 0004).** R1 creating files across a mix of `<shell>` heredocs and SEARCH/REPLACE blocks should no longer thrash due to cwd confusion. Shell tool results now include `--- Files touched by this command (absolute paths) ---` sections. Run a task that asks R1 to `mkdir X && cd X` then write files in subsequent shells — verify R1 self-corrects when its assumptions don't match the returned absolute paths.

### Not testable yet (by design)

- **Real R1 trace fidelity.** We test synthetic streams today. Capturing actual R1 output into fixture files is a parked follow-up.
- **Phase 3b (lazy load).** Only matters if you hit sessions large enough to feel the eager-load delay. Probably not visible until many thousands of turns.

**Debug tools:** `Moby: Export Turn as JSON` + `Moby: Show Logs` (unified log) are primary for investigating anomalies.

## Planned Work

Items are labeled by area and rough leverage. See ADRs linked where relevant.

### Next up (ordered by leverage, 2026-07-31)

1. **Subagent Phase 2 — `image-describe` — CODE-COMPLETE 2026-08-03; SHIPPING IN 0.7.0. Verification largely discharged 2026-08-04; what's left needs a real vision provider and a phone.** All plan phases have landed: 0 (attachment persistence + replay, [ADR 0014](docs/architecture/decisions/0014-attachment-persistence-and-replay.md)), 1 + 1b (foundations, webview image capture, drag-and-drop attach), 2–3 (the [`image-describe` role](src/subagents/roles/imageDescribe.ts) + orchestrator routing), 4 (512px archive rendition), 5 (transcript thumbnail render + lazy blob fetch), 6 (backlog entries + jsonMode instrumentation). Vision works by **digest routing** — a separate vision model describes the image and the main model reads only text, because DeepSeek's API is text-only. Load-bearing design points, in case they look arbitrary later: digests resolve **before** `recordUserMessage` (plan §7 option (i)) so they persist on the attachment and replay by construction; images never touch the text `--- Attached Files ---` formatter; a failed route becomes a *named* placeholder, never silence; `assertNoArrayContent` at the single `contextMessages` choke point keeps `image_url` blocks away from the main model; and phase 5 draws attachment chips from **one** render path shared by live and restore, because a restore-only path is the failure mode that passes every live test. The jsonMode-on-VL-backend question is [answered](docs/plans/image-describe-subagent.md#the-jsonmode-question-answered-2026-08-03) — contingency not needed. **What's actually left (2026-08-04):** a scripted driver pass — headless Chromium for the real canvas, plus the full extension in real VS Code against a fake dual-role backend with every request logged — closed **M38 but for dedupe**, **M37 S1/S4/S5/S6**, **M34 steps 1–3**, **M39 steps 1–2**, and **M35 steps 2/6**. The wire log settles the load-bearing claim: across every main-model request, zero array content, zero `image_url`, zero base64 in any string. Remaining work needs what a driver can't reach — a real VL backend (M37 S3 — does it honour `response_format`?), a real phone (M41), real OS/Explorer drag payloads (M36), and DB-level observation of dedupe/truncation/GC (M34 4–7, M38 6, M39 3–9). See [manual-test-backlog.md](docs/plans/manual-test-backlog.md). Plan: [docs/plans/image-describe-subagent.md](docs/plans/image-describe-subagent.md) (supersedes the Phase 2 section of [subagents.md](docs/plans/subagents.md)).
2. **Composer autocomplete — CODE-COMPLETE 2026-08-05, all 5 phases shipped; only the dev-host walk of [M43](docs/plans/manual-test-backlog.md) remains.** Typed invocation in the composer: `/` commands, `@` files, `:` emoji (1,913 shortcodes vendored from `gemoji` v8.1.0). One webview actor + provider registry; the textarea stays a plain textarea — accept converts to a chip, a command, or inserted text, never an inline token. Detection matches on `composedPath()` and opens only on *keyed* input; arbitration is a document-capture keydown attached only while the overlay is visible, so a closed overlay leaves the composer byte-for-byte unchanged. Coverage: 133 unit tests + 37 harness specs (tier 45 → 82), bundle +78.5KB. **Two load-bearing lessons:** the real-browser tier caught the overlay rendering off the top of the viewport (the popup base pins *bottom* to the anchor, so a tall list grew off-screen — it now caps height and flips below), and dogfooding caught that `Map` values never survived `deepClone`/`deepEqual`, which is why the attach chip never rendered. **Known limitation:** queries are single-token — whitespace ends a span, so `/export logs` is not expressible (ADR 0015 revisit trigger). This is the landing surface for MCP prompts (`/`) and resources (`@`). Plan: [docs/plans/composer-autocomplete.md](docs/plans/composer-autocomplete.md); decisions: [ADR 0015](docs/architecture/decisions/0015-composer-autocomplete-typed-invocation.md).
3. **MCP client integration (Large) — scope decided 2026-08-04.** v1 = stdio only, user-scope config = trusted (no per-call approval), tools + `instructions` + roots + `listChanged`; prompts + resources are a later phase riding composer autocomplete (resources ≈ free via the `@` provider + `droppedFileContents` ingestion seam). Use `@modelcontextprotocol/sdk`; namespace tools `mcp__<server>__<tool>`; `McpServerManager` mirrors `LspAvailability` (cached registry, no I/O at array-build). Prerequisite refactor: extract the duplicated tools-array build into one `buildToolsArray()`. Known gaps to close: string-prefix error convention (conform, don't fix), no generic tool timeout/abort, tools-JSON invisible to the token-budget guard. Test server: pharos-mcp (local, tools-only, 34 curated + ~19 debug tools behind a config allowlist — count varies, never assert it). **Design doc written 2026-08-05:** [docs/plans/mcp.md](docs/plans/mcp.md) — grounded in code (both duplicated tools-array sites named, dispatch/error/timeout conventions verified). **Decomposed 2026-08-06** via design-plan workflow: 12 slices, 5 phases (seams → fable core → lifecycle/surfaces → tests → hardening+ADR), checklist in the plan doc. Also carries the built-in-LSP deprecation gate (see Active Bugs). Ready to implement Phase 1.
4. **Webview CSP (Small).** `getHtmlForWebview` emits no Content-Security-Policy `<meta>` tag (found 2026-08-03 during the phase-5 adversarial review). Every innerHTML interpolation is one missed escape away from script execution; a standard VS Code webview CSP (nonce'd scripts, `img-src data:`) turns that class of bug into a rendering glitch. The phase-5 review fixed the one live attribute-injection vector (quote-escaping in `escapeAttr`), but the belt needs the suspenders.
5. **Path-permission rules (Small).** Declarative read/write restrictions on file paths (e.g. *"never read .env"*, *"never write outside src/"*). Aligns with `CommandApprovalManager`'s pattern but for the file capabilities. Glob-based config in settings. Small but high security win — existing extension trust model leans entirely on shell approval today.

### Deferred / data-gated

- **Cross-session memory.** cavemem-shaped (per-user observation store with FTS + decay). Big effort. Defer until subagents prove out and we see real usage signals demanding it.
- **Sandbox / pluggable FS backends.** In-memory, container-wrapped shell, custom backends. Power-user value, complexity-heavy. Skip until users ask.
- **Skills format support.** Anthropic SKILL.md folder convention. Smaller scope than MCP. Adopt only if user demand arises.
- **MCP server (Moby exposes capabilities).** Lower leverage than client. Worth doing once Moby has unique capabilities other clients want (subagent routing, etc.). Defer.

### R1 polish

- **Giant-command approval UX.** 24KB heredoc previews are unreviewable (observed in tictactoe trace, 2026-04-20). Smallest useful fix: when command > ~2KB, collapse the heredoc body behind a "Show full content (N chars)" expander; show command shape (`cat > file << 'EOF' ... EOF`) + body size as summary.
- **Observe.** Run more complex R1 tasks post-ADR-0004, capture traces. If path-confusion thrash is closed and *new* thrash shapes emerge, revisit the detector question with data (see ADR 0004, Alternative B).
- **Parked:** thrash detection. Data-gated per ADR 0004.

### E2E harness invariants (learned 2026-07-31 — don't regress these)

- **Edit-mechanism tolerance is a permanent requirement, not an R1 workaround.** Models without native tool calling answer an edit request with a SEARCH/REPLACE block (Ask mode renders accept/reject), but the same model may shell out to `sed` instead — the file just changes and no approval UI appears. Both are correct product behaviour. `waitForEditMechanism` ([tests/e2e/helpers/workflow.ts](tests/e2e/helpers/workflow.ts)) waits for whichever happens and reports it; tests branch instead of hanging. This outlives R1's retirement: it covers users running R1 locally via Ollama and any future text-only model. Ditto `waitForFileChange` for auto mode, where a model that declines to edit is a model choice, not a failure.
- **Never count rendered turns.** `VirtualListActor` recycles off-screen turns ([VirtualListActor.ts:257](media/actors/virtual-list/VirtualListActor.ts#L257)), so in a long conversation the rendered count stops growing and any "wait until count increases" check hangs forever. Wait on turn *identity* via `getLastAssistantTurnId` instead.
- **Never wait only for streaming to end.** The stop button is `display:none` until the first token, so a naive check passes before generation starts and the assertion reads an empty turn. `sendMessageAndWait` settles on rendered-content stability instead.
- **The e2e VS Code instance must pre-authorise shell.** `launchVSCode` seeds `moby.allowAllShellCommands`; without it the first shell-using response blocks on a "Command approval required" prompt no test answers, hanging the run until timeout.
- **Real-API agentic turns need >120s.** R1 applies an edit then runs its post-edit continuation loop; a single W1 turn takes ~2 min. Workflow tests budget 300s.
- **Model expectations come from the registry.** Assert against `DEFAULT_MODEL_ID`, never a hardcoded name — two specs went stale when the default moved to V4 Pro. Where the label isn't id-derived (HeaderActor hardcodes "Chat (V3)" / "Reasoner (R1)"), assert the *property* the test is named for instead of any name at all.
- **Don't put shared setup in a test.** Retries run in a fresh worker that re-runs `beforeAll` but not earlier tests, so state assigned by a "Setup" test is undefined for everything after the first retry. `webview`/`frame` are acquired in `beforeAll`.
- **Never select a session by list position.** W5 clicked `entries[1]` ("the second entry — first is the new empty one"), which holds only when nothing else creates sessions. Under `mode: 'default'` other tests do, so the click restored an unrelated empty session and the test read as a *restore* bug — green alone, red in a full run. Capture the id from `.history-entry.active` before leaving the session and select `[data-session-id="…"]` (`getActiveSessionId` + `selectSessionById` in [workflow.ts](tests/e2e/helpers/workflow.ts)). Same identity-over-position rule as `getLastAssistantTurnId`.
- **The file is `mode: 'default'`, deliberately.** Under `serial`, one slow model response skipped ~30 unrelated tests and hid every downstream failure — the reason this suite took ten full runs to repair. Blocks whose steps genuinely build on each other (W1/W2/W3/W9) declare `mode: 'serial', retries: 2` locally.
- **Approval needs its own instance.** The shared instance sets `allowAllShellCommands: true`, which would make an approval test vacuous, so W14's approval case launches a second VS Code with the setting off and asserts the prompt really gates execution.
- **Prefer waiting on the state you assert.** Fixed `waitForTimeout` sleeps before status assertions were a recurring flake source; wait for the class/attribute you are about to check, with a timeout.

### Testing infrastructure (added 2026-07-31)

- **Protocol orphan cleanup (Small).** The drift detector ([tests/integration/protocol-drift.test.ts](tests/integration/protocol-drift.test.ts)) found 12 dead postMessage types: 7 webview→extension sends with no handler (SessionActor: `clearSession`/`createSession`/`loadSession`/`getHistoryList`/`setModel`; SettingsShadowActor: `getDefaultSystemPrompt`/`setLogColors`) and 5 extension→webview (chatProvider: `activeDiffChanged`/`autoContinuation`/`editRejected`/`showEditConfirm`/`waitingForApproval`). Each is either a vestigial sender to delete or a missing handler to restore — triage individually, then shrink `knownOrphans`.
- **vscode-at-the-edges, remaining slices.** Slice 1 landed (`f0e3a00`). Ranked remainder from the 2026-07-31 import-topology survey: (a) commandApprovalManager → TypedEmitter + local `KeyValueStore` for `Memento`; (b) webSearchManager → TypedEmitter + inject `digestMaxResults` (~400 lines of cache/ledger logic freed); (c) UnifiedLogExporter → split pure `format*` into `logFormatters.ts`; (d) vertical splits of serviceLocation / editValidation / workspacePaths (each has a pure top half); (e) requestOrchestrator: extract the 5× duplicated `ShellFileWatcher` block + collapse 10 scattered `getConfiguration` reads into one injected config — do NOT touch its EventEmitters/abort paths in the same pass; (f) searxngClient/webSearchProviderRegistry/subagents-router keep runtime `getConfiguration` — narrow later, not type-only candidates.
- **Real-trace goldens (upgraded from "parked").** `Moby: Export Turn as JSON` is the capture tool: run real R1 tasks, save raw event streams under `tests/fixtures/traces/`, replay through ContentTransformBuffer / turn rendering, pin outputs. Kills the synthetic-stream tautology.

### Cross-model infrastructure

- **Loading indicator: dynamic activity text (Medium).** Streaming indicator currently shows "Writing src/game.ts..." once and doesn't update. Make it reactive: "Thinking" during reasoning tokens, "Running cat tsconfig.json" during shell execution, "Writing styles.css" when a code block streams. Natural byproduct of the ADR 0003 event stream.
- **Token CV residual gap (Low).** After V4 vocab fix, TokenCV delta sits at ~10% (constant ~3K tokens regardless of content size). Likely server-side chat-template wrappers (`<｜begin_of_sentence｜>` x N) and tools-array overhead the WASM counter doesn't model. Optional: count after final wire serialization to close. Not blocking.

### Events-table follow-ups (ADR 0003 parked items)

Not formal phases — parked items from [docs/plans/completed/events-table-sole-source-of-truth.md](docs/plans/completed/events-table-sole-source-of-truth.md):

- **Phase 3b — Per-turn lazy load (2–3 focused days).** Split `loadHistory` into headers + on-demand `requestTurnEvents(turnId)`. VirtualListActor visibility callback triggers requests; cache loaded turnIds. Deferred until real usage surfaces the need.
- **Small cleanups:**
  - Remove dead writes in `saveToHistory` (`recordToolCall` / `recordToolResult` / `recordAssistantReasoning` — nothing reads them anymore).
  - Drop the `_unused` placeholder param from `recordAssistantMessage` and update all call sites in one PR.
  - Audit `contentIterations` field — may be redundant now that structural events carry per-iteration stamping.
- **Parked features:**
  - Inspector live event feed (extends `InspectorShadowActor` with a streaming view of structural events).
  - `Moby: Replay Last Turn` command (replays a saved turn in a fresh view for visual diffing during development).
  - Real R1 trace fixtures for regression testing (currently synthetic).

### Beta release blockers

See [docs/plans/completed/beta.md](docs/plans/completed/beta.md) for the priority table.

## Key Files (frequently touched)

- [src/providers/requestOrchestrator.ts](src/providers/requestOrchestrator.ts) — Request pipeline, R1 shell loop, abort handling
- [src/providers/chatProvider.ts](src/providers/chatProvider.ts) — Coordinator, webview bridge, message router
- [src/providers/diffManager.ts](src/providers/diffManager.ts) — Diff lifecycle, edit modes
- [src/tools/reasonerShellExecutor.ts](src/tools/reasonerShellExecutor.ts) — R1 shell parsing/execution, system prompt
- [media/actors/message-gateway/VirtualMessageGatewayActor.ts](media/actors/message-gateway/VirtualMessageGatewayActor.ts) — Webview ↔ extension boundary
- [media/actors/turn/MessageTurnActor.ts](media/actors/turn/MessageTurnActor.ts) — Per-turn rendering

## Testing

- `npm run compile` — webpack build
- `npm run typecheck` — `tsc --noEmit` over the whole project
- `npx vitest run` — full suite (3000+ tests, ~8s). The historical worker OOM was fixed (root cause: a global `vi.resetModules()` beforeEach — see the comment in [vitest.config.ts](vitest.config.ts)); single-process full runs are fine now.
- `npm run test:all` — same suites split into unit/actors/events/integration (what CI runs)
- Targeted: `npx vitest run tests/unit/providers tests/unit/tools`
- CI ([ci.yml](.github/workflows/ci.yml)): typecheck → build → four suites → `test:e2e` under xvfb. It runs the *full* e2e command but has no `DEEPSEEK_API_KEY`, so the real-API specs self-skip — broader than `/shipshape`'s harness tier, narrower than a release run.

### The three e2e tiers — pick by cost

Playwright specs differ enormously in what they cost to run, and the config has no project filter, so `playwright test` means *all of them*. Use the tier that matches the moment:

| Script | Specs | Cost | When |
| --- | --- | --- | --- |
| `test:e2e:harness` | webview-rendering, golden-rendering, smoke | ~45 tests, ~90s, no VS Code, **no model calls** | every `/shipshape` |
| `test:e2e:vscode` | vscode-integration, chat-model-boot | launches real VS Code (needs a display: WSLg locally, xvfb in CI); its API-flow tests self-skip without a key | when the extension host or activation path changed |
| `test:e2e` | everything, incl. the workflow suite | ~116 tests, ~7.5m, **real DeepSeek tokens** | **release gate** — before cutting a release, plus after changes to request/streaming/edit paths |

The real-API specs self-skip when `DEEPSEEK_API_KEY` is unset ([workflows.spec.ts:73](tests/e2e/workflows.spec.ts#L73), [vscode-integration.spec.ts:242](tests/e2e/vscode-integration.spec.ts#L242), [chat-model-boot.spec.ts:21](tests/e2e/chat-model-boot.spec.ts#L21)), which is how CI runs the full command without a key and still gets a meaningful pass.

Known blind spot: the harness tier replays hand-authored event streams and never launches the extension, so it cannot catch a missing event *producer* in `src/` or a broken harness assumption in the workflow suite. The W5 history-restore bug (2026-07-31) was invisible to every tier except the full one.

## Conventions

- Don't write multi-paragraph code comments. One short line max for non-obvious WHY.
- Don't add backwards-compat shims unless explicitly needed.
- For UI changes, manual test in VS Code dev host before claiming done.
- Use Markdown links with relative paths: `[file](src/file.ts)` or `[file:42](src/file.ts#L42)`.
- **Model-scope annotations.** When adding behavior that only applies to one model (R1 vs Chat vs future V4), note the scope in a source comment — especially when the code lives in a file/function whose name is not self-evidently model-specific. Never put model-scope notes inside prompt template strings (they leak to the model). See [ADR 0004](docs/architecture/decisions/0004-r1-path-semantics-guards.md) for the policy on tool-surface vs detector-style guards.
