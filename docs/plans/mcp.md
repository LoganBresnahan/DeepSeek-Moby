# MCP Client Integration — Design

**Status: implemented — all 5 phases landed 2026-08-06 → 2026-08-11 ([ADR 0016](../architecture/decisions/0016-mcp-client-integration.md) Accepted). Remaining: the [M44](manual-test-backlog.md) dev-host walk, which also carries the LSP-deprecation gate.**
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
- [x] **mcp-servers-config-contribution** — [src/mcp/config.ts](../../src/mcp/config.ts) + `moby.mcpServers` in package.json (originally `scope: "application"`; **relaxed to `window` in Phase 3** so each VS Code profile carries its own list — see that slice). `readMcpServersSetting()` uses `inspect().globalValue`; workspace/folder values are detected only to emit one warning naming why they're ignored. Wired into activation as a report-only load (Phase 2's manager is what will act on it).
- [x] **tool-namespacing-and-name-validation** — [src/mcp/toolNaming.ts](../../src/mcp/toolNaming.ts). `parseToolName` splits on the **first** `__` after the prefix, which is unambiguous because server names forbid underscores — so a tool whose own name contains `__` round-trips. `inputSchema` → `parameters` is a straight pass-through.

**Gates:** typecheck clean; `test:all` green twice (3,446 — 39 new); webpack clean. 39 unit tests across the three modules. No verify pass needed beyond the ⚠ config one, which is pinned by a test asserting the *mechanism* (`inspect` called, `get` never called), not just the outcome — the merged-`get()` twin would pass an outcome-only test.

### Phase 2 — MCP core: manager + request-path dispatch · fable batch — **DONE 2026-08-06**

- [x] **mcp-server-manager-core** — [src/mcp/McpServerManager.ts](../../src/mcp/McpServerManager.ts) + `@modelcontextprotocol/sdk` 1.30.0 (bundles clean under webpack). All four named failure modes closed: `getToolsForRequest()` is sync and returns only `ready` servers' slices (a mid-handshake server contributes nothing to that request); `list_changed` re-lists serialize on a promise chain with a per-entry **generation counter** that discards any await landing after a stop/dispose; `client.onclose` evicts the server's tools immediately and marks it `failed`; disposal rides `context.subscriptions` in extension.ts. Env is merged over `getDefaultEnvironment()` — passing `env` alone would *replace* the SDK's safe default set and break most commands. Handshake and tools/list carry 30s timeouts (SDK default is 60s); the call timeout is a private field so Phase 4's slow-tool spec can inject it. Results are capped at 100K chars with a named truncation marker (ADR 0014's convention).
- [x] **request-path-dispatch-and-results** — `isMcpToolName` branch at the top of `dispatchToolCall` (before web_search, before `executeToolCall`); both `buildToolsArray` sites pass `extraTools: McpServerManager.getInstance().getToolsForRequest()`, so MCP tools are priced by the token soft stops for free. All three ADR-0008-shaped failures are pinned by tests: signal + timeout forwarded into the SDK `callTool` options; `isError` → `Error:` prefix via [callResult.ts](../../src/mcp/callResult.ts) (pure module — treats the SDK result as `unknown` so a misbehaving server degrades to a named error); non-text blocks become named placeholders, zero-content results are named, never empty strings.

**Adversarial verify (2026-08-06, independent reviewer):** confirmed the eight design-named failure modes closed, and found three real gaps, all fixed same-day: (1) **schema fidelity — the real bug**: `namespaceTool` rebuilt `parameters` from `properties`/`required` only, silently dropping sibling keys like `$defs` — a FastMCP/pydantic server's `$ref`s would have reached the model unresolvable and broken every call to the tool. The whole `inputSchema` now passes through (`ToolFunction.parameters` gained an index signature to say so honestly); only `type`/`properties` are pinned and a malformed `required` dropped. (2) The startup `tools/list` ran outside the re-list serialization, so a `list_changed` firing mid-startup could have its fresh result overwritten by the slower startup response — same generation, so the gen guard couldn't catch it. The startup list now heads that server's refresh chain (per-server chains, startup errors still bubble to `failed`). (3) `dispose()` during the handshake window closed nothing — `client` publishes post-handshake — so the entry now holds the transport from spawn and dispose closes it directly.

**Landed notes (2026-08-06):** roots + instructions-block deliberately deferred to Phase 3 as planned — declaring `roots.listChanged` without a `roots/list` handler would hand servers a method-not-found, so Phase 2 declares `capabilities: {}` (which also declines sampling/elicitation by omission). Real-server smoke against pharos passed outside VS Code: handshake 464ms (SDK negotiated pharos's hand-rolled 2024-11-05 protocol), instructions captured (702 chars), 37 tools listed, echo round-trip, `isError: true` shape exactly as `translateCallResult` expects, `tools.listChanged: false` as predicted (fixture server owns that path in Phase 4). Crash-path smoke: child death fires `client.onclose` (eviction works) and pre-handshake death rejects `connect()` (→ `failed`). **Trap for M44:** `pharos` on PATH is a Node *launcher* whose BEAM grandchild holds the stdio pipes — killing the launcher does not kill the server and no close fires (correct, but confusing to test); kill the `beam.smp` process to exercise eviction. 30 new unit tests (11 callResult + 16 manager + 3 dispatch-seam).

### Phase 3 — lifecycle policy + capability surfaces · opus batch — **DONE 2026-08-07**

- [x] **crash-policy-and-refresh-command** — restart budget of 2 with `[2s, 10s]` backoff, then `failed` until a settings change or `moby.refreshMcpServers`. Two rules carry the weight: a server that **never handshaked is never restarted** (`spawn ENOENT` on a typo'd command can't succeed by retrying), and the budget **only resets after 60s of ready uptime** — resetting on every `ready` would let a handshake-then-exit server restart forever, which is the same defect as the spawn loop wearing a disguise. `stopServer()` bumps the generation *and* clears the pending timer, and the timer callback re-checks disposal, map identity, generation, and status before restarting — four ways the server could legitimately have gone away while it was pending.
- [x] **config-change-reconciliation** — per-entry diff at the config listener → stop removed / start added / restart changed (`serverConfigChanged` ignores `enabled`, so a flip to `false` reads as removal and back as addition). A changed entry is replaced, not mutated, so it gets a **fresh restart budget** — the edit is the user saying "try again". `reconcile()` claims the `started` flag, otherwise a warmup timer still pending would spawn every server a second time.
- [x] **instructions-system-prompt-block** — `--- MCP SERVERS ---` with the ready roster + each server's own instructions, capped at 2,000 chars per server, `''` when nothing is ready. Gated on `toolCalling === 'native'` **inside the non-reasoner branch**, so R1 (which never receives MCP tools) never reads about them.
- [x] **roots-capability** — `roots: { listChanged: true }` declared with its `ListRootsRequestSchema` handler registered **before** `connect`, serving `workspace.workspaceFolders` as `file://` URIs; `onDidChangeWorkspaceFolders` → `notifyRootsChanged()` over ready servers only. Verified against a purpose-built server that actually calls `roots/list`: it received the folder list correctly.
- [x] **per-profile-config-scope** (low, mechanical, user call 2026-08-07) — drop `"scope": "application"` from the `moby.mcpServers` contribution (defaults to window scope) so each VS Code profile carries its own server list; application scope forced the value into the Default profile's settings.json and warned everywhere else, which fights the user's profile-per-context setup (e.g. test servers only in `moby-dev`). **The security boundary does not move**: `inspect().globalValue` — which resolves to the active profile's user settings under window scope — stays the sole read, workspace/folder scopes stay ignored + warned, and the mechanism test (inspect called, merged `get()` never) still pins it. Accepted costs: the settings UI regains a workspace field that accepts-but-ignores values (runtime warning is the only feedback), and profiles don't layer — no shared baseline list, each profile curates its own. Touch-ups: the `scope: "application"` citations in this doc's config section, [ADR 0016](../architecture/decisions/0016-mcp-client-integration.md) decision 2, and the [config.ts](../../src/mcp/config.ts) module note.

**Adversarial verify (2026-08-07, independent reviewer):** all four crash-policy verify targets confirmed closed. Four gaps found and fixed same-day:

1. **The real bug — `stopServer` fire-and-forgot the close, so reconcile and refresh ran two copies of the same server.** The SDK closes *gracefully* (`stdin.end()` → 2s → SIGTERM → 2s → SIGKILL), so a child can outlive the call by up to 4s. A server holding an exclusive resource (port, lockfile, sqlite WAL) then failed to start — and because that failure happens *before* a handshake, the restart policy correctly refuses to retry, leaving it dead until the next config edit. `moby.refreshMcpServers`, the documented escape hatch, had the same shape and so deterministically re-broke what it exists to fix. `stopServer` now returns the close promise; reconcile defers each replacement's *spawn* behind its own stop (registering the entry synchronously so the map stays authoritative), and `restartAll` awaits every close. Disposal keeps fire-and-forget on purpose — blocking `deactivate()` for 4s per server would stall window close. **Verified both directions against a real port-holding server**: fixed code reaches `ready` through both reconcile and refresh; the pre-fix behaviour, restored by patching the method, left it `failed / everReady:false / 0 attempts / no timer` — permanently dead.
2. **The `list_changed` handler was the only client callback without a generation guard**, and resolved its entry by *name*. A closing child keeps its stdout listener for the whole close window, so a late notification could drive a refresh on the replacement — outside the refresh lane, same generation, nothing to discard the loser. Guarded like its two siblings.
3. **`everReady` flipped after the startup `tools/list`**, so a server that handshaked fine and died during that list was misfiled as "never handshaked", never retried, and logged a false diagnosis sending the user after a PATH problem that didn't exist. Now set immediately after `connect()`, matching the field's own doc comment.
4. **Server instructions could forge the block terminator.** `--- END MCP SERVERS ---` inside server-authored text would close our section early and let everything after it read as a first-class Moby prompt section (a forged **Code Edit Format**, a forged tool rule). The trust decision covers *the user chose to install this binary*, not *this binary's runtime output is trusted prompt material* — `npx some-mcp-server` is third-party code. Delimiter-shaped lines are now defanged; ordinary prose and inline em-dashes are untouched.

Also fixed from the reviewer's minor list: the refresh command told a user with three *disabled* servers to go add some.

**Landed notes (2026-08-07):** the command joins both doors — `package.json` *and* [commandCatalog.ts](../../media/actors/commands/commandCatalog.ts), so it's reachable from the palette, the commands popup, and `/` autocomplete. Roots smoke against real pharos: declaring the capability doesn't disturb a server that never asks for roots, and `sendRootsListChanged()` **rejects with "Not connected" on a closed client** — the `.catch()` in `notifyRootsChanged` is load-bearing, not defensive noise, because a server can close between the ready check and the send. 23 new unit tests (20 lifecycle + 3 prompt-gate).

**Still dev-host work (M44):** `/shipshape` + **mandatory `/verify`**: edit settings.json live (reconciliation), kill pharos's `beam.smp` (crash → failed → restart → refresh), confirm the prompt block reaches a real turn.

### Phase 4 — pin it: unit + fixture-server tests · opus — **DONE 2026-08-07**

- [x] **test-harness-inmemory-and-fixture-server** — 62 new tests across two tiers, plus the DI seam both need.

  **The seam first, as the plan required.** `McpServerManagerDeps` (transport factory + `callTimeoutMs` / `handshakeTimeoutMs` / `restartBackoffMs` / `stableUptimeMs`) with `McpServerManager.createForTest()`; the singleton passes nothing. Without it the slow-tool spec would sleep 30s and the restart specs ~14s. `MAX_RESTART_ATTEMPTS` is gone — the budget is now `restartBackoffMs.length`, so the count and the delays can't disagree.

  **[In-memory tier](../../tests/unit/mcp/McpServerManagerTransport.test.ts) — 20 tests, 173ms.** The manager against a *real* `Server` over `InMemoryTransport.createLinkedPair()`: genuine handshake and JSON-RPC, no child. Covers instructions/serverInfo capture, `$defs` schema fidelity, over-long-name skipping, no-tools-capability servers, `listChanged` (replace / serialize back-to-back / ignore-after-stop), call round-trip, `isError`, non-text placeholder, thrown-handler errors, injected timeout, abort, truncation, and roots (folders served, empty when none open, capability declared, **sampling and elicitation confirmed absent**).

  **[Fixture-server tier](../../tests/integration/mcp/fixtureServer.test.ts) — 15 tests, 4.2s.** A real spawned child ([fixture-server.js](../../tests/fixtures/mcp/fixture-server.js): echo / slow / fail / image / huge / add_tool / nested-with-`$defs`, plus `bad-name` and crash modes via `FIXTURE_MODE`). This tier holds what only a process can show: `spawn ENOENT`, the two crash-policy scenarios promised above (now ~1s each instead of 18s), a crash *during* the startup `tools/list`, tools eviction on death, `listChanged` driven by a real notification (pharos declares `listChanged: false`, so this is its only coverage), env reaching the command, reconciliation replacing a live child, and disposal actually killing the pid.

  **Three falsification passes, and one caught a vacuous test.** Reverting the Phase 3 `everReady` fix correctly failed the crash-during-list spec. But the first `list_changed` generation-guard test passed *with the guard removed* — it was being satisfied by the `client === null` check instead. The guard's real window belongs to the stdio transport (the SDK keeps the child's stdout listener attached through the ≤4s graceful close, and `Protocol._onclose()` does **not** clear `_notificationHandlers`, so a late notification genuinely does reach our closure), and `InMemoryTransport` severs instantly, so no transport-level test can produce it. Replaced with one that drives the registered handler directly across a generation bump — it now fails when the guard is removed.

### Phase 5 — adversarial hardening + ADR + M44 · fable — **DONE 2026-08-11**

- [x] **hardening-adr-and-backlog** — the lifecycle-edge pass found **one real defect and one structural window**, both fixed:

  1. **Double-edit double-spawn.** `reconcile` deferred a replacement's spawn behind its *own* predecessor's close — but a replacement that never spawned stops instantly, so two settings saves inside the ≤4s graceful-close window let the second replacement spawn against the still-live **original** child. Two copies at once → a single-instance server fails **pre-handshake** → the restart policy rightly refuses to retry → permanently dead. The Phase 3 headline bug, resurrected one edit deeper. Fix: each entry carries a transitive `spawnGate` and `stopServer` now returns "the slot is free" (own close ∧ gate), so a replacement-of-a-replacement still waits for the original child.
  2. **`restartAll`'s cleared-map window.** Clear map → await stops → `startAll` meant a reconcile landing during the await saw an *empty* map and spawned everything as "added" while the old children were closing — after which restartAll spawned second copies over them. Fix: `restartAll` is now a **forced reconcile** (`applyConfig(true)`); the map stays authoritative throughout and the window structurally ceases to exist.

  The three named mid-turn edges were verified conforming and are now pinned: **die mid-call** (new fixture `die` tool — `process.exit` before responding; the call resolves to `Error: MCP server "fixture" — …`, tools evict, restart scheduled), **removal mid-call** (in-flight call resolves to a named error when a settings edit deletes the server), and **stale tool after `list_changed`** (dispatch deliberately doesn't gate on the cache — the server's refusal comes back named; the replacement tool works). A manager-wide mutex was considered and rejected for the fix — it would queue the user's *corrective* edit behind a hung 30s handshake (recorded in the ADR). 5 new tests (4 in-memory + 1 fixture, 130 MCP tests total); **both race specs falsified** — each fails against its pre-fix implementation (gate dropped / clear-map restored).

  ADR 0016 completed (status Accepted; decision 14, mid-turn-edges section, alternatives, consequences, revisit triggers) and its missing README index row added. The LSP deprecation decision stays **open behind M44 S6** — the comparison needs a dev host. [M44](manual-test-backlog.md) written: boot/scope/turn/reconcile/crash/roots plus the deprecation ledger, with the beam.smp trap called out.

**Critical path:** config-contribution → manager-core → dispatch → test-harness → hardening.

**Do NOT over-verify** (failures are loud, shipshape suffices): extraction, namespacing, token-budget, instructions block, roots, test harness.

**Later (separate effort)** — prompts (`/` provider) + resources (`@` provider riding `droppedFileContents`). Not in this doc's scope. **Decisions pinned 2026-08-11** (user asked why pharos contributed nothing to `/`; answer: correct twice — v1 is tools-only *and* pharos declares no prompts capability):

- **Tools never surface in `/`.** They are model-facing, called mid-turn with JSON arguments; a user-invokable tool row would be a debug console, not a command. Only MCP **prompts** (the protocol's user-facing template type) belong there, namespaced so a server can't shadow a built-in command. Resources go to `@`, not `/`.
- **Build trigger: the first configured server that declares a prompts capability.** Until then the phase would ship invisible — testable only against the fixture server. Don't build on spec.
- **The real cost is already known:** MCP prompts take arguments, and ADR 0015 queries are single-token (whitespace ends the span). A prompt with required args forces either ADR 0015's multi-token revisit or an accept-then-fill-arguments UX. That collision is the bulk of the phase, not the `prompts/list` plumbing.

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
