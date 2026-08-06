# 0016. MCP client integration — stdio tools with user-scope trust

**Status:** Draft skeleton — Phase 2 (manager core + request-path dispatch) implemented; prose to be completed by Phase 5's hardening pass.
**Date:** 2026-08-06

Plan: [docs/plans/mcp.md](../../plans/mcp.md) — the design doc carries the full grounding; this ADR records the decisions that must outlive it.

## Context

Moby's tools were a closed set built into the extension. MCP is the ecosystem's standard for user-supplied tool servers, and the immediate motivating case is LSP-shaped: pharos-mcp offers ~34 curated navigation tools against Moby's 5 built-ins. Scope was decided 2026-08-04; the design doc grounds it in the code as of `e256fba`.

## Decision

1. **stdio transport only, v1.** HTTP/SSE adds auth + lifecycle complexity with no current user.
2. **User-scope config = trusted; no per-call approval.** `moby.mcpServers` is read from `inspect().globalValue` **only** — never the merged view — because a cloned repo's `.vscode/settings.json` must not be able to register a spawnable command (arbitrary code execution on folder-open). The contribution is `"scope": "application"` and the read path is pinned by a mechanism-asserting test (`inspect` called, `get` never).
3. **Namespacing `mcp__<server>__<tool>`.** The prefix is the dispatch discriminator; server names forbid underscores so the first `__` split is unambiguous. Over-long/non-conforming names are skipped with a named warning, never truncated (truncation risks collisions that mis-route calls).
4. **Sampling and elicitation declined.** Server-initiated model calls invert Moby's trust model. Declined by declaring no such capabilities.
5. **Results conform to the `Error:` string convention** (`isError` → `Error:` prefix; transport failures → `Error: MCP server "<name>" — <reason>`). Conform, don't fix — three `startsWith('Error:')` checks in the orchestrator are the only failure signal.
6. **Non-text content becomes a named placeholder; zero content is named; results cap at 100K chars with a named truncation marker.** Never silence.
7. **30s per-call timeout + abort signal forwarded into the SDK call.** MCP tools are the best-behaved tools in the codebase; the native tools' missing generic timeout is tracked separately, not fixed here.
8. **Lifecycle mirrors `LspAvailability`:** sync cache reads on the request path, all I/O at warmup/notification/dispatch time, per-entry generation counters discarding stale async work, disposal on `context.subscriptions` (NOT chatProvider, which `deactivate()` never disposes).

## To be completed (Phase 5)

- Crash/restart policy + refresh command (Phase 3 outcome)
- Config-change reconciliation semantics (Phase 3 outcome)
- Roots + instructions prompt block (Phase 3 outcome)
- The built-in LSP deprecation decision (gate: same workflows through `mcp__pharos__*` vs built-ins — see the plan's decision-gate section)
- Consequences, alternatives considered, revisit triggers

## Revisit triggers (accumulating)

- First server that genuinely needs variable expansion in config (`${env:…}`, `${workspaceFolder}`)
- First server that needs a per-server timeout knob
- Prompts/resources phase riding composer autocomplete (ADR 0015)
