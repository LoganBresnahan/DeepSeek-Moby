# MCP Client Integration — Design

**Status: design accepted 2026-08-05 — not yet decomposed (run the design-plan workflow before implementing).**
Scope decisions were made 2026-08-04 (recorded in the tracker); this doc grounds them in the code as it stands at `e256fba`.

## Goal

Moby becomes an MCP **client**: user-configured stdio servers contribute tools that merge into the model's tools array and dispatch like native tools. The landing surface for prompts (`/`) and resources (`@`) — composer autocomplete, ADR 0015 — already exists, but those ride a **later phase**; v1 is tools.

## Scope (decided 2026-08-04)

| Axis | v1 decision | Rationale |
| --- | --- | --- |
| Transport | **stdio only** | Covers every local server; HTTP/SSE adds auth + lifecycle complexity for no current user |
| Trust | **user-scope config = trusted, no per-call approval** | The user typed the command into their own settings; same trust as installing an extension |
| Capabilities consumed | tools + `instructions` + `listChanged` refresh | The useful minimum |
| Capabilities declared | `roots` (workspace folders) + `roots/listChanged` | Cheap, and servers like filesystem/LSP bridges want it |
| Prompts + resources | **later phase** | Prompts → `/` provider, resources → `@` provider + the `droppedFileContents` ingestion seam — both ≈ free once the client core exists |
| SDK | `@modelcontextprotocol/sdk` | Hand-rolling JSON-RPC framing + lifecycle is pure liability |
| Sampling / elicitation | **not supported** — decline the capability | Server-initiated model calls invert Moby's trust model |

**Security boundary that follows from "user-scope = trusted":** the config is read from the **global (user) scope only** — `inspect().globalValue`, never the merged view. Otherwise a cloned repo's `.vscode/settings.json` could silently register a server whose `command` is arbitrary code execution on open. This is load-bearing, not a nicety.

## Ground truth the design builds on (verified 2026-08-05)

- **The tools array is built twice, byte-identically**: [requestOrchestrator.ts:3525-3540](../../src/providers/requestOrchestrator.ts#L3525) (streaming loop) and [:3935-3955](../../src/providers/requestOrchestrator.ts#L3935) (`runToolLoop`). Same gating (`shellProtocol`, `lspTools` × `LspAvailability`, web-search auto), same composition, no shared helper. **Prerequisite refactor: extract one `buildToolsArray()`** so MCP tools inject in exactly one place.
- **Dispatch is layered "return null if not mine"**: [`dispatchToolCall`](../../src/providers/requestOrchestrator.ts#L3033) special-cases `web_search`, else calls [`executeToolCall`](../../src/tools/workspaceTools.ts#L338), which tries `executeLspTool` first (null = not mine) then switches. MCP hooks in at the **orchestrator** layer via name prefix — `dispatchToolCall` already holds the abort `signal` there, which `executeToolCall` does not accept.
- **Error convention is literally `result.startsWith('Error:')`** — checked at [:3060](../../src/providers/requestOrchestrator.ts#L3060), [:3760](../../src/providers/requestOrchestrator.ts#L3760), [:4106](../../src/providers/requestOrchestrator.ts#L4106) to drive UI status and logging. **Conform, don't fix**: an MCP `isError: true` result becomes `Error: <text>`.
- **No generic tool timeout/abort exists.** LSP tools carry their own 5s wrapper ([lspTools.ts:22](../../src/tools/lspTools.ts#L22)); shell has 10s; everything else runs unbounded and ignores the signal. MCP calls get both from day one (below) — but we do not retrofit the native tools in this effort.
- **Tools-JSON is invisible to the token-budget guard.** [contextBuilder.ts](../../src/context/contextBuilder.ts) never sees `tools`; the in-loop soft stops ([:3511](../../src/providers/requestOrchestrator.ts#L3511), [:3924](../../src/providers/requestOrchestrator.ts#L3924)) count messages only. Tolerable at ~11 native tools; not at +50 from servers. Closed in Phase 4 via `buildToolsArray()` (single place to count).
- **`Tool.function.parameters` is a direct match for MCP `inputSchema`** — both are `{type:'object', properties, required?}` ([deepseekClient.ts:46-69](../../src/deepseekClient.ts#L46)). Pass-through, no translation layer.
- **The wire already gates non-native models**: [deepseekClient.ts:438](../../src/deepseekClient.ts#L438) drops `tools` unless `caps.toolCalling === 'native'`. MCP inherits that for free; R1 and `toolCalling: 'none'` customs never see MCP tools.
- **Lifecycle idioms to copy**: `LspAvailability` for the cached-registry/no-I/O-at-build pattern ([lspAvailability.ts](../../src/services/lspAvailability.ts) — `getInstance()` + `registerInvalidators()` + `warmUp()` at [extension.ts:105](../../src/extension.ts#L105)); `drawingServer` for child-process disposal (`context.subscriptions.push({ dispose })` at [extension.ts:149](../../src/extension.ts#L149)). Note `deactivate()` does **not** dispose `chatProvider` — the manager must ride `context.subscriptions`, not chatProvider teardown.

## Design

### Configuration — `moby.mcpServers`

Object map in `package.json` following the `customModels` contribution pattern (JSON schema, `additionalProperties: false` per entry, descriptive runtime validation that warns and skips rather than throws):

```jsonc
"moby.mcpServers": {
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "required": ["command"],
    "properties": {
      "command": { "type": "string" },
      "args":    { "type": "array", "items": { "type": "string" } },
      "env":     { "type": "object", "additionalProperties": { "type": "string" } },
      "cwd":     { "type": "string" },
      "enabled": { "type": "boolean", "default": true }
    },
    "additionalProperties": false
  }
}
```

- **Server names** (the map keys) must match `^[a-zA-Z0-9-]{1,32}$` — they embed in tool names (below). Invalid names: warn + skip, mirroring `registerCustomModels`' collect-errors style.
- **Global scope only** (see security boundary above). A workspace-scope value present but ignored gets one warning log naming the setting, so the user isn't silently confused.
- No variable expansion in v1 (`${env:…}`, `${workspaceFolder}` etc.) — literal strings. Revisit trigger: the first server that genuinely needs it.
- `onDidChangeConfiguration` for `moby.mcpServers` joins the existing listener at [extension.ts:47](../../src/extension.ts#L47) → diff against running servers → stop removed, start added, restart changed.

### `McpServerManager` — `src/mcp/McpServerManager.ts`

Mirrors `LspAvailability`: all request-path reads are **synchronous against an in-memory cache**; all I/O happens at activation, config change, or notification time.

Per server, the manager holds `{ status: 'starting' | 'ready' | 'failed' | 'stopped', client, tools: Tool[] (already namespaced + validated), instructions?: string, serverInfo }`.

- **Spawn**: on activate, after a short `warmUp()`-style delay (LSP uses 3s) so servers don't compete with extension startup. SDK `StdioClientTransport` + `Client`; `initialize` handshake captures `instructions` and server capabilities.
- **Client capabilities declared**: `roots: { listChanged: true }`. `roots/list` serves the workspace folders; `onDidChangeWorkspaceFolders` fires the notification. Decline sampling/elicitation.
- **Tool cache**: `tools/list` at handshake → translate each to Moby `Tool` with name `mcp__<server>__<tool>`. On `notifications/tools/list_changed` → re-list, replace that server's slice. Next request naturally picks it up (arrays build per iteration already).
- **Public API** (the whole surface the orchestrator sees):
  - `getToolsForRequest(): Tool[]` — sync, concat of ready servers' cached slices
  - `executeTool(namespacedName, argsJson, signal): Promise<string>` — the dispatch target
  - `getInstructionsBlock(): string` — sync, for the system prompt
  - `getStatus()` — for the status command
- **Crash handling**: transport close/error → `failed`, tools slice drops out of the array immediately. Bounded restart: 2 retries with backoff, then stay `failed` until config change or manual refresh (`moby.refreshMcpServers`, mirroring `moby.refreshLspAvailability` at [extension.ts:236](../../src/extension.ts#L236)). Never restart-loop a server that dies on spawn.
- **Disposal**: `context.subscriptions.push({ dispose })` → close every transport (SDK sends the child SIGTERM). Not tied to chatProvider (see ground truth).

### Tool naming — `mcp__<server>__<tool>`

- The prefix is the dispatch discriminator: `dispatchToolCall` checks `name.startsWith('mcp__')` **before** falling through to `executeToolCall`, keeping native dispatch untouched.
- OpenAI-compat function names cap at 64 chars, pattern `^[a-zA-Z0-9_-]+$`. Validate at cache time: over-long or non-conforming names are **skipped with a warning naming the tool** — never silently truncated (truncation risks collisions, and a collision mis-routes a call).
- Collision with a native tool name is impossible by construction (no native tool starts with `mcp__`).

### Dispatch, results, errors, timeout

In `dispatchToolCall`, before the `executeToolCall` fallthrough:

```
if name starts with 'mcp__' → mcpServerManager.executeTool(name, args, signal)
```

- **Results**: MCP returns content blocks. v1: concatenate `text` blocks with `\n\n`. Non-text blocks (image/audio/resource) become a **named placeholder** — `[MCP tool returned an image — not supported yet]` — never silence (same rule the image-describe plan established). Future: image blocks could ride digest routing; that's a note, not a promise.
- **Errors**: `isError: true` → `Error: <concatenated text>`. Transport/protocol failures → `Error: MCP server "<name>" — <reason>`. Both conform to the string-prefix convention.
- **Timeout + abort**: pass the SDK's per-request timeout (30s default — MCP tools are typically LSP-or-network-shaped, not shell-shaped) and wire `signal` into the SDK call so Stop actually cancels in-flight MCP work. This makes MCP tools the *best*-behaved tools in the codebase; the native gap is tracked separately, not fixed here.

### System prompt — server instructions

New delimited block in [`buildSystemPrompt`](../../src/providers/requestOrchestrator.ts#L1605), after tool guidance (section 2), matching the existing `--- X ---` convention:

```
--- MCP SERVERS ---
Connected: pharos (34 tools). Tools are named mcp__<server>__<tool>.

pharos: Language-aware code navigation via LSP. […server's instructions verbatim…]
--- END MCP SERVERS ---
```

- Emitted only when ≥1 server is `ready` — zero servers means zero prompt bytes, same as `renderLspDeclaration` returning `''`.
- Instructions are the server author's text, injected verbatim. Under the trust decision that's acceptable; per-server character cap (~2,000) so a verbose server can't flood the prompt.
- Gated on `toolCalling === 'native'` like the tools themselves — a model that can't call the tools shouldn't read about them.

### Token budget visibility

Once `buildToolsArray()` exists, both in-loop soft stops gain the missing term:

```
baseTokens = estimateTokens(JSON.stringify(currentMessages)) + estimateTokens(JSON.stringify(tools))
```

One-line change per loop, closes the tracker's known gap, and matters exactly when MCP makes it matter (pharos alone can contribute ~50 tool schemas ≈ 15–20K tokens). `countRequestTokens` already counts tools post-hoc ([tokenCounter.ts:87](../../src/services/tokenCounter.ts#L87)) — this aligns the pre-flight guard with it.

## Build checklist (design-plan workflow, 2026-08-06)

12 slices, 5 phases. Effort/hardness/model/verify assessed per slice against the code, not guessed. Legend: ⚠ = needs an adversarial verify pass after implementation.

### Phase 1 — seams and pure modules (no MCP runtime yet) · opus batch — **DONE 2026-08-06**

- [x] **build-tools-array-extraction** — [src/tools/buildToolsArray.ts](../../src/tools/buildToolsArray.ts). Both orchestrator sites now call it; the gating (`shellProtocol`, `lspTools` × availability, web-search auto) moved into the builder as explicit inputs, so the two loops read `caps` and `wsState` and nothing else. `extraTools` is the MCP merge point, appended last. Orchestrator's tool-definition imports collapsed to just `executeToolCall`.
- [x] **token-budget-tools-term** — both soft stops now price `estimateTokens(JSON.stringify(tools))`. The hoist the assessment predicted was needed in **both** loops, not just `runToolLoop`: the streaming loop also built its array after the check. Tools are now built first in both, which is also what makes the term available.
- [x] **mcp-servers-config-contribution** — [src/mcp/config.ts](../../src/mcp/config.ts) + `moby.mcpServers` in package.json (`scope: "application"`, so the settings UI won't even offer a workspace value). `readMcpServersSetting()` uses `inspect().globalValue`; workspace/folder values are detected only to emit one warning naming why they're ignored. Wired into activation as a report-only load (Phase 2's manager is what will act on it).
- [x] **tool-namespacing-and-name-validation** — [src/mcp/toolNaming.ts](../../src/mcp/toolNaming.ts). `parseToolName` splits on the **first** `__` after the prefix, which is unambiguous because server names forbid underscores — so a tool whose own name contains `__` round-trips. `inputSchema` → `parameters` is a straight pass-through.

**Gates:** typecheck clean; `test:all` green twice (3,446 — 39 new); webpack clean. 39 unit tests across the three modules. No verify pass needed beyond the ⚠ config one, which is pinned by a test asserting the *mechanism* (`inspect` called, `get` never called), not just the outcome — the merged-`get()` twin would pass an outcome-only test.

### Phase 2 — MCP core: manager + request-path dispatch · fable batch

- [ ] **mcp-server-manager-core** (high, hard-reasoning, ⚠) — `src/mcp/McpServerManager.ts`: spawn/handshake/tool-cache/disposal on the LspAvailability + drawingServer stencils. Silent failure modes to design against: handshake racing an early `getToolsForRequest()`, `list_changed` re-list racing an in-flight list, transport-close leaving stale tools in the array, disposal tied to chatProvider (which `deactivate()` never disposes — the plausible-but-wrong trap).
- [ ] **request-path-dispatch-and-results** (high, hard-reasoning, ⚠) — prefix dispatch in `dispatchToolCall`, result/error/timeout/abort conventions, merge into `buildToolsArray()`. ADR-0008-shaped silent failures: a signal accepted but not forwarded into the SDK call (Stop returns, MCP request keeps running); `isError` without the `Error:` prefix reads as success at all three `startsWith` checks; a dropped non-text block violates never-silence invisibly.

`/shipshape` at the boundary; **first smoke `/verify` against pharos-mcp possible here** (server connects, tools appear, a call round-trips). Start the ADR decision skeleton when this phase lands — don't defer all prose to Phase 5.

### Phase 3 — lifecycle policy + capability surfaces · opus batch

- [ ] **crash-policy-and-refresh-command** (medium, moderate, ⚠) — bounded restart w/ backoff, spawn-death vs post-handshake-crash distinction, tools-slice eviction on `failed`, `moby.refreshMcpServers`. Verify targets: a backoff timer firing after dispose/reconciliation restarting a removed server; a spawn-failing server restart-looping. **Lands before reconciliation** — "stay failed until config change" is unimplementable the other way around.
- [ ] **config-change-reconciliation** (medium, moderate) — per-entry diff at the [extension.ts:47](../../src/extension.ts#L47) listener → stop removed / start added / restart changed. Mid-turn edge is owned by Phase 5, not here.
- [ ] **instructions-system-prompt-block** (low, mechanical) — `--- MCP SERVERS ---` block, zero-servers-zero-bytes, native-only gate, 2,000-char cap.
- [ ] **roots-capability** (low, mechanical) — declare `roots.listChanged`, serve workspace folders, notify on `onDidChangeWorkspaceFolders`.

`/shipshape` + **mandatory dev-host `/verify`**: edit settings.json live (reconciliation), kill pharos (crash → failed → refresh), confirm the prompt block.

### Phase 4 — pin it: unit + fixture-server tests · opus

- [ ] **test-harness-inmemory-and-fixture-server** (medium, moderate) — `InMemoryTransport` unit tier + 3-tool fixture stdio server (echo / slow-tool / error-tool) for child-process lifecycle and `listChanged` (pharos declares `listChanged: false`, so the fixture is the only coverage of that path). **Make the 30s timeout injectable before writing the slow-tool spec** or CI inherits a 30s sleep.

### Phase 5 — adversarial hardening + ADR + M44 · fable

- [ ] **hardening-adr-and-backlog** (high, hard-reasoning) — lifecycle-edge pass (server dies mid-call, config change mid-turn, `list_changed` mid-turn — teardown/abort-race territory per ADR 0008 experience), then the ADR (trust model, global-scope-only, namespacing, decline-sampling, 30s timeout, LSP decision gate), M44 backlog entry, tracker updates. This slice IS the verify pass — no second one layered on it.

**Critical path:** config-contribution → manager-core → dispatch → test-harness → hardening.

**Do NOT over-verify** (failures are loud, shipshape suffices): extraction, namespacing, token-budget, instructions block, roots, test harness.

**Later (separate effort)** — prompts (`/` provider) + resources (`@` provider riding `droppedFileContents`). Not in this doc's scope.

## Testing

- **Unit**: manager against the SDK's `InMemoryTransport` linked pair — handshake, cache, listChanged, crash/restart policy, name validation, result/error translation. No child processes in unit tests.
- **Integration**: a tiny fixture stdio server (Node script, 3 tools: echo, slow-tool for timeout, error-tool for `isError`) spawned for real — pins the actual child-process lifecycle.
- **Dev-host (M44)**: pharos-mcp as the real server. Known pharos facts that shape the test plan: 34 curated + ~19 debug tools behind a **config-driven allowlist** (tool count varies — never assert a fixed number); declares `instructions` (good — exercises the prompt block); declares `tools.listChanged: false` and **no** prompts/resources (so listChanged needs the fixture server, not pharos); hand-rolled protocol pinned to `2024-11-05` (exercises SDK version negotiation with an older server).

## Relationship to the built-in LSP tools (decision gate, raised 2026-08-06)

The built-in LSP integration is both the **stencil** for `McpServerManager` and a **deprecation candidate** once MCP lands — pharos-mcp alone offers 34 curated tools against our 5, and other LSP MCP servers exist. Honest ledger:

- **What built-in has that pharos can't replicate:** it rides VS Code's *already-running* language services via command proxies — zero extra processes, and it works for any language the user has an editor extension for, including ones with no standalone LSP binary. Pharos spawns its own servers (duplicate memory, binaries must be on PATH) but is far richer and maintained as its own project.
- **What built-in actually costs:** the availability service is the flakiest part of the codebase in practice — see the Active Bug (2026-08-06): a symbol-less sample file marks a whole language unavailable for the session, and the retry re-probes the same file. Test reality: 73 unit tests, all against the vscode mock; **M30 (P0) has never been walked in a dev host** since Phase 4 shipped; no e2e tier touches real LSP. Logic-tested, reality-untested.
- **Decision gate:** after MCP Phase 2 is dogfoodable, run the same navigation workflows through `mcp__pharos__*` and through the built-in tools. If pharos-through-MCP covers them, deprecate the built-in path (retire `lspTools` + `LspAvailability`, or default the capability off) rather than fixing the probe. Until then: **don't invest in the availability service beyond what MCP stencils from it** — the parts worth copying (cached registry, sync reads, disposal) are lifecycle patterns, not the probing heuristics.

## Open questions (for the ADR, not blockers)

1. Spawn eagerly at activate or lazily at first native-tool-capable turn? Leaning eager-with-delay (LSP pattern) — a cold server adds seconds to the first turn otherwise.
2. Does the 30s default timeout need a per-server config knob in v1? Leaning no — add when a real server needs it.
3. Should the status command be a full webview surface or just an output-channel dump? Leaning dump — parity with LSP availability's log-based visibility.
