# 0016. MCP client integration — stdio tools with user-scope trust

**Status:** Draft — Phases 1–3 implemented (client core, dispatch, lifecycle policy, capability surfaces); consequences/alternatives and the LSP deprecation decision are completed by Phase 5's hardening pass.
**Date:** 2026-08-06 (amended 2026-08-07 with the Phase 3 lifecycle decisions)

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

## To be completed (Phase 5)

- The built-in LSP deprecation decision (gate: same workflows through `mcp__pharos__*` vs built-ins — see the plan's decision-gate section)
- Consequences, alternatives considered, revisit triggers

## Revisit triggers (accumulating)

- First server that genuinely needs variable expansion in config (`${env:…}`, `${workspaceFolder}`)
- First server that needs a per-server timeout knob
- Prompts/resources phase riding composer autocomplete (ADR 0015)
