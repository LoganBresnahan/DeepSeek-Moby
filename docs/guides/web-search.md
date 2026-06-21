# Web Search

How Moby searches the web, digests the results, caches them, and keeps the model from re-issuing the same search in a loop.

## Overview

Web search has two entry modes and a shared dispatch/caching core, all owned by `WebSearchManager` ([src/providers/webSearchManager.ts](../../src/providers/webSearchManager.ts)):

- **Manual mode** — the manager pre-fetches results for the user's message and the orchestrator injects them into the system prompt (`searchForMessage`). The `web_search` tool is **not** offered to the model that turn.
- **Auto mode** — the `web_search` tool is in the model's schema; the model calls it itself, routed through `searchByQuery`.

Both modes share one cache, one provider registry, and one subagent digester.

## Pipeline

```
web_search tool                 src/tools/workspaceTools.ts   (tool schema)
  → orchestrator dispatch        requestOrchestrator.ts        (dispatchToolCall: name === 'web_search')
  → webSearchManager.searchByQuery()
  → provider.search()            Tavily / SearXNG (via WebSearchProviderRegistry)
  → subagentRouter.route()       web-search-digest subagent (deepseek-v4-flash)
  → formatted/digested string returned as the tool result
```

The reasoner (R1) path reaches the same `searchByQuery` through its own `<web_search>`-tag loop; both entry points share the manager, its cache, and its ledger.

## Provider abstraction

The manager never references a concrete provider. It resolves the active one at call time via `WebSearchProviderRegistry.active()`, so a provider swap (Tavily ↔ SearXNG ↔ future) is a settings change, not a code change. All providers normalize to the `WebSearchResponse` shape in [src/clients/webSearchProvider.ts](../../src/clients/webSearchProvider.ts).

## Digest subagent

Every search whose response exceeds a small threshold is routed to the `web-search-digest` subagent, which ranks/condenses the results so only a focused digest reaches the main model. Details and schema: [docs/plans/subagents.md](../plans/subagents.md). The digest cost is paid **once per genuinely-new search** — cache hits skip it (see below).

## Cache + ledger (ADR 0010)

> Decision record: [ADR 0010 — Web-search query ledger and near-duplicate cache](../architecture/decisions/0010-web-search-query-ledger-and-cache.md). Pairs with [ADR 0007](../architecture/decisions/0007-system-prompt-temporal-grounding.md), which deliberately makes the model search *more* for time-sensitive facts; the controls here keep that extra searching from degenerating into a near-duplicate storm (a traced session once issued **71 `web_search` calls in one turn**, ~140 `deepseek-v4-flash` digest calls).

Two independent layers fix two different problems.

### Layer 1 — Normalized cache key + cached digest (cost)

The cache is a per-session `Map` with a TTL of `cacheDuration` minutes (default 15), cleared on a new conversation (`clearCache`) and on `resetToDefaults`. Each entry stores the **post-digest** string plus `routedDigest` and `resultCount`.

The cache key is built from a **normalized** query via [`normalizeQueryKey`](../../src/providers/webSearchManager.ts), plus the settings that affect results (`depth`, `maxResults`/`credits`). Normalization:

- lowercases,
- turns punctuation/symbols into spaces (so `salah/worldcup2026` ≡ `salah worldcup2026`),
- collapses whitespace,
- strips a **tiny** closed-class stopword set (so `what is the worldcup2026 schedule` ≡ `worldcup2026 schedule`).

It is **conservative by design**: a wrong normalization degrades to a cache **miss** (a harmless re-fetch), never to a wrong-answer **hit**. It deliberately does **not** token-sort and does **not** stem content words — word order can be semantically load-bearing (`dog bites man` ≠ `man bites dog`), and settings stay in the key so a settings change still re-fetches.

> **Note — divergence from the ADR snippet.** The ADR's illustrative `normalizeQueryKey` includes `.sort()` (token-sort). The implementation omits it, because token-sort would wrongly collide order-distinct queries and fails the ADR's own most-important negative test. The dominant trace pathology (filler-word / punctuation rephrasings of the *same* target) is collapsed without sorting.

Because a hit returns the stored post-digest string, it reaches **neither** the provider **nor** the subagent router — so a near-duplicate now costs **zero** provider fetches and **zero** digest calls.

### Layer 2 — Per-turn search ledger (behavior)

A cache only makes a redundant search *cheap*; it does not stop the model from *issuing* it and burning iterations. The ledger fixes the behavior: `WebSearchManager` keeps a small per-turn record of the searches the model issued — keyed by the normalized query, recording the original text and a one-line outcome:

```
SEARCHES THIS TURN (do not repeat — reuse these results):
  • "worldcup2026 schedule"      → 5 results
  • "rezarahiminia worldcup2026" → 3 results
  • "kickoffapi free tier"       → 0 results (nothing found; try a different source)
```

- **Where it resets:** `setRecentUserPrompt`, which the orchestrator calls once at the top of each turn (next to `fileContextManager.clearTurnTracking()`).
- **Where the model sees it:** the orchestrator appends `renderSearchLedger()` to the `web_search` tool result in `dispatchToolCall` (and to the R1 path's results context). It rides on the **tool result**, not the system prompt, because the system prompt is built once per turn and so can't carry a ledger that accumulates *during* the tool loop — the result is the freshest place, visible exactly when the model decides whether to search again.
- **Why a ledger, not a limit:** a hard block reads to the model as a dead end and tends to make it **stop the turn**; the ledger informs without halting, so the model declines the redundant call but keeps working the problem. (See ADR 0010, Alternative D.)
- The `0 results` line doubles as a dead-end signal so the model stops re-querying a target that genuinely has nothing.

## Settings

- `moby.webSearch.*` — mode (off/manual/auto), depth, `creditsPerPrompt`, `maxResultsPerSearch`, `cacheDuration`.
- `moby.subagents.webSearchDigest.maxResults` — the digest output cap (the popup slider writes this).

## Related follow-up

The same "you already did this" signal generalizes to **`read_file`** — a re-read of an unchanged file could be answered from context instead of re-streamed. This is a deliberate fast-follow, **not** in the 0010 implementation, because it is correctness-sensitive in a way search is not: a wrong "unchanged" answer feeds the model **stale file content** it may edit against. It requires an invalidation guard (no `write_file`/`edit_file`/`run_shell` touched that path this turn, and a content-hash/mtime match) before it is safe to ship. Tracked as a follow-up in [ADR 0010](../architecture/decisions/0010-web-search-query-ledger-and-cache.md).

## Tests

- [tests/unit/providers/webSearchManager.test.ts](../../tests/unit/providers/webSearchManager.test.ts) — `normalizeQueryKey` (true-positive collapse, the order-distinct false-collision guard, degenerate fallback), normalized-key cache hits skipping provider + subagent, settings/TTL/`clearCache` partitioning, and the per-turn ledger (rendering, near-duplicate collapse, zero-result/error dead ends, turn reset, cross-turn cache-hit ledgering).
- [tests/unit/providers/requestOrchestrator.test.ts](../../tests/unit/providers/requestOrchestrator.test.ts) — `dispatchToolCall` appends the ledger to the `web_search` tool result.
