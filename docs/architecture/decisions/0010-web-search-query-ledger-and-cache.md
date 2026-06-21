# 0010. Web-search query ledger and near-duplicate cache

**Status:** Accepted — implemented. Layer 1a omits the ADR snippet's `.sort()` (token-sort would fail the order-distinct false-collision guard); Layer 2's ledger rides on the `web_search` tool result rather than the system prompt (built once per turn, so it can't carry a ledger that accumulates during the tool loop). The `read_file` generalization is deferred as a guarded fast-follow.
**Date:** 2026-06-20

## Context

A traced auto-mode session (the "914pm" turn) issued **71 `web_search` calls in a single turn**, the overwhelming majority near-duplicates of one another. Clusters from the trace: `rezarahiminia/worldcup2026` three times inside a 20-second window, `salah23222/worldcup2026` five times, `kickoffapi …` four times — the model orbiting the same handful of targets, rephrasing trivially each lap. Because subagent digestion is wired into every search, each of those 71 calls also spawned a `web-search-digest` subagent ([webSearchManager.ts:517](../../../src/providers/webSearchManager.ts#L517)), so the turn cost roughly **140 `deepseek-v4-flash` calls** on top of the 71 provider fetches.

The dispatch pipeline, end to end:

```
web_search tool                 src/tools/workspaceTools.ts:146  (tool schema)
  → orchestrator dispatch        requestOrchestrator.ts:2746     (toolCall.name === 'web_search')
  → webSearchManager.searchByQuery()   webSearchManager.ts:468
  → provider.search()            searxngClient.ts:55 / tavilyClient
  → subagentRouter.route()       webSearchManager.ts:517
  → digest subagent              router.ts:66  (client.chat on a lazily-created
                                               deepseek-v4-flash client, router.ts:155-163)
```

(The reasoner path reaches the same `searchByQuery` through its own loop at [requestOrchestrator.ts:2447](../../../src/providers/requestOrchestrator.ts#L2447); both entry points share the manager and its cache.)

**A cache already exists**, and it is not the gap. `WebSearchManager` holds `private cache = new Map<string, { results, timestamp }>()` ([webSearchManager.ts:56](../../../src/providers/webSearchManager.ts#L56)), keyed for tool searches by `tool|${query.toLowerCase().trim()}|depth=…|maxResults=…` ([webSearchManager.ts:487](../../../src/providers/webSearchManager.ts#L487)) and for manual-mode message searches by an analogous key ([webSearchManager.ts:297](../../../src/providers/webSearchManager.ts#L297)). It is per-session with a TTL of `cacheDuration * 60000` (default 15 min), and it is cleared on a new conversation via `clearCache()` ([webSearchManager.ts:262](../../../src/providers/webSearchManager.ts#L262)), called from `ChatProvider.clearConversation` ([chatProvider.ts:1198](../../../src/providers/chatProvider.ts#L1198)).

Three properties of the current design explain why it did nothing for the 914pm turn:

1. **Dedup is exact-match only.** The key is `lowercase().trim()` plus settings — no normalization. `world cup 2026 schedule` and `worldcup2026 schedule` are different keys; `salah worldcup2026` and `salah23222/worldcup2026` are different keys. The model's trivial rephrasings sail straight past the cache as misses.

2. **The digest is not separately reusable.** What gets stored at [webSearchManager.ts:532](../../../src/providers/webSearchManager.ts#L532) is the *formatted/digested string* under the raw-query key. A near-duplicate that misses the cache (point 1) re-runs the provider fetch **and** re-routes the subagent — paying the ~2x-per-search digest cost again — even when the underlying results are substantially the same.

3. **The model is never shown what it already searched.** Each `web_search` is an isolated tool call; the tool result comes back as digested text with no record of the *query history*. Nothing in the model's context says "you already searched `worldcup2026` this turn and got 5 results." So the model re-issues near-duplicates **blind** — it has no signal that it is looping.

The decisive observation: **a smarter cache does not stop the flailing.** Even a perfect cache only makes the redundant calls *fast* — the model still *issues* all 71, still reads 71 tool results, still burns iterations and context window orbiting the same target. The thing that actually stops the loop is making the model *aware* of its own search history so it declines the redundant call itself. Cache fixes cost; only a model-facing ledger fixes behavior. We need both, and they are not substitutes.

This pairs with the temporal-grounding work in ADR [0007](0007-system-prompt-temporal-grounding.md), which deliberately *increases* legitimate searching (the model is told its training data is stale and should verify time-sensitive facts). Without the controls here, 0007 would amplify exactly this failure mode. It also instances the broader principle behind ADR [0001](0001-stop-button-discards-partial.md)'s and [0004](0004-r1-path-semantics-guards.md)'s tool-discipline thinking and the verification-gated completion of ADR [0011](0011-verification-gated-turn-completion.md): **give the model a ledger of what it has done, not a wall that makes it quit.**

## Decision

Add two layers to the web-search path. They fix different problems and ship together.

### Layer 1 — Normalized cache key + cached digest (the cost layer)

Two changes inside `WebSearchManager`, both around the existing cache.

**1a. Normalize the cache key (conservatively).** Today the key is `query.toLowerCase().trim()` ([webSearchManager.ts:487](../../../src/providers/webSearchManager.ts#L487) / [:297](../../../src/providers/webSearchManager.ts#L297)). Add a small, deterministic `normalizeQueryKey()` step that collapses *trivial* rephrasings without merging genuinely distinct queries:

```ts
// Conservative on purpose: a wrong normalization must degrade to a cache
// MISS (re-fetch, harmless), never to a wrong-answer cache HIT.
function normalizeQueryKey(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // punctuation → space (drops "/", quotes)
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t)) // strip a tiny closed-class stopword set only
    .sort()                              // token-sort: order-independent
    .join(' ');
}
```

The key becomes `tool|${normalizeQueryKey(query)}|depth=…|maxResults=…`. `STOPWORDS` is a *tiny* closed list (`the a an of for in on to is are what how`, etc.) — enough to collapse `what is the worldcup2026 schedule` ≈ `worldcup2026 schedule`, but deliberately **not** a content-word stemmer (no merging `goalkeeper` with `goal`). Settings (`depth`, `maxResults`) stay in the key unchanged so a settings change still re-fetches.

**1b. Cache the digest alongside the results so a hit skips the subagent too.** The cache entry already stores the digested string; make the *hit path* short-circuit **before** `subagentRouter.route()` rather than only before `provider.search()`. Concretely, the cache-hit return at [webSearchManager.ts:490-499](../../../src/providers/webSearchManager.ts#L490) already returns the stored (post-digest) string and never reaches the provider or router — the bug is purely that near-duplicates *don't reach that branch* because of the exact-match key. Fixing 1a makes 1b automatic for the common case; we additionally record on the entry whether it was `routedDigest`, so a hit logs "served cached digest, skipped provider + subagent" and the trace ([webSearchManager.ts:494](../../../src/providers/webSearchManager.ts#L494) `toolSearch.cacheHit`) carries that the digest was reused. Net: a near-duplicate now costs **zero** provider fetches and **zero** subagent calls.

### Layer 2 — Per-turn search ledger injected into context (the behavior layer)

Maintain a small per-turn `SearchLedger` keyed by *normalized* query, recording for each search: the original query text, the result count, and a one-line outcome (e.g. `5 results` / `0 results` / `error: rate limit`). Inject a compact block into the model's context for the turn, e.g.:

```
SEARCHES THIS TURN (do not repeat — reuse these results):
  • "worldcup2026 schedule"        → 5 results
  • "rezarahiminia worldcup2026"   → 3 results
  • "kickoffapi free tier"         → 0 results (nothing found; try a different source)
```

This is the load-bearing layer. The cache (Layer 1) silently feeds the model a fast answer; the ledger makes the model *see* that it already asked and decline the redundant call. The `0 results` line is doubly useful: it tells the model a dead end is a dead end, so it stops re-querying a target that genuinely has nothing (the trace shows the model re-issuing zero-result queries hoping for a different outcome).

Mechanically the ledger lives next to the existing per-turn tracking that already resets at the top of each turn. The orchestrator calls `fileContextManager.clearTurnTracking()` at [requestOrchestrator.ts:735](../../../src/providers/requestOrchestrator.ts#L735); the search ledger resets at the same point (or is owned by `WebSearchManager` and cleared from there). The manager already receives the turn's prompt via `setRecentUserPrompt` ([webSearchManager.ts:68](../../../src/providers/webSearchManager.ts#L68)), so it has a natural turn boundary to hang the ledger off. The ledger block is appended to the system context the same way web-search results are today ([requestOrchestrator.ts:1425-1430](../../../src/providers/requestOrchestrator.ts#L1425)).

**Generalize the ledger idea to `read_file`.** The same "you already did this" signal applies to file reads. `FileContextManager` already tracks `readFilesInTurn` ([fileContextManager.ts:183](../../../src/providers/fileContextManager.ts#L183), cleared at [:168](../../../src/providers/fileContextManager.ts#L168)). Extend the per-turn read record with a content hash so a re-read of an **unchanged** file can be answered from context — "`src/foo.ts` is unchanged since you last read it this turn" — rather than re-streaming the file. This is the same pattern (ledger over limit) applied to a different tool, and is sketched as a follow-up rather than fully specified here.

### Why a ledger and not a limit

We deliberately do **not** hard-block or hard-cap duplicate tool calls. A blocked call returns as an error/refusal, and the model reads a refusal as a *dead end* — the observed tendency is for it to **stop the turn** rather than route around the block. The user's explicit constraint is that the model should keep working the problem, not quit when it hits a wall. A ledger nudges; a wall halts. So the ledger informs ("you already searched X, here's what you got") and the model retains agency to do something *different* with that information.

## Alternatives considered

### A. Normalized cache only (Layer 1 alone)

Just fix the key and cache the digest; skip the ledger.

Rejected as insufficient. It cures the *cost* — far fewer provider and subagent calls — but the model still **issues** all 71 near-duplicates, reads 71 tool results, and burns its iteration budget orbiting one target. The 914pm pathology is the *re-issuing*, not the per-call price. Cache alone makes a bad loop cheap; it does not break the loop.

### B. Ledger only (Layer 2 alone)

Inject the search history; leave the exact-match cache as is.

Rejected as leaving cost on the table. The ledger stops most re-issuing, but the model will still legitimately re-search occasionally (and 0007 increases legitimate searching), and every genuine near-duplicate that *does* slip through pays the full provider + subagent cost because the exact-match key still misses. The two layers are cheap and orthogonal; shipping one without the other leaves a known regression in place.

### C. Embedding / semantic dedup

Embed each query and treat cosine-near queries as cache hits / ledger collisions.

Deferred. It is the most *accurate* dedup, but it adds an embedding model dependency, latency on the hot path, and a similarity threshold to tune (with its own false-merge failure mode). The conservative token-normalization in Layer 1 captures the dominant case (trivial rephrasings of the same target) at near-zero cost. Revisit as a follow-up if normalization proves too blunt or too narrow in practice.

### D. Hard-block / hard-cap duplicate tool calls

Refuse a `web_search` whose normalized key was already issued this turn, or cap total searches per turn.

Rejected, and this is the central design choice. A blocked call reads to the model as a terminal failure, and the observed behavior is that it **stops** rather than adapts — which is exactly the outcome the user does not want (no tool-count limits that make it quit). The ledger achieves the same dedup *intent* (the model declines the redundant call) while keeping the model in motion, because it is given information, not an error. This is the "tool-call ledger over tool limits" principle, shared with the verification gate of ADR [0011](0011-verification-gated-turn-completion.md) and consistent with ADR [0004](0004-r1-path-semantics-guards.md)'s preference for tool-surface improvements over model-policing.

## Consequences

**Positive:**
- Drastic drop in redundant provider fetches **and** subagent digest calls — the 914pm turn's ~140 flash calls collapse toward the count of genuinely-distinct searches.
- The model stops re-searching the same target: it sees its own history and declines the redundant call itself, retaining agency to try something different (including a *different* source for a zero-result target).
- Complements ADR [0007](0007-system-prompt-temporal-grounding.md): 0007 makes the model search *more* (correctly); this keeps that extra searching from degenerating into a near-duplicate storm.
- Reuses existing machinery: the same `cache` Map and TTL, the same per-turn reset boundary (`clearTurnTracking` / `setRecentUserPrompt`), the same context-injection path that already carries web-search results.
- The `read_file` generalization gives a second, free instance of the ledger pattern with no new mechanism.

**Negative / accepted costs:**
- Normalization is heuristic. A token-sort + stopword strip can over-collapse in adversarial cases (two distinct queries that share a token bag). This is bounded by keeping the stopword set tiny and never stemming content words, and by the failure direction: a wrong normalization yields a cache **miss** (re-fetch, harmless) — never a wrong-answer hit — because the *results* are always for the query actually sent. The risk is a redundant fetch, not a wrong answer.
- The ledger costs a little context per turn (a few lines per distinct search). Bounded by distinct-query count and trimmed/elided when long; trivially smaller than the duplicate tool results it prevents.
- The cache (and ledger) are per-session and per-turn respectively, so cross-session and cross-turn repeats still re-search. Accepted: the 914pm pathology is *intra-turn* flailing, which is what the ledger scopes to; the cache's existing 15-min TTL already covers short-horizon cross-turn repeats.
- Does not reduce the model's *propensity* to want to re-search; it removes the blindness that lets the propensity run unchecked.

**Follow-ups:**
- Implement the `read_file` "unchanged since last read" ledger (content-hash the per-turn read record in `FileContextManager`).
- Consider promoting the ledger to a cross-turn (session-scoped) summary for very long sessions, with aging.
- Revisit embedding-based semantic dedup (Alternative C) if token-normalization mis-clusters in real traces.
- Instrument: log per-turn distinct-vs-total search counts and cache/ledger hit rates to quantify the reduction and tune the stopword set + normalization aggressiveness.

## Test plan

Framework is **vitest** (see the existing `tests/unit/providers/webSearchManager.test.ts` and `tests/unit/subagents/router.test.ts`, which use the hoisted `WorkingEventEmitter` vscode mock and a mock provider registry).

**Unit — `tests/unit/providers/webSearchManager.test.ts` (extend the existing suite).**
- *Normalized-key collision (true positives):* `searchByQuery('worldcup2026 schedule')` then `searchByQuery('what is the worldcup2026 schedule')` (and a `salah worldcup2026` / `salah/worldcup2026` punctuation pair) call `mockTavily.search` **once** — the second is a normalized hit. Mirrors the existing case-insensitivity test at line ~663.
- *False-collision guard (true negatives):* two *genuinely distinct* queries that happen to share a token bag (e.g. `dog bites man` vs `man bites dog`) must **not** collide — assert `search` called **twice**. This guards token-sort over-collapse; it is the most important negative test.
- *Digest reuse on hit:* with a mock `subagentRouter` (as in the existing "subagent routing — auto mode" block), assert a normalized near-duplicate hit returns the cached digest and calls **neither** `provider.search` **nor** `router.route` a second time (`router.route` called exactly once across the duplicate pair).
- *Settings still partition the key:* re-assert the existing "settings-aware cache key" behavior survives normalization (changing `maxResultsPerSearch` re-fetches even for an identical normalized query).
- *TTL expiry unchanged:* re-assert the `cacheDuration: 0` re-fetch case holds with normalized keys.
- *clearCache empties results + digest:* extend the existing `clearCache` / `resetToDefaults` tests to confirm a post-clear near-duplicate re-fetches (no stale digest survives).

**Unit — `tests/unit/subagents/router.test.ts`.** Add a guard asserting that a cache-served near-duplicate does **not** reach `router.route` (router-call-count stays flat across a duplicate pair driven through the manager).

**Unit — search ledger.** Add `tests/actors/web-search/searchLedger.test.ts` (or a focused `tests/unit/providers/searchLedger.test.ts` if the ledger lands as a manager-owned helper): after several `searchByQuery` calls, the rendered ledger block lists each distinct prior query with its result count and a one-line outcome, lists a `0 results` query as a dead end, and is **empty after a turn reset** (the `clearTurnTracking` / `setRecentUserPrompt` boundary).

**Integration — `tests/integration/`.** Add a turn-level test (sibling to the existing `midstream-interrupt.test.ts`) driving the orchestrator with a model script that re-issues a near-duplicate `web_search`: assert the provider is hit once, the ledger block appears in the context handed to the second model call, and the digest subagent runs once. This is the end-to-end analogue of the 914pm trace.

Split: unit tests own normalization correctness, false-collision guarding, digest reuse, and ledger rendering; the single integration test owns the cross-component wiring (orchestrator → manager → cache/ledger → context injection).

## Documentation plan

- **Create `docs/guides/web-search.md`.** No web-search guide exists today (`docs/guides/` has shell-execution, logging-and-tracing, etc., but nothing for search). Document the full pipeline (tool → orchestrator → manager → provider → digest subagent), the cache (key normalization, TTL, per-session clearing), the per-turn search ledger, the `read_file` ledger generalization, and the relevant settings (`moby.webSearch.*`, `cacheDuration`, `moby.subagents.webSearchDigest.maxResults`). Cross-link ADR 0010 and ADR 0007.
- **Extend `docs/plans/subagents.md`.** That plan already documents the `web-search-digest` subagent and its two insertion points; add a note that near-duplicate cache hits now short-circuit *before* the subagent route (the digest-reuse change), so the per-search subagent cost is no longer paid on duplicates.
- **`CHANGELOG.md`:** add an `[Unreleased]` entry under a "Web search — query ledger + near-duplicate cache (ADR 0010)" heading describing the normalized key, cached-digest reuse, the per-turn ledger, and the ledger-over-limit rationale, citing the 914pm trace numbers.
- **`docs/architecture/decisions/README.md`:** add an Index row for `0010` (the orchestrator performs the actual edit).
