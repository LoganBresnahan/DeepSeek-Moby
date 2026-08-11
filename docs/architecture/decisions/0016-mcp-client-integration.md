# 0016. MCP client integration — stdio tools with user-scope trust

**Status:** Accepted — all five phases implemented. The built-in-LSP deprecation decision remains open behind the M44 dev-host gate (below).
**Date:** 2026-08-06 (amended 2026-08-07 with the Phase 3 lifecycle decisions; completed 2026-08-11 by the Phase 5 hardening pass)

Plan: [docs/plans/mcp.md](../../plans/mcp.md) — the design doc carries the full grounding; this ADR records the decisions that must outlive it.

## Context

Moby's tools were a closed set built into the extension. MCP is the ecosystem's standard for user-supplied tool servers, and the immediate motivating case is LSP-shaped: pharos-mcp offers ~34 curated navigation tools against Moby's 5 built-ins. Scope was decided 2026-08-04; the design doc grounds it in the code as of `e256fba`.

## Decision

1. **stdio transport only, v1.** HTTP/SSE adds auth + lifecycle complexity with no current user.
2. **User-scope config = trusted; no per-call approval.** `moby.mcpServers` is read from `inspect().globalValue` **only** — never the merged view — because a cloned repo's `.vscode/settings.json` must not be able to register a spawnable command (arbitrary code execution on folder-open). That read is the entire boundary, pinned by a mechanism-asserting test (`inspect` called, `get` never). The contribution is **window-scoped**, so each VS Code profile carries its own server list; application scope would have been a second, UI-level barrier but confined the setting to the Default profile's `settings.json` and warned in every other profile, which fights profile-per-context workflows. Accepted cost: the settings UI offers a workspace field that accepts values and silently doesn't use them — the ignored-scope warning is the only feedback.
3. **Namespacing `mcp__<server>__<tool>`.** The prefix is the dispatch discriminator; server names forbid underscores so the first `__` split is unambiguous. Over-long/non-conforming names are skipped with a named warning, never truncated (truncation risks collisions that mis-route calls).
4. **Sampling and elicitation declined.** Server-initiated model calls invert Moby's trust model. Declined by declaring no such capabilities.
5. **Results conform to the `Error:` string convention** (`isError` → `Error:` prefix; transport failures → `Error: MCP server "<name>" — <reason>`). Conform, don't fix — three `startsWith('Error:')` checks in the orchestrator are the only failure signal.
6. **Non-text content becomes a named placeholder; zero content is named; results cap at 100K chars with a named truncation marker.** Never silence.
7. **30s per-call timeout + abort signal forwarded into the SDK call.** MCP tools are the best-behaved tools in the codebase; the native tools' missing generic timeout is tracked separately, not fixed here.
8. **Lifecycle mirrors `LspAvailability`:** sync cache reads on the request path, all I/O at warmup/notification/dispatch time, per-entry generation counters discarding stale async work, disposal on `context.subscriptions` (NOT chatProvider, which `deactivate()` never disposes).

9. **Restart policy: bounded, and asymmetric by failure kind.** A server that never completed a handshake is never restarted — a wrong `command` cannot become right by retrying. A server that crashes *after* being ready gets 2 restarts with `[2s, 10s]` backoff, then stays `failed` until a settings change or `moby.refreshMcpServers`. The restart budget resets only after 60s of ready uptime, because resetting on every `ready` transition would let a handshake-then-exit server restart forever — the spawn-loop defect in disguise.
10. **Config changes reconcile live; a changed entry is replaced, not mutated.** Stop removed / start added / restart changed, with the replacement getting a fresh restart budget — the user editing settings is the user saying "try again".
11. **Roots declared with its handler, serving workspace folders.** Registered before `connect`, `file://` URIs, `listChanged` notified on `onDidChangeWorkspaceFolders` to ready servers only (a closed client rejects the notification, so the send is guarded).
12. **A respawn always waits for the previous child to exit.** The SDK's close is graceful (up to 4s: `stdin.end()` → SIGTERM → SIGKILL), so reconcile and refresh await it before starting the replacement. Without this, single-instance servers — anything holding a port, lockfile, or WAL — fail to start, and that failure precedes a handshake, so the restart policy refuses to retry and the server stays dead. Disposal is the deliberate exception: nothing respawns after it, and blocking `deactivate()` would stall window close.
13. **Server-authored `instructions` are untrusted prompt input.** Injected verbatim *except* that delimiter-shaped lines are defanged, so a server cannot close the `--- MCP SERVERS ---` block early and have its text read as a first-class Moby prompt section. Installing a binary is not the same as trusting its runtime output.
14. **Status and enable/disable is a QuickPick that writes settings — not a webview modal, and not runtime state (2026-08-11).** Open question 3 resolved. Two halves:

    **Why a surface at all.** MCP failure is silent by construction: a dead server's tools simply leave the array, so Moby gets quieter and worse at things it could do an hour ago with no error anywhere the user looks. Worse, the only status surface we shipped was `moby.refreshMcpServers`, which **restarts every server in order to report on them** — up to a 4s graceful close each. A diagnostic that perturbs what it measures is the wrong instrument, so `moby.manageMcpServers` is read-only about state and writes only what the user toggles.

    **Why QuickPick over a modal.** Moby's modals are webview Shadow DOM actors, which means a new actor, postMessage types in both directions, protocol-drift entries, and harness specs. A QuickPick is extension-side only and carries ~90% of the value. Revisit if usage shows people wanting richer detail (per-server logs, tool lists) than a picker row holds.

    **Why the checkbox writes `moby.mcpServers` instead of holding a runtime flag.** A runtime-only toggle would be a second source of truth against the settings the manager reconciles to — and `serverConfigChanged` deliberately ignores `enabled`, so any unrelated config edit or reload would silently resurrect a server the user just switched off. Writing the setting also means *less* code, not more: the existing `onDidChangeConfiguration` listener fires and `reconcile()` does the start/stop with the awaited-close respawn from decision 12. The semantics fall out right too — a re-enabled server is a changed entry, so it gets a fresh restart budget, which is exactly what flipping the box back on means. The write targets `ConfigurationTarget.Global`, the same scope `inspect().globalValue` reads, so the security boundary of decision 2 is untouched. The raw settings object is cloned and patched rather than rebuilt from validated entries, so unknown or future keys survive a toggle.

15. **A stop means "the slot is free", not "my child closed" (Phase 5).** Each entry carries a `spawnGate` — the promise its own spawn was deferred behind — and `stopServer` resolves only when the entry's child *and* its gate have closed. Without the transitivity, two settings saves inside the ≤4s graceful-close window let the second replacement spawn against the still-live original child (stopping a never-spawned replacement is instant, but its slot isn't free), reviving decision 12's defect one edit deeper. For the same reason `restartAll` is a **forced reconcile**, not clear-map-then-start-all: with the map authoritative throughout, a settings edit landing mid-refresh diffs against the pending replacements instead of an empty map — the empty-map version double-spawned every server in that window. Both races are pinned by tests proven to fail on the pre-fix code.

## Mid-turn lifecycle edges (Phase 5 hardening pass, 2026-08-11)

A turn's tools array is built at iteration start and dispatch happens later, so every server-lifecycle event can land *between* the two. The invariant: **the model always gets a named `Error:` string it can react to on the next iteration — never a hang, never an unhandled rejection, never silence.** Verified and pinned per edge:

- **Server dies mid-call** — the SDK rejects the pending request when the connection drops; `executeTool` resolves it to `Error: MCP server "<name>" — …`, tools evict via `onclose`, and the crash policy proceeds (post-ready death → restart scheduled). Pinned against a real child that `process.exit`s mid-call.
- **Config change mid-turn** — a call in flight when its server is removed resolves the same way; a call to an already-removed server returns `Error: … is not connected`.
- **`list_changed` mid-turn** — dispatch deliberately does **not** gate on the manager's own cache; a stale name goes to the server, whose refusal comes back named. The server is the authority on its tools; the cache only feeds the next array build.

## Alternatives considered

- **Per-call approval UI** (the `CommandApprovalManager` pattern). Rejected: navigation-shaped tools get called dozens of times per turn; per-call friction would make the feature unusable for exactly its motivating case. The trust boundary sits at config-write time instead (decision 2).
- **Workspace-scope config behind a trust prompt** (VS Code "do you trust this workspace" style). Rejected for v1 — global-scope-only is simpler and strictly safer, and no user has asked for per-repo servers. Revisit trigger below.
- **Manager-wide async mutex serializing reconcile/refresh.** Rejected in favor of per-slot spawn gates + identity/generation guards (decisions 8, 14): a mutex would queue the user's *corrective* config edit behind a hung 30s handshake — the edit exists precisely to fix that server. The gates keep edits responsive while pinning correctness per slot.
- **Hand-rolled JSON-RPC framing**; **HTTP/SSE transports in v1**. Rejected / deferred per decisions 1 and the scope table in the plan.

## Consequences

**Positive:**

- User-supplied tools dispatch exactly like native ones — priced by the token soft stops, timed out at 30s, abortable by Stop — and every failure shape (crash, timeout, removal, stale name, malformed result) reaches the model as a named `Error:` string, so a turn survives server churn.
- A crashed server's tools leave the request array immediately; the restart policy is bounded and asymmetric (never retry a bad command, never let a crash loop self-reset), so a broken server costs log lines, not turns.
- The prompt block plus namespaced tools means zero configured servers costs zero bytes and zero behavior change.

**Negative / accepted costs:**

- Trust is coarse: whole-server at install time, no per-tool allowlist on Moby's side. A buggy or malicious tool executes with user privileges the moment the model calls it. Mitigation today is server-side (pharos's own config allowlist); a Moby-side allowlist is a revisit trigger.
- A ready server's tool schemas ride **every** native-tool request (~37 pharos tools ≈ 15–20K tokens). The soft stops now price it, but the user's only lever is disabling the server.
- Instructions sanitation defangs delimiter forgery only — server text can still *persuade*; it just can't impersonate Moby's prompt structure. Accepted under the install-time trust model.
- A config edit can take up to ~4s to take effect (the graceful close serializes the respawn) and surfaces as `starting` in the status meanwhile. Correctness over immediacy.
- stdio only; non-native-tool-calling models get nothing (by design — the wire gate at `deepseekClient` drops tools for them).

## Built-in LSP deprecation — decided 2026-08-11: **keep and fix, don't deprecate**

The gate asked whether pharos-through-MCP should replace Moby's built-in LSP path. Answer: no, and the framing was wrong — the two serve different populations.

**What decided it.** The built-in path rides VS Code's *already-running* language services via command proxies, so it works for anyone with a language extension installed — which is everyone, since that is how you get highlighting and squiggles at all. Pharos spawns its own servers and needs standalone LSP binaries on `PATH`, a much narrower population (observed cold-booting HLS for ~3s in the 2026-08-11 session). Retiring the built-ins would have removed the surface that serves every user in favour of one that serves the configured minority.

**The evidence that looked damning, re-read.** That same session showed the probe declaring javascript, csharp, and yaml all unavailable while pharos navigated fine — but the diagnosis was under-investment, not a wrong architecture. Two concrete, small defects: the probe conflated "a provider answered with zero symbols" with "no provider exists", and the tool surface had five tools where the same command-proxy pattern yields more for the same effort per tool. Both fixed the same day (see the LSP integration doc); a third, subtler consequence turned out to be the real damage — `available.length > 0` gated the *tools themselves*, so a mis-marked workspace lost the tools entirely and with them any chance of a tool result correcting the map.

**Consequences accepted.** Both surfaces now coexist: the built-ins as the zero-config default, pharos-through-MCP as the deep surface for users who install it. That is the payoff of having built the MCP client — the question stops being "which one survives". The cost is two navigation surfaces to keep in mind, and a model that may see both sets of tools at once when a user configures pharos (a tool-count concern tracked with the per-request schema-cost trigger above).

**M44 S6 remains worth walking** as a quality comparison — which surface answers navigation questions better — but it is no longer a survival gate for the built-in path.

## Revisit triggers (accumulating)

- First server that genuinely needs variable expansion in config (`${env:…}`, `${workspaceFolder}`)
- First server that needs a per-server timeout knob — *first near-miss observed 2026-08-11: pharos's `get_diagnostics` waits internally ~30s for `publishDiagnostics`, tying with our 30s call timeout; ours fired 100ms early, turning pharos's named "no diagnostics received" answer into an abort. Benign (the late response only produced a logged `unknown message ID` transport error, no eviction), but a second occurrence on a different tool is the trigger.*
- Prompts/resources phase riding composer autocomplete (ADR 0015) — trigger: the first configured server declaring a prompts capability. Decisions already pinned in the plan's "Later" section: tools never surface in `/`, prompts do (namespaced), and prompt *arguments* collide with ADR 0015's single-token queries — that collision is the phase's real cost.
- User demand for workspace-scoped servers (would need a real trust-prompt flow, not just a scope change)
- **Per-request tool-schema cost — two rungs, neither taken yet (sized 2026-08-11).** Measured against a real turn: iteration 1 sent **13,104 prompt tokens** for a conversation whose message content was **2,383** — the remainder was the system prompt plus 47 tool schemas (11 native + 37 pharos), and that array is re-sent **every iteration** (12× in that turn). Note what this is *not*: at V4's ~983K context this is under 1% of the window, so it is a cost-and-attention problem, not a context-pressure one. Escalate only in this order:
  1. **Per-server tool allowlist in config** (`"tools": [...]` on the server entry). Trigger: a user runs a server whose surface is mostly noise to them. Most of the win, no model-behaviour risk, no latency, no caching interaction. pharos already works this way internally. **This is the first move; do not skip to rung 2.**
  2. **Lazy tool loading** (catalog of names + one-line descriptions in the prompt, a `search_tools` native tool that returns full schemas on demand, fetched tools joining the array for the rest of the turn). Trigger: **three or more configured servers**, where curation stops scaling. The seam already exists — `buildToolsArray()` with its `extraTools` merge point, plus the per-iteration rebuild that makes mid-turn additions natural; the new state would be a per-request "unlocked this turn" set. Three risks to settle *before* building, not after: **(a) prompt caching** — tools sit ahead of messages in the request, so mutating the array mid-turn invalidates the cached prefix for every later iteration, meaning a turn that *does* need MCP tools could cost more than sending them all upfront; **(b) model compliance** — the search-then-call dance is trained behaviour in some models, and a model that skips the search silently loses capability rather than failing loudly; **(c) latency** — an extra round trip before real work begins, against observed 1–13s iterations.
- Image content blocks in results could ride digest routing (ADR 0014's pipeline) instead of the named placeholder
