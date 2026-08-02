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

## Active Bugs

- **Attachments never survive a reload (found 2026-08-02, not yet fixed).** `recordUserMessage` is called without `attachments` ([requestOrchestrator.ts:855](src/providers/requestOrchestrator.ts#L855)), and the `--- Attached Files ---` block is appended to the *ephemeral* per-request array ([requestOrchestrator.ts:1051](src/providers/requestOrchestrator.ts#L1051)), so nothing about an attachment is persisted. A reloaded session rebuilds model context without it, silently differing from the conversation that actually happened; [ConversationManager.ts:805](src/events/ConversationManager.ts#L805) has been mapping `attachments` → `files` for UI restore against permanently-`undefined` data. Survivable for text (the file is still on disk) but **fatal for the incoming image digests**, which are the only record of an image whose full-res bytes are deliberately not kept. Fix is Phase 0 of [image-describe-subagent.md](docs/plans/image-describe-subagent.md#7-attachment-replay-the-correctness-prerequisite) — one `formatAttachmentsForContext` with a **single** call site (the replay path; the live injection gets deleted, since record-before-read means two callers would double-inject the current turn).
- **Unidentified intermittent unit-test failure (~1 in 14 runs, 2026-07-31).** One `test:all` run reported `1 failed | 2059 passed` in the unit suite; 14 subsequent full runs were clean and never reproduced it, so the test was never named. Most likely shape is a wall-clock assertion — the only obvious candidate is [hydration-perf.test.ts:75](tests/unit/events/hydration-perf.test.ts#L75) (`elapsedMs < 2000`, typically 370–560ms, ~4× headroom). Next time a run goes red, capture the failing test name before re-running — that is the missing datum.

## Recently Fixed

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

1. **Subagent Phase 2 — `image-describe` (Medium).** Phase 1 (`search-digest` + `web-search-digest` routing scaffolding) shipped in 0.6.x. Next: vision via digest routing — auto-digest on image attach, backend-agnostic (user-configured vision model, no bundled default), 512px WebP thumbnail + digest persisted as content-addressed blobs beside the events table. Decision-locked plan: [docs/plans/image-describe-subagent.md](docs/plans/image-describe-subagent.md) (supersedes the Phase 2 section of [subagents.md](docs/plans/subagents.md)); revised 2026-08-02 with decisions 4–6. **Start at Phase 0** — attachment persistence + replay, which fixes the Active Bug above and ships standalone value for text attachments before any image code lands.
2. **MCP client integration (Large).** Spawn external MCP servers declared in `moby.mcpServers` setting (mirror Anthropic's `claude_desktop_config.json` shape so users can copy-paste). Register their tools through the orchestrator's tool-array build alongside built-ins. Same per-turn gating as LSP/web-search (tool excluded if server unavailable). Instant ecosystem expansion (filesystem, GitHub, Linear, Slack, Postgres, Brave, Notion, …). New plan needed.
3. **Path-permission rules (Small).** Declarative read/write restrictions on file paths (e.g. *"never read .env"*, *"never write outside src/"*). Aligns with `CommandApprovalManager`'s pattern but for the file capabilities. Glob-based config in settings. Small but high security win — existing extension trust model leans entirely on shell approval today.

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
