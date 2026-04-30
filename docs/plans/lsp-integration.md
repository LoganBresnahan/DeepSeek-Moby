# LSP integration for semantic code navigation

**Status:** Not started — design draft.
**Date:** 2026-04-29

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

### Phase 3 — Telemetry + tuning (parked until usage data justifies it)

Once Phase 1+2 are in real use, instrument a few questions:

- How often does the model pick `read_file` when `get_symbol_source` would have been better? (Likely needs prompt tuning.)
- How often does the model call `find_symbol` with a name that has 50+ matches? (Indicates the truncation cap is too generous or the model needs guidance to narrow.)
- What's the cache-hit rate on document symbol provider calls? VS Code caches these but cross-call repeats are still expensive. If hit rate is low, we add a per-turn cache.

No code changes in Phase 3 by default — gate the work on observed problems.

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
