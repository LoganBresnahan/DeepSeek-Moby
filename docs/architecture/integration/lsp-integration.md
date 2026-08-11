# LSP Integration

Moby exposes VS Code's Language Server Protocol (LSP) machinery to the model as a small set of tools, then keeps a per-language map of which languages will actually answer those tools and feeds that map into the system prompt. The combination lets the model reason about code by symbol — "what defines `validateToken`?" — rather than by line offset, while staying honest when no language server is available.

This document covers the runtime: tools, availability service, timeout safety, and prompt wiring. For the design rationale see [docs/plans/partial/lsp-integration.md](../../plans/partial/lsp-integration.md).

## Why LSP

VS Code already runs language servers for whatever languages the user has installed (TypeScript by default; Pylance, rust-analyzer, gopls, ruby-lsp, ElixirLS, etc. via marketplace extensions). The compiler-level semantic graph — definitions, references, hovers, document symbols — is sitting in-process, accessible via [VS Code's built-in command proxies](https://code.visualstudio.com/api/references/commands#commands).

Without LSP, the model approximates "where is X defined?" with grep + read_file pairs, and "what calls Y?" with grep alone — which catches comments, tests, and similar names while missing dynamic dispatch. With LSP, those become single tool calls that return precise answers.

No index to maintain, no embeddings to compute, no daemon. The LSP is already running.

## Tool surface

Seven tools, all routed through the same dispatcher as workspace tools and gated per-model via `ModelCapabilities.lspTools` ([src/models/registry.ts:133](../../../src/models/registry.ts#L133)).

| Tool | LSP backend | Accepts | Returns |
|---|---|---|---|
| `outline` | `vscode.executeDocumentSymbolProvider` | `path` | Indented tree of symbols (kind + name + 1-indexed line) |
| `get_symbol_source` | document-symbol + slice | `path`, `symbol` | Symbol body sliced from the file (one section per match for overloads) |
| `find_symbol` | `vscode.executeWorkspaceSymbolProvider` | `name`, `maxResults?` | List of `path:line (kind) name [in container]` matches across the workspace |
| `find_definition` | `vscode.executeDefinitionProvider` | `path`, `line\|symbol`, `maxResults?` | List of `path:line: snippet` definition locations |
| `find_references` | `vscode.executeReferenceProvider` | `path`, `line\|symbol`, `maxResults?` | List of `path:line: snippet` reference locations |
| `hover` | `vscode.executeHoverProvider` | `path`, `line\|symbol` | Resolved type signature + docs, flattened from markdown/plain/`{language,value}` content shapes |
| `get_diagnostics` | `vscode.languages.getDiagnostics` (**not** a command proxy) | `path?`, `severity?`, `maxResults?` | `Severity [source] (code) path:line:col` + message, per problem |

Implementation: [src/tools/lspTools.ts](../../../src/tools/lspTools.ts).

Position-bearing tools (`find_definition`, `find_references`, `hover`) accept either `(path, line)` — line is 1-indexed, column auto-resolves to the first non-whitespace character — or `(path, symbol)`, in which case Moby calls the document-symbol provider first to anchor the position. Returns absolute paths consistent with [ADR 0004's B-pattern](../decisions/0004-r1-path-semantics-guards.md).

`get_diagnostics` is the odd one out and deliberately so: it reads VS Code's diagnostic collection directly rather than issuing an LSP request, so it needs no timeout wrapper and works for linters and type checkers that expose no symbol provider at all. Omitting `path` returns every problem VS Code currently knows about; passing one opens that document first to prompt analysis. Its honest limitation is stated in the tool description and the empty-result text — diagnostics for a file VS Code has never analyzed are simply absent, so "no diagnostics" is not proof of "no problems". `severity` filters at `error` / `warning` (default) / `info` / `hint`.

`maxResults` defaults to 20, falls back to 20 when non-numeric or non-positive, and is capped at 100 to prevent runaway prompts. Truncated results emit a hint pointing the model at narrowing the query (or raising the cap).

## Capability gating

`lspTools` is an opt-in flag on `ModelCapabilities`. Defaults:

| Model | `lspTools` |
|---|---|
| `deepseek-v4-flash-thinking`, `deepseek-v4-pro-thinking` | `true` |
| `deepseek-chat` (V3) | `true` |
| `deepseek-reasoner` (R1) | `false` (XML-shell transport only) |
| Custom models | per-entry, default `false` |

Beyond the per-model flag, the orchestrator also checks `LspAvailability.getInstance().hasUsableLsp()` per request. A workspace with no LSP-backed languages installed gets neither the tool definitions nor the prompt declaration — saving ~600 prompt tokens per request the model can't use.

`hasUsableLsp()` is true when any language is confirmed available **or** merely inconclusive, and that inclusion is load-bearing rather than lenient. The prompt tells the model to "try LSP first" for untested languages; gating the tools on confirmed-available alone made that instruction a lie, and worse, closed the only loop that could correct the map — with no tools there are no tool results, so `reportToolResult` never fires. A 2026-08-06 session showed the failure end to end: every language was mis-marked unavailable, the tools silently vanished from the array, and nothing could ever flip them back.

Both gates are evaluated in [requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts):
- Streaming path: line ~3010
- Tool-loop path: line ~3338
- Prompt-builder: line ~1163, fed to `buildToolGuidance` which renders `renderLspDeclaration`.

## Per-language availability service

`LspAvailability` ([src/services/lspAvailability.ts](../../../src/services/lspAvailability.ts)) is a singleton service that maps each languageId observed in the workspace to one of three states: confirmed `available`, confirmed `unavailable`, or `untested`. The model sees the partition through the system prompt; tool calls feed real-world observations back into the map.

### State

```ts
interface AvailabilityState {
  available: boolean | null; // null = inconclusive (a provider answered, no symbols)
  sampledFile: string;       // path of the last file probed/observed
  observedAt: number;        // unix-ms timestamp of last update
  source: 'probe' | 'tool-failure' | 'tool-success' | 'extension-event';
  consecutiveEmpties: number; // delays true→false flip past EMPTY_FLIP_THRESHOLD
}
```

Reads go through `getDeclaredAvailability()` which buckets the map into three sorted arrays (`available`, `unavailable`, `untested`). The orchestrator calls this once per request, synchronous, hot path.

**The three-way verdict (fixed 2026-08-11).** Two probe outcomes look identical to a naive symbol count and mean opposite things: an empty **array** is a provider answering "this file has no symbols" — the LSP working correctly on trivial input — while `undefined` is nothing handling the request at all. Collapsing both into `0 symbols` is what let a single comment-only stub mark a whole language dead for a session. So `available` is now tri-state: symbols anywhere → `true`; no symbols but a provider answered somewhere → `null` (rendered as `untested`); nothing answered anywhere → `false`. The `untested` bucket, previously unreachable from the probe path, is now its normal destination for symbol-less samples, and the prompt tells the model to try LSP first and fall back on empty.

### Probe cadence

Five triggers populate or refresh the map:

| Trigger | What runs |
|---|---|
| Activation + 3s warmup | `discoverWorkspace()` enumerates languages via `findFiles`, probes up to `MAX_PROBE_CANDIDATES` (3) files per language, richest first |
| `vscode.workspace.onDidChangeWorkspaceFolders` | Invalidate map + re-discover |
| `vscode.extensions.onDidChange` | Invalidate map + re-discover (catches LSP install/uninstall) |
| Post-discovery retry (30s) | Per-language single retry for any language not confirmed — catches cold rust-analyzer / gopls / ruby-lsp that miss the initial 5s timeout. Probes a **different** file than the one already sampled; re-probing the same file (the pre-2026-08-11 behaviour) could never change the answer |
| `vscode.window.onDidChangeActiveTextEditor` | If the focused tab's languageId is in the map AND not confirmed available AND no retry pending, schedule a 1s retry probe against that document — the user just opened real code of that language, a better sample than discovery picked |

Plus inline adaptive correction via `reportToolResult(languageId, hadSymbols, sampledFile)` — every LSP tool call feeds its result back. `false → true` flips immediately on success; `true → false` requires `EMPTY_FLIP_THRESHOLD` (2) consecutive empties so a single stub file with no symbols can't poison the whole language.

### Discovery algorithm

```
discoverWorkspace():
  1. findFiles(PROBE_FILE_GLOB, PROBE_EXCLUDE, DISCOVERY_FILE_LIMIT=100)
     → enumerate workspace files matching ~95 source extensions
  2. group files by languageId via openTextDocument(uri).languageId
     → keep up to MAX_PROBE_CANDIDATES (3) per language, sorted by
       lineCount desc (free: the doc is already open). A symbol-bearing
       file is what actually tests whether a provider exists.
  3. probe each language in parallel batches (DISCOVERY_CONCURRENCY=3):
     for each candidate, until one yields symbols:
       - openTextDocument (forces LSP load)
       - FIRST candidate only: wait PROBE_PRE_DELAY_MS (250ms) for
         provider registration
       - executeDocumentSymbolProvider with PROBE_TIMEOUT_MS (5000ms)
     - record AvailabilityState with the three-way verdict above
  4. for each language not confirmed available,
     scheduleRetry(POST_DISCOVERY_RETRY_MS=30000) against an UNTRIED file
```

Sorting by size is a heuristic, not a guarantee — a large generated bundle can be symbol-less while a small module is not, which is why sampling walks multiple candidates rather than trusting the ordering alone.

Only the first candidate pays `PROBE_PRE_DELAY_MS`. That delay buys provider *registration* time, and by the second candidate the provider either registered during the first wait or it never will, so charging it per candidate is pure sleeping — a dev-host run showed an unavailable language spending ~750ms across three candidates, nearly all of it there, because a missing provider returns `undefined` immediately. A server still cold after the first wait is what the 30s retry exists for. A unit test counts the 250ms sleeps (expecting exactly one) rather than timing the probe, so the property can't regress silently and the test can't flake on wall-clock.

Concurrency 3 caps cost — a 9-language polyglot workspace finishes in 3 sequential batches of 3 parallel probes. Higher concurrency would stall the LSP host; lower would slow activation.

### Reactive recovery

The 30s post-discovery retry handles slow-cold language servers (rust-analyzer, gopls, kotlin-lsp routinely take 10–30s to load their workspace index). The editor-focus listener handles the longer-tail case: user fixes their LSP setup mid-session — installs a missing gem, points an `asdf` shim at the right binary, restarts a misbehaving server — without triggering any of `extensions.onDidChange` or `workspaceFolders` events. Focusing a tab in the previously-broken language re-probes within 1s.

Focus listener early-exits cheaply on:
- no editor (focus moved to a non-editor panel)
- untitled doc, non-`file://` URI scheme, plaintext languageId
- language not in the map (workspace didn't have it at discovery time)
- language already marked available
- retry already pending for that language

The "language not in the map" case is the design's only gap — if a workspace gains its first file of a language *after* discovery completes, the focus listener won't re-probe until something else triggers a rediscovery (workspace folder change, extension install, manual `Moby: Refresh LSP Availability` command). Adaptive correction picks it up on the first tool call against that language anyway.

## System prompt declaration

When LSP tools are advertised, the prompt builder appends `renderLspDeclaration` output:

```
LSP works for: typescript, python.
No LSP for: ruby — use grep + read_file for those.
```

`renderLspDeclaration` also has an `Untested: ...` clause, but as noted under [State](#state) the `untested` bucket never populates from discovery, so that line is dormant in practice.

Computed by `getDeclaredAvailability()` and rendered into both `renderMinimalToolGuidance` and `renderStandardToolGuidance` in [requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts). Token cost: ~30–80 tokens depending on language count, replacing earlier ad-hoc "fall back to grep" hints.

The prompt rebuilds every request — there's no event-driven refresh. When the 30s retry flips ruby from unavailable to available, the *next* request automatically sees the updated declaration. Likewise after `extensions.onDidChange` invalidates the map and rediscovery completes.

When NO languages have LSP, both the tool definitions AND the prompt declaration are skipped entirely — the model sees its baseline tool set with no LSP-related boilerplate.

## Timeout safety

VS Code's `executeCommand` does not expose a timeout. A misbehaving language server (deadlocked Pylance, hung gopls indexer, rust-analyzer mid-cold-start) would otherwise leave a tool call awaiting forever — stalling the entire chat request.

Every LSP `executeCommand` is wrapped in `withLspTimeout` ([src/utils/lspTimeout.ts](../../../src/utils/lspTimeout.ts)):

```ts
export class LspTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) { … }
}

export function withLspTimeout<T>(promise: Thenable<T>, timeoutMs: number): Promise<T>;
```

`withLspTimeout` resolves with the LSP's value if it settles in time, throws `LspTimeoutError` if the timer wins, or re-throws the original error on rejection. Callers branch on `instanceof LspTimeoutError` to surface a distinct user-visible message.

Timeouts:

| Caller | Timeout | On timeout |
|---|---|---|
| `LspAvailability.probeLanguage` | 5000ms (`PROBE_TIMEOUT_MS`) | Treat as `unavailable`; the post-discovery retry will catch slow-cold cases |
| `lspTools.fetchDocumentSymbols` and the 3 cross-file `executeCommand` sites | 5000ms (`LSP_TOOL_TIMEOUT_MS`) | Tool result: *"Error: LSP request timed out after 5s. The language server may be cold-starting, indexing, or hung. Try again in a few seconds, or fall back to grep + read_file for this query."* |
| `resolvePosition` (symbol-anchor path) | 5000ms | Tool result: *"LSP request timed out resolving "<name>" in <path>. Try again or pass an explicit line."* |

The probe and tool wrappers both share the same util — diverging behaviour is in the catch block, not in two different timeout primitives.

## Logging

All availability lines prefixed `[LspAvailability]`, viewable in the *DeepSeek Moby* output channel. Levels:

- `INFO` — discovery completion, state transitions (`X now available after retry`, `X marked unavailable after N empty result(s)`, `X upgraded to available via tool-success`).
- `DEBUG` — per-probe results, retry attempts that didn't change state, focus-listener firing.
- `WARN` — `findFiles` failures.

Useful queries:

- *"Which languages does Moby think have LSP right now?"* → look for the `Discovery complete in <ms> — available=[…] unavailable=[…] untested=[…]` line, or the most recent `now available` / `marked unavailable` line per language.
- *"Why is the model still calling LSP tools on Ruby?"* → check that `ruby` actually appears in the `unavailable` list. A `untested` entry means discovery didn't sample it; check that `.rb` is in `PROBE_FILE_GLOB` and the workspace contains at least one `.rb` file findFiles' limit didn't exclude.
- *"Why didn't the post-discovery retry fire?"* → retry only schedules if discovery's probe completed (set `source: 'probe'`) AND came back unavailable. If the language stayed `untested` (probe never ran), no retry is scheduled.

## Refresh command

`Moby: Refresh LSP Availability` invalidates the map and re-runs `discoverWorkspace`. Useful when the user fixes their LSP setup outside VS Code (`gem install`, `asdf install`, editing `~/.profile`) where no `extensions.onDidChange` event fires. Registered in [src/extension.ts](../../../src/extension.ts).

## Non-goals

- **LSP-backed edits** (rename refactor, code actions, quick fixes). Edits stay on the existing `edit_file` / SEARCH-REPLACE path. Mixing LSP edits with the diff/approval machinery is its own design problem.
- **Tree-sitter fallback indexer** when no language server is registered. Tools surface "no LSP results" honestly rather than silently falling back to grep — the model handles fallback via the system prompt declaration.
- **R1 LSP support.** R1 communicates exclusively via `<shell>` tags; bolting LSP into that transport is wrong-direction work given R1's deprecation path.
- **Cross-workspace persistence.** The availability map is in-memory per session.

## Related

- [docs/plans/partial/lsp-integration.md](../../plans/partial/lsp-integration.md) — design plan and rationale.
- [ADR 0004](../decisions/0004-r1-path-semantics-guards.md) — absolute-path B-pattern; LSP tools follow the same convention.
- [VS Code built-in commands reference](https://code.visualstudio.com/api/references/commands) — the proxy commands these tools call.
