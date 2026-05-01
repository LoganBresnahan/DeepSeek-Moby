# LSP integration for semantic code navigation

**Status:** Phase 1 + Phase 2 shipped 2026-04-30. Phase 3a (global probe) shipped but being superseded by Phase 4 (per-language availability service). Phase 4 in progress.
**Date:** 2026-04-29 (original) / 2026-04-30 (Phase 3 update) / 2026-05-01 (Phase 4 added)

## Context

Today the model navigates the codebase via byte-oriented tools — [`read_file`](../../src/tools/workspaceTools.ts#L36), [`find_files`](../../src/tools/workspaceTools.ts#L60), [`grep`](../../src/tools/workspaceTools.ts#L80), [`list_directory`](../../src/tools/workspaceTools.ts#L106), [`file_metadata`](../../src/tools/workspaceTools.ts#L126). These are correct but coarse. Three concrete problems show up in real turns:

1. **"Where is X defined?"** turns into a grep + read pair, often across multiple files. The model spends 2–4 tool calls per definition, and produces wrong answers on common names (`User`, `Config`, `handleClick`) where grep returns dozens of hits.
2. **"What references this function?"** isn't really doable today. The model approximates by grepping for the function name, which catches comments, tests, similar names, and misses dynamic dispatch through interfaces.
3. **"Show me the function around this stack-trace line"** requires reading the surrounding ~50 lines and hoping that's enough. For long methods the model either over-reads (wastes tokens) or under-reads (misses the bug).

VS Code already runs language servers for whatever languages the user has installed (TypeScript by default; Python, Rust, Go, etc. via marketplace extensions). The compiler-level semantic graph — definitions, references, hovers, type info, document symbols — is sitting in-process, accessible via [VS Code's built-in command proxies](https://code.visualstudio.com/api/references/commands#commands). Moby ignores it entirely.

This is the cheapest available context win. No index to maintain, no embeddings to compute, no daemon. The LSP is already running and paid for.

## Decision

Add a small, deliberate set of LSP-backed tools that the model can use to navigate code by symbol rather than by line. Route them through the same dispatcher as existing tools. Gate them per-model via the existing capability registry so we don't surface them to models that can't reliably use them.

### Tool set (initial)

Five tools cover the ~90% case. Names favor model-side legibility over LSP-spec fidelity.

| Tool | LSP backend | Accepts | Returns |
|---|---|---|---|
| `find_symbol` | `vscode.executeWorkspaceSymbolProvider` | `name: string` | List of `{name, kind, file, line, container}` matches across the workspace |
| `find_definition` | `vscode.executeDefinitionProvider` | `file: string`, `line: number`, `symbol?: string` | List of `{file, line, snippet}` definition locations |
| `find_references` | `vscode.executeReferenceProvider` | `file: string`, `line: number`, `symbol?: string` | List of `{file, line, snippet}` reference locations |
| `get_symbol_source` | `vscode.executeDocumentSymbolProvider` + slice | `file: string`, `symbol: string` | `{file, kind, range, source}` — the symbol's full body sliced from the file |
| `outline` | `vscode.executeDocumentSymbolProvider` | `file: string` | Tree of `{name, kind, line, children?}` — file's symbol structure |

These five compose: model uses `outline` to see what's in a file, `find_symbol` to locate something by name globally, `get_symbol_source` to read a specific function without reading the whole file, `find_definition`/`find_references` to follow the graph.

### Why these specifically

- **`find_symbol`** is the highest-leverage single tool. Workspace-wide symbol search beats grep on accuracy for any task where the model knows a name but not a location. Backs the "what exists in this codebase" question that Aider's repo-map answers a different way.
- **`get_symbol_source`** is the slicing primitive. `read_file` with line ranges already works, but the model has to *know the line range first*. `get_symbol_source(file, "validateToken")` is one call that returns exactly the function. The model gets the body without reading 800 lines around it.
- **`find_definition`** + **`find_references`** are the call-graph primitives. They handle dynamic dispatch correctly — interfaces, virtual methods, callback registrations — that grep can't see.
- **`outline`** is cheap orientation. When the model wants to know "what's in this file" without reading it, the symbol tree is ~50× smaller than the file body.

### How tools accept positions

LSP commands take `(uri, Position)` where `Position` is `(line, character)`. The model has file paths and line numbers but rarely a column. Two accepted input shapes for tools that need a position:

1. **`(file, line)`** — most common. Resolve to a position by finding the first non-whitespace character on that line. Good enough for almost all real cases.
2. **`(file, symbol)`** — when the model knows the symbol name but not its line. Resolve via `executeDocumentSymbolProvider` first, then call the position-based provider.

Both shapes accepted on `find_definition` / `find_references`. Pick whichever matches what the model already has — usually it has a line from a grep result.

### What the model sees

Tool results return absolute paths (consistent with [ADR 0004's B-pattern](../architecture/decisions/0004-r1-path-semantics-guards.md)) plus a snippet for context. Example:

```
find_definition(file="src/auth.ts", line=47):
  /home/user/proj/src/auth/middleware.ts:128
    export function validateToken(token: string): boolean {
```

```
find_references(file="src/auth/middleware.ts", line=128):
  /home/user/proj/src/api/routes.ts:14: app.use(validateToken);
  /home/user/proj/src/api/routes.ts:33: validateToken(req.headers.authorization);
  /home/user/proj/tests/auth.test.ts:8: expect(validateToken('bad')).toBe(false);
  ... (3 more)
```

Capped at N results per call (default 20) with a "truncated, narrow your query" hint when over.

## Capability axis

LSP tools are bundled behind a new optional `lspTools` flag on `ModelCapabilities` ([src/models/registry.ts](../../src/models/registry.ts)):

```ts
interface ModelCapabilities {
  // ... existing fields ...

  /** Whether the LSP-backed navigation tools (`find_symbol`,
   *  `find_definition`, `find_references`, `get_symbol_source`,
   *  `outline`) are exposed to this model. Defaults to false.
   *
   *  Native-tool models with `toolCalling: 'native'` can use them.
   *  R1 (`xml-shell` transport) currently cannot — its tool surface
   *  is shell-only. Custom models opt in per registry entry. */
  lspTools?: boolean;
}
```

**Default rollouts:**

| Model | `lspTools` | Reasoning |
|---|---|---|
| `deepseek-v4-flash`, `-pro` | `true` | Native-tool, ample context. |
| `deepseek-v4-flash-thinking`, `-pro-thinking` | `true` | Same; thinking variants benefit most from semantic nav. |
| `deepseek-chat` (V3) | `true` | Native-tool. Worth shipping before V3 retires. |
| `deepseek-reasoner` (R1) | `false` | Shell-only transport. Could be wired through `<lsp>` tags later if R1 demand justifies it; out of scope here. |
| Custom models | per-entry, default `false` | User opts in when their model can use them. |

R1 is the explicit exclusion. R1 communicates with the workspace exclusively through `<shell>` tags; bolting LSP into that transport would require an XML schema for LSP results, which is a bigger investment than R1's expected remaining lifetime warrants.

## Phases

### Phase 1 — Single-file tools (`outline`, `get_symbol_source`) ✅ Lowest risk

**Goal:** prove the dispatch path with two tools that don't cross file boundaries.

**Work:**
- Add `lspTools?: boolean` to `ModelCapabilities`. Default false; flip on for V4 entries + V3 chat.
- New file `src/tools/lspTools.ts` exporting `outlineTool`, `getSymbolSourceTool` schemas and an `executeLspTool(toolCall)` dispatcher.
- Implementations call `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` and slice the resulting ranges from the file's text via `vscode.workspace.openTextDocument(uri).getText(range)`.
- Wire conditionally into the orchestrator's tool-array assembly: include LSP tools when `caps.lspTools === true`.
- Wire dispatch in `executeToolCall` ([workspaceTools.ts:337](../../src/tools/workspaceTools.ts#L337)) — delegate `outline` / `get_symbol_source` to the new module.
- Tests: 6–8 unit tests against a small fixture project, mocking `vscode.commands.executeCommand` to return a known DocumentSymbol tree.
- System prompt: one new line under read tools — *"Use `outline` to see file structure and `get_symbol_source` to read a specific function without reading the whole file."*

**Acceptance:** model can call `outline("src/foo.ts")` and `get_symbol_source("src/foo.ts", "handleClick")` end-to-end, results render in tool dropdown, no regressions in the existing tool path.

### Phase 2 — Cross-file tools (`find_definition`, `find_references`, `find_symbol`)

**Goal:** the call-graph primitives.

**Work:**
- Three new tool schemas + dispatch entries in `lspTools.ts`.
- Call into `vscode.executeDefinitionProvider`, `vscode.executeReferenceProvider`, `vscode.executeWorkspaceSymbolProvider` respectively.
- Result formatter: snippet extraction (1–2 lines around each match), absolute-path normalization, max-results truncation with hint.
- Position resolution helper: given `(file, line)`, find the first non-whitespace column. Given `(file, symbol)`, run document symbol provider, locate the symbol by name (handling overloads / multiple matches with a clarifying hint).
- Tests: 10–12 unit tests covering position resolution, multi-result truncation, no-results handling.
- Manual-test backlog entries (4–6) covering the real LSP integrations VS Code users have running (TypeScript, Python via Pylance, Rust via rust-analyzer).

**Acceptance:** "where is X defined" / "what calls Y" become single-tool-call answers across the languages a typical user has installed.

### Phase 3 — Workspace probe + telemetry + tuning

**Status:** workspace probe shipped 2026-04-30. Telemetry/tuning items remain parked until real-world usage data justifies them.

#### 3a — Workspace LSP availability probe ✅ Shipped

**Motivation.** Without a probe, LSP tools are advertised even on workspaces with no language server installed (e.g. a vanilla JS-only workspace running through TS-server, a markdown-only repo, a non-code workspace). The 5 LSP tool schemas add ~600 prompt tokens per request — wasted when the workspace can't deliver. Worse, the model wastes a tool call learning the LSP isn't available.

**Implementation:** [src/services/lspProbe.ts](../../../src/services/lspProbe.ts) — singleton `LspProbe` class with cache + invalidation.

- **Algorithm.** Single coarse global yes/no per workspace.
  1. Build a candidate list of up to 3 source files. Prefer already-open documents whose `languageId` is in `SOURCE_LANGUAGE_IDS` (allowlist of ~50 known code languages — strict to avoid picking `.log`, `.md`, `.json` files that have no symbol provider). Fill with `vscode.workspace.findFiles(PROBE_FILE_GLOB, PROBE_EXCLUDE, MAX_PROBES * 2)`.
  2. Probe each candidate via `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` with a 1500ms timeout (per-candidate).
  3. Bail on the first candidate returning a non-empty array → cache `true`.
  4. All candidates empty → cache `false`. All errors → cache `true` (optimistic; tool-level failures handle per-language fallback gracefully).
- **Glob coverage.** `PROBE_FILE_GLOB` covers ~60 source extensions across mainstream + long-tail languages: TS family (mts/cts/mjs/cjs), Python (+pyi), Rust, Go, Zig, Nim, Crystal, D, JVM (+kts/scala/sc/groovy/gradle), .NET (+fs/fsx/fsi/vb), C/C++ (+cc/cxx/hh/hxx), Objective-C, Swift, Dart, Vue/Svelte/Astro, Ruby (+erb), PHP/Perl, Erlang/Elixir, Haskell/OCaml/Clojure/Racket/Scheme/Lisp, Lua/R/Julia/MATLAB/Tcl/Elm/Haxe, Fortran/Ada, Solidity/Cairo, Shell/PowerShell, Proto/Thrift/GraphQL/Prisma, SQL/TOML/YAML.
- **Exclude.** `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `.next`, `.nuxt`, `.cache`, `.tox`, `.venv`, `venv`, `__pycache__`, `.idea`, `.vscode`.
- **Cache invalidation.** `vscode.workspace.onDidChangeWorkspaceFolders` + `vscode.extensions.onDidChange` (catches LSP install/uninstall mid-session). Manual `invalidate()` available.
- **Activation timing.** Probe kicks off via `warmUp()` immediately after `tokenService.initialize()` so the first request usually has a cached answer. Orchestrator reads cache via `getCached()`; `null` → optimistic include (avoid blocking first turn waiting for probe).
- **Gating.** Both orchestrator paths (`streamAndIterateWithToolCalls`, `runToolLoop`) gate `includeLspTools` on `caps.lspTools === true && LspProbe.getInstance().getCached() !== false`. Same gate applied in `buildToolGuidance` so the prompt doesn't advertise tools we won't include.

**Bug history.** Initial open-docs filter (`languageId !== 'plaintext'`) was too loose — it picked any non-plaintext file the user had open. Real-world session restored with a `.log` file open → probe selected it → 0 symbols → cached `false` for an entire workspace that had hundreds of TS files with a working LSP. Fix: replaced negative filter with `SOURCE_LANGUAGE_IDS` allowlist + multi-candidate probe so a non-code open doc no longer poisons the result.

**Limitations and tightening backlog.**
- **Coarse global yes/no.** A workspace mixing TS (LSP available) + Python (no Pylance) reports `true` because the TS file responds. Python-specific tool calls then return empty per-call (each tool surfaces its own "no LSP for this language" hint). Per-language refinement is possible but adds a `Map<languageId, boolean>` cache and probe-per-language complexity. Defer until mixed-LSP confusion shows up in real usage.
- **`MAX_PROBES = 3` is a guess.** If real workspaces show probes still landing on duds (e.g. all 3 hits are stub files or generated code with no symbols, while the rest of the workspace has LSP), bump to 5 or 10. Trade-off: each probe spawns an LSP call up to 1500ms, so 10 candidates worst-case is ~15s — too slow for the activation hot path. **Tightening rule of thumb:** raise the cap if probe says `false` but a manual `find_symbol` later succeeds in the same workspace; lower it if the cap delays activation noticeably.
- **Open-docs allowlist may need additions.** New languageId values (Mojo, Roc, Gleam, etc. as those mature) will get filtered out until we expand the set. Keeping in sync with `PROBE_FILE_GLOB` is a manual step.

#### 3b — Telemetry + tuning (parked)

Once Phase 1+2+3a are in real use, instrument these questions before adding more code:

- **How often does the model pick `read_file` when `get_symbol_source` would have been better?** Look for turns where the model reads a file >300 lines and the question was "what does function X do" — it could have used `get_symbol_source` instead. Likely needs prompt tuning, not code changes.
- **How often does `find_symbol` overflow the 20-result default cap?** If common, raise the default. If rare, leave alone.
- **What's the cache-hit rate on document symbol provider calls?** VS Code caches these but cross-call repeats are still expensive. If real workspaces hit symbol provider many times per turn for the same file, add a per-turn LRU cache (~10 entries).
- **Probe accuracy.** False negatives (probe says no LSP when it exists) and false positives (probe says yes but tools fail). Track via comparing probe result to actual tool-call success rates.

No code changes in Phase 3b by default — gate on observed problems. The LSP-tool error messages already self-describe missing servers per language, so the Phase 1+2 floor is acceptable without these refinements.

#### 3c — Per-language probe refinement (superseded by Phase 4)

Original plan deferred per-language refinement until telemetry showed mixed-LSP confusion. Real-world usage surfaced the problem on day one: a Rails workspace's JS files responded to TS-server (built into VS Code) → global probe cached `true` → model called LSP tools on `.rb` files → empty results → wasted tool calls + model confusion. The "JS-always-true" pattern means the global probe is essentially "is this a code workspace?" which isn't useful gating. Phase 4 replaces it.

### Phase 4 — Per-language availability service

**Status:** In progress 2026-05-01.

**Motivation.** The Phase 3a global probe lies in mixed-language workspaces. JS/TS workspaces always have LSP via the built-in TypeScript server, so any workspace containing JS reports `true` regardless of whether other languages have servers installed. Rails apps (JS configs + Ruby code), Django apps (build scripts + Python without Pylance), polyglot monorepos all hit this. Symptoms: model calls `find_symbol` on a Ruby file → empty result → wasted call → grep fallback the model could have done from the start.

The right granularity is per-language. The model needs to know which languages will respond to LSP queries before making tool calls.

**Decision.** Replace the global `LspProbe` with `LspAvailability`, a per-language availability service. System prompt declares which languages have LSP, which don't. Tool failures adaptively correct the map.

#### Architecture

```ts
interface AvailabilityState {
  available: boolean;
  sampledFile: string;       // which file was probed (for debugging)
  probedAt: number;          // unix ms
  source: 'probe' | 'tool-failure' | 'tool-success' | 'extension-event';
}

class LspAvailability {
  private map = new Map<string, AvailabilityState>();
  private discoveryInFlight: Promise<void> | null = null;

  // Singleton accessor (mirrors LspProbe).
  static getInstance(): LspAvailability;

  // Background scan: enumerates languages in workspace, probes one file per
  // language, populates map. Idempotent — concurrent calls share the in-flight
  // promise. Called at activation (after WARMUP_DELAY_MS) and on reactive
  // invalidations.
  async discoverWorkspace(): Promise<void>;

  // Synchronous read for orchestrator hot path.
  getDeclaredAvailability(): {
    available: string[];   // languageIds with LSP confirmed working
    unavailable: string[]; // languageIds confirmed without LSP
    untested: string[];    // languageIds present in workspace but not yet probed
  };

  // Per-tool-call adaptive correction. LSP tools call this when their result
  // is empty for a given languageId. Updates the map; future requests will
  // see the corrected declaration.
  reportToolResult(languageId: string, hadSymbols: boolean): void;

  // Wires the reactive invalidators. Returns disposables for context.subscriptions.
  registerInvalidators(): vscode.Disposable[];

  // For debugging / tests.
  getRawMap(): ReadonlyMap<string, AvailabilityState>;
  invalidate(): void;  // drops cache; next discoverWorkspace re-probes everything
}
```

#### Cadence

| Trigger | What runs | Notes |
|---|---|---|
| Activation + 3s warmup | `discoverWorkspace()` in background | Existing `WARMUP_DELAY_MS` reused |
| `vscode.extensions.onDidChange` | `invalidate()` + `discoverWorkspace()` | Catches LSP install/uninstall via marketplace |
| `vscode.workspace.onDidChangeWorkspaceFolders` | `invalidate()` + `discoverWorkspace()` | Workspace folder add/remove |
| LSP tool returns empty for language X | `reportToolResult(X, false)` | Inline, ~µs — adaptive correction |
| LSP tool returns symbols for X marked unavailable | `reportToolResult(X, true)` | Inline upgrade |
| Idle workspace | Nothing | No periodic timer — reactive triggers cover real cases |
| (Optional, later) Manual command `Moby: Refresh LSP Availability` | `invalidate()` + `discoverWorkspace()` | For users who install LSP outside VS Code (`gem install solargraph`) |

**Why no periodic timer:** the reactive triggers + adaptive correction cover all auto-discoverable cases. Periodic timer wastes idle workspace cycles re-probing stable answers. The one gap (LSP installed via shell mid-session) is solved by either the manual command or restarting Moby; neither warrants a timer firing every minute on every user's workspace.

#### Discovery algorithm

```
discoverWorkspace():
  1. Enumerate workspace languages via findFiles(PROBE_FILE_GLOB, PROBE_EXCLUDE, ~50)
     → Map<languageId, sampleUri> (one representative file per languageId)
     → languageId resolved via vscode.workspace.openTextDocument(uri).languageId
        (falls back to extension→languageId table for cheap path)
  2. For each languageId in parallel (with concurrency cap of 3):
     - openTextDocument(sampleUri) → forces LSP load
     - wait PROBE_PRE_DELAY_MS for provider registration
     - executeDocumentSymbolProvider(uri) with PROBE_TIMEOUT_MS timeout
     - record AvailabilityState { available: symbols.length > 0, ... }
  3. Log: `[LspAvailability] {available: [ts, js], unavailable: [ruby, python]}`
```

Per-language probe latency: ~250-500ms warm, up to PROBE_TIMEOUT_MS cold. Concurrency cap of 3 means a 6-language workspace finishes in ~2 batches.

#### System-prompt declaration

When LSP tools are advertised (i.e. at least one available language), append:

> *"LSP tools (find_symbol, find_definition, find_references, get_symbol_source, outline) are available for: TypeScript, JavaScript, Python.
> Not available for: Ruby — fall back to grep + read_file for Ruby code.
> Not yet tested: Go (try LSP first; fall back if it returns no results)."*

Computed by `getDeclaredAvailability()` and rendered into both `renderMinimalToolGuidance` and `renderStandardToolGuidance`. Token cost: ~30-80 tokens depending on language count, replacing the current ad-hoc "fall back to grep" hint.

When NO languages have LSP: skip the tool definitions AND the prompt declaration entirely (current behavior preserved).

#### Tool-side adaptive correction

Both `outline`/`get_symbol_source` (Phase 1) and `find_symbol`/`find_definition`/`find_references` (Phase 2) update on call:

```ts
const symbols = await fetchDocumentSymbols(uri);
const languageId = doc.languageId;
LspAvailability.getInstance().reportToolResult(languageId, Array.isArray(symbols) && symbols.length > 0);
```

Edge case: empty file or stub file genuinely has no symbols even with LSP. Don't downgrade on a single empty result — require N (≥2) consecutive empties before flipping `true → false`. Keep `false → true` flip immediate (one success proves LSP works).

#### Migration from `LspProbe`

- Delete [src/services/lspProbe.ts](../../../src/services/lspProbe.ts).
- Replace orchestrator's `LspProbe.getInstance().getCached()` checks with `LspAvailability.getInstance().getDeclaredAvailability().available.length > 0`.
- Replace prompt-builder's boolean `lspToolsAvailable` with the structured availability object so the renderer can list languages.
- Update [src/extension.ts](../../../src/extension.ts) activation: swap `LspProbe.warmUp()` for `LspAvailability.discoverWorkspace()`.

#### Non-goals for Phase 4

- **Per-file overrides.** Probing different files of the same language to handle "this file's stub" vs "this file's real" cases. Future phase if observed.
- **LSP feature-level granularity.** Some LSPs implement `documentSymbolProvider` but not `referenceProvider`. Today we treat language as binary. Future phase if a tool starts failing where another succeeds for the same language.
- **Cross-workspace persistence.** Map is in-memory per session. Caching to disk would speed up cold start but add invalidation complexity. Defer.

#### Risks

- **First-request latency.** Discovery runs in background after warmup; orchestrator falls back to optimistic include if discovery hasn't completed. So first turn isn't blocked but its prompt may be missing the language declaration. Acceptable — second turn onwards has it.
- **Stale "untested" entries.** Languages found via findFiles but never opened won't get probed proactively if they're rare. Tool calls against those go through the optimistic path. Adaptive correction picks up the truth on first usage.
- **Concurrency cap tuning.** 3 concurrent probes balances speed vs LSP-server load. May need adjustment for huge polyglot monorepos.
- **Extension changes that don't affect LSP.** `onDidChange` fires on any extension install/uninstall, not just LSP-providing ones. Cost of overrun: re-discovery once per extension change, ~1-3s background. Acceptable.

#### Phase 4 work order

1. Build `LspAvailability` skeleton — class, map, invalidators, log lines.
2. Implement `discoverWorkspace` — enumerate languages, parallel probe with concurrency cap.
3. Implement `getDeclaredAvailability` + `reportToolResult` (with consecutive-empty threshold).
4. Wire activation hook (replaces `LspProbe.warmUp()`).
5. Wire orchestrator gating (tool array + prompt builder).
6. Wire prompt declaration rendering in both `renderMinimalToolGuidance` + `renderStandardToolGuidance`.
7. Wire tool-side `reportToolResult` callbacks in `lspTools.ts`.
8. Delete `lspProbe.ts` + remove obsolete tests.
9. Add `LspAvailability` tests — unit tests for map management, discovery, adaptive correction.
10. Manual-test backlog entry: rails workspace (JS+Ruby), polyglot monorepo, vanilla TS workspace, no-source workspace.

## What we are NOT doing in this plan

- **Edit-via-LSP** (rename refactor, code actions, quick fixes). Edits stay on the existing `edit_file` / `write_file` / SEARCH-REPLACE path. Mixing LSP edits with our own approval/diff machinery is its own design problem.
- **Implementing fallback indexers** when no language server is registered. If the user opens a workspace where TypeScript isn't installed, `find_symbol` returns nothing useful. We surface that honestly ("no LSP results — the language server may not be installed") rather than silently falling back to grep. Building a tree-sitter-based fallback is a separate, larger plan.
- **Wiring LSP into R1's `<shell>` transport.** R1 is on the deprecation path per [ADR 0004 follow-ups](../../docs/plans/completed/model-capability-registry.md#f5--adr-on-r1-status). Investing in R1-specific LSP is wrong-direction work.
- **Project-wide AST analysis** (call graph, dead code detection, dependency tree). These are nice but solve a different problem than "give the model what it needs for this turn." Aider's repo-map is the relevant precedent; if we want that, it's its own plan.
- **A `read_function` / `read_class` parallel API.** `get_symbol_source` covers both — the underlying DocumentSymbol kinds carry the distinction, and the model doesn't need separate tools.

## Risks and mitigation

- **Language server not present.** Pylance, rust-analyzer, etc. are user-installed. `executeWorkspaceSymbolProvider` returns `[]` rather than throwing. Mitigation: when a tool returns empty, format the result with the hint *"no LSP results — verify a language server is installed for this language; falling back to grep may help"*. The model can self-correct.
- **Position resolution ambiguity.** A symbol with overloads (TypeScript) returns multiple definitions. Mitigation: return all of them (with a max), let the model decide. Don't try to be smart about picking one.
- **Cold start on first call.** Some language servers (rust-analyzer, gopls) take 10–60s to fully index a workspace on first open. A `find_symbol` call during indexing returns partial results. Mitigation: surface via tool-result note when results look suspiciously sparse on a populated workspace; don't block.
- **LSP timeouts.** A misbehaving LSP can hang. VS Code's `executeCommand` doesn't expose a timeout; we wrap with a `Promise.race` against a 5-second timeout. Returning a "request timed out" tool result is better than blocking the chat.
- **VS Code remote / WSL.** LSP runs in the remote/WSL host. VS Code's command proxy handles this transparently — no code change needed, but confirm in manual test.
- **Symbol provider returning stale results during edits.** VS Code re-indexes on save / change debounced; mid-edit results can be stale. Mitigation: not solving in Phase 1 — accept staleness, document it. If real users hit this, add a `vscode.workspace.applyEdit` flush before high-confidence calls.
- **Tool-array overhead.** Five new tool definitions add ~600 tokens to every request that includes the workspace tool array. Acceptable cost — comparable to `runShellTool`'s ~200 token cost which already shipped. Worth measuring after Phase 2 lands; if it's a real problem, the registry can split tools into a "navigation-only" subset that's cheaper to advertise than the full set.

## Why this approach over alternatives

**A. Build a tree-sitter symbol indexer ourselves (Aider-style repo-map).** Higher ceiling — works without language servers, predictable cross-language. But 5–10× more code than calling LSP, plus an index to maintain, plus staleness, plus a tokenizer-aware budget. Worth it if Moby were a standalone CLI; weak ROI as a VS Code extension where the LSP is already running.

**B. Bolt on a third-party MCP server (e.g., token-savior).** Imports a heavy dependency for one capability. Loses control over tool surface, error handling, prompt integration. Right answer if Moby were CLI-agnostic; wrong answer for a VS Code-native extension.

**C. Stay with grep + read_file + lots of prompt engineering.** What we have today. Works, but the model still spends multiple tool calls on questions LSP answers in one. The prompt engineering ceiling is low compared to giving the model better primitives.

**D. Use LSP only behind the scenes (transparently slice `read_file` results).** Tempting — turns LSP into an internal optimization without expanding the tool surface. But the model loses the *ability to ask* the question that LSP uniquely answers ("references" is the obvious case). Hidden integration helps in narrow cases but caps the ceiling.

The chosen approach (**explicit LSP tools, gated by capability flag**) buys most of A's value at 1/10th the cost, doesn't lose flexibility like D, and keeps the integration honest like C.

## Open questions

- **Should `get_symbol_source` accept a `(file, line)` shape too, not just `(file, symbol)`?** Useful when the model has a stack-trace line but not a symbol name. Probably yes — resolve via document symbols by finding the symbol whose range contains the line. Ties into Phase 2's position-resolution helper.
- **Cross-language cases — header files, generated code.** Generated TS from `.proto` schemas, Python stubs from C extensions. LSP usually handles these, but the snippets may look weird. Worth manual-testing on a polyglot project.
- **Do we expose `find_implementations` / `find_type_definition`?** They're the same shape as `find_definition` and provide value in OO codebases. Easy to add in Phase 2 if usage justifies. Defer until we see whether the existing five cover real turns.
- **Caching policy.** Within a turn, the same file's outline is often requested 2–3 times. Adding a per-turn LRU cache (~10 entries) is cheap. Defer to Phase 3 unless it shows up as latency.
- **Telemetry shape.** What do we record about tool usage? Today's logging is unstructured; if we want Phase 3's tuning data, we may need to extend `[ApiCall]` line format or add a separate tool-usage log. Cross-cuts with broader telemetry decisions, not LSP-specific.

## Related

- [model-capability-registry.md](completed/model-capability-registry.md) — the registry pattern this builds on; new `lspTools` axis follows the established convention.
- [ADR 0004](../architecture/decisions/0004-r1-path-semantics-guards.md) — absolute-path B-pattern in tool results; LSP tools follow the same convention.
- [VS Code built-in commands reference](https://code.visualstudio.com/api/references/commands) — the LSP command proxies we'll call.
- [subagents.md](subagents.md) — separate plan for cheaper-model digests; LSP slicing complements (not replaces) that work since they protect different parts of the token budget.
