# 0007. System-prompt temporal grounding: standing date + staleness directive

**Status:** Accepted — implemented as specified (hoisted date + always-present temporal block; subagent exemption locked by test).
**Date:** 2026-06-20

## Context

The main agent's system prompt is assembled in `buildSystemPrompt` ([requestOrchestrator.ts:1349](../../../src/providers/requestOrchestrator.ts#L1349)) from roughly six sections in order: identity + conversational gate ([:1359](../../../src/providers/requestOrchestrator.ts#L1359)), model-specific tool guidance ([:1372](../../../src/providers/requestOrchestrator.ts#L1372)), the edit format block ([:1391](../../../src/providers/requestOrchestrator.ts#L1391)), dynamic context — editor context, modified-files context, and pre-fetched web-search results ([:1408](../../../src/providers/requestOrchestrator.ts#L1408)), active plans ([:1433](../../../src/providers/requestOrchestrator.ts#L1433)), and user custom instructions appended last for recency ([:1441](../../../src/providers/requestOrchestrator.ts#L1441)).

Today's date enters the prompt in exactly one place: the web-search results header. Inside the `if (webSearchContext)` branch, `new Date().toLocaleDateString('en-US', { … })` produces `today` ([:1427](../../../src/providers/requestOrchestrator.ts#L1427)) and is interpolated only into the `--- WEB SEARCH RESULTS (${today}) ---` line ([:1430](../../../src/providers/requestOrchestrator.ts#L1430)). The date is therefore **conditional on web search having run for this turn**. On a normal turn — no manual-mode pre-fetch, or web search disabled/unconfigured — the assembled prompt contains **no date and no temporal directive at all**. The identity block ([:3962](../../../src/providers/requestOrchestrator.ts#L3962)) is purely about response shape ("show me" vs. "change my code") and carries no notion of *when* "now" is.

There is soft temporal guidance elsewhere, but none of it is a standing instruction the model reads as a system-level imperative:

- The `web_search` tool **description** says "Use this when you need up-to-date information, recent documentation, news, or anything not in your training data" ([workspaceTools.ts:150](../../../src/tools/workspaceTools.ts#L150)).
- The reasoner shell prompt repeats the same line for the `<web_search>` tag path ([reasonerShellExecutor.ts:695](../../../src/tools/reasonerShellExecutor.ts#L695)).

Both describe *what the tool is for*; neither tells the model that **its own knowledge has a cutoff and may be stale**, nor that it should search **first** for time-sensitive facts rather than answering from memory. Tool descriptions are read as capability blurbs at call-selection time, not as a standing behavioral rule — a model confident in a wrong-but-fluent answer never reaches for the tool, so the description never fires.

This is the failure the traced **9:14pm session** exhibited. Asked about the 2026 World Cup (live and in progress at the time), the model answered from training memory and was **confidently wrong, not uncertain** — it never triggered a `web_search`, because nothing told it its memory might predate the event. Two tells in the trace show the model itself groping for temporal grounding it was never given: it ran a `date` shell command **twice** on its own initiative, and the plan file it authored asserted "the 2026 World Cup hasn't happened yet." That false premise then propagated: once written into an active plan, it was re-injected every subsequent turn via `getActivePlansContext` ([planManager.ts:152](../../../src/providers/planManager.ts#L152)), poisoning the rest of the run. The model wanted a clock and a staleness warning; the system prompt gave it neither.

The gap is structural: a *standing* directive — true on every turn, search or not — has no home in the current builder. The date is a side effect of one optional section.

## Decision

Add an **always-present "Temporal context" block** to `buildSystemPrompt`, inserted immediately after the web-search context section and before the active-plans section (between [:1431](../../../src/providers/requestOrchestrator.ts#L1431) and [:1433](../../../src/providers/requestOrchestrator.ts#L1433)). Two coupled changes:

1. **Hoist the date so it is unconditional.** Lift `new Date().toLocaleDateString('en-US', …)` out of the `if (webSearchContext)` branch so `today` is computed once per prompt build regardless of whether web search ran. The web-search header reuses the same hoisted value, so the date is computed in exactly one place and is consistent across both sections.

2. **Append a short staleness directive** stating: today's date; that the model's training data has a cutoff and may be stale; and that for time-sensitive facts it must not answer from memory — `web_search` first and prefer fresh results over prior knowledge.

```ts
// ── 4.5 Temporal context (always present) ──
// `today` is hoisted above the web-search branch so it exists on every turn.
systemPrompt += `
--- TEMPORAL CONTEXT ---
Today's date is ${today}.
Your training data has a cutoff and may be out of date. For time-sensitive
facts — current events, live scores/standings, prices, the latest version of
a library or tool, who currently holds an office or title — do NOT answer from
memory. Call web_search first and prefer fresh results over your prior
knowledge. If web_search is unavailable this turn, say what you'd verify rather
than assert a possibly-stale fact as current.
--- END TEMPORAL CONTEXT ---
`;
```

The wording is deliberately **categorical about staleness without naming a cutoff date** (see Alternative D): "may be out of date" is true for every model in the registry regardless of its actual training cutoff; an explicit cutoff string would be brittle and per-model. The block enumerates a few concrete time-sensitive categories so the directive reads as a rule with handles, not a vague platitude — the same "give the imperative something to bite on" approach as the load-bearing tool guidance already in the prompt.

**Subagent prompts are exempt.** Subagent system prompts are built separately, per-role, via `SubagentRole.buildSystemPrompt(taskContext)` — e.g. the web-search-digest role at [webSearchDigest.ts:52](../../../src/subagents/roles/webSearchDigest.ts#L52), routed through [router.ts:56](../../../src/subagents/router.ts#L56). They never pass through `buildSystemPrompt`, so they do not inherit the block, which is correct: a digester ranking already-fetched results has no use for a "search first" imperative and should not be told to spawn more searches. No change is needed to exempt them — the insertion point structurally excludes them — but the test plan locks this in.

The directive is **advisory, not enforced**: it raises the model's propensity to search for time-sensitive facts; it does not gate turn completion on having done so. Mandatory verification of specific claims is a separate concern, owned by ADR [0011](0011-verification-gated-turn-completion.md). The recency of the *active-plan* content that re-injected the poisoned premise in the traced run is addressed by ADR [0009](0009-active-plan-recency-pinning.md); this ADR only ensures the model has a clock and a staleness warning in the first place.

## Alternatives considered

### A. Keep the date only in the web-search header (status quo)

Leave `today` scoped to the `if (webSearchContext)` branch ([:1427](../../../src/providers/requestOrchestrator.ts#L1427)) and add nothing.

Rejected — this is exactly what produced the 9:14pm failure. On a non-search turn the prompt has no date and no staleness cue, so a model confident in a stale fact never searches and the header never renders. The date being a side effect of an optional section is the root structural defect; a standing directive cannot live inside a conditional.

### B. Rely on the tool description only

Lean on the existing `web_search` description ([workspaceTools.ts:150](../../../src/tools/workspaceTools.ts#L150)) and the reasoner equivalent ([reasonerShellExecutor.ts:695](../../../src/tools/reasonerShellExecutor.ts#L695)).

Rejected — that guidance already exists and was insufficient in the trace. Tool descriptions are consulted when the model is *choosing among tools*, not read as a standing rule that fires *before* the model decides whether it even needs a tool. A model answering fluently from (stale) memory never enters the tool-selection path, so the description is dead text for the exact failure mode we care about. The staleness warning has to sit at the system-prompt level, where it conditions the decision to search.

### C. Inject the directive into the last user message instead of the system prompt

Prepend the date/staleness text to the user's turn message for maximum recency.

Rejected — a standing behavioral directive belongs in the system prompt, where it persists across turns and reads as policy rather than as part of the user's request. Splicing it into the user message muddies attribution (the model may treat it as something the user said), and it would have to be re-injected and de-duplicated every turn. Recency *is* a real lever, but the recency that mattered in the trace was the **plan** content, and that is ADR [0009](0009-active-plan-recency-pinning.md)'s job, not this one's.

### D. Hard-code an explicit model training-cutoff date

Emit a concrete cutoff, e.g. "your training data ends in October 2025," alongside today's date.

Rejected as brittle and model-dependent. Moby runs an open model registry (DeepSeek V3/V4, R1 reasoner, and custom/local models like the local `qwen-coder-14b-16k`), each with a different and often unpublished cutoff; a single hard-coded string would be wrong for most of them and would silently rot. The directive only needs the model to treat its knowledge as *possibly* stale relative to *today* — "may be out of date" delivers that for every model without asserting a specific, falsifiable date. If a per-model cutoff is ever wanted, it belongs in the capability registry (`getCapabilities`) as structured data, not as a literal in the prompt builder.

## Consequences

**Positive:**
- Time-sensitive tasks work: the model now has today's date on **every** turn and an explicit instruction to treat its memory as possibly stale, so it searches proactively for current events / scores / versions / prices instead of asserting a confident wrong answer. The 9:14pm failure mode (and its plan-poisoning cascade) is addressed at the source.
- The model stops needing to self-bootstrap a clock by running `date` in the shell — the grounding it was visibly reaching for is now provided.
- One source of truth for the date: hoisting `today` means the web-search header and the temporal block share the same computed value; no drift, no duplicate `new Date()` calls.
- Tiny, fixed per-turn token cost (a handful of lines), paid once per prompt build.
- Cleanly separable from related work: verification enforcement is ADR [0011](0011-verification-gated-turn-completion.md), plan recency is ADR [0009](0009-active-plan-recency-pinning.md); this ADR is just "give the model a clock and a staleness warning."

**Negative / accepted costs:**
- **Risk of over-searching.** A blanket "search first for time-sensitive facts" can push a chatty model to fire redundant or near-duplicate `web_search` calls. This is explicitly mitigated by ADR [0010](0010-web-search-query-ledger-and-cache.md)'s per-turn query ledger and near-duplicate cache, which dedupe and bound search volume — the two ADRs are designed to ship together (this one raises search propensity; 0010 caps the cost).
- The directive is **advisory, not enforced** — a model can still ignore it and answer from memory. Making "did you verify this time-sensitive claim?" a hard gate is out of scope here and owned by ADR [0011](0011-verification-gated-turn-completion.md).
- A few extra tokens on every turn, including turns where temporal grounding is irrelevant (pure refactors). Judged negligible against the failure it prevents, and far cheaper than the wasted turns a poisoned plan caused.

**Follow-ups:**
- Coordinate rollout with ADR [0010](0010-web-search-query-ledger-and-cache.md) so the search-propensity increase lands together with the dedupe/cache that bounds it.
- If a per-model cutoff is ever desired, add it as structured data to the capability registry (`getCapabilities` in [requestOrchestrator.ts:1356](../../../src/providers/requestOrchestrator.ts#L1356)) rather than as a prompt literal (per Alternative D).
- Revisit whether the temporal block should also note the workspace timezone if locale-sensitive tasks surface a need.

## Test plan

**Framework:** vitest, matching the existing system-prompt suite. `buildSystemPrompt` is exercised today via `handleMessage` by reading the system-prompt argument passed to `streamChat` (`mockClient.streamChat.mock.calls[0][2]`) in the `describe('handleMessage - system prompt', …)` block at [tests/unit/providers/requestOrchestrator.test.ts:577](../../../tests/unit/providers/requestOrchestrator.test.ts#L577). Note that `tests/actors/system-prompt/` holds only the *webview* `SystemPromptModalActor` test, not prompt-builder coverage — the orchestrator suite is the right home.

**Unit — extend `tests/unit/providers/requestOrchestrator.test.ts`** (in the existing system-prompt describe block, alongside the "include web search results" and "include edit mode" cases):

- *Temporal block present on a normal (no web search) turn.* With `mockWebSearch.searchForMessage` resolving empty/undefined (the default), assert the system prompt:
  - contains the `TEMPORAL CONTEXT` marker;
  - contains today's date string;
  - contains the staleness-directive keywords (`web_search`, "out of date"/"stale", "time-sensitive"). This is the direct regression for the status-quo gap (Alternative A).
- *Deterministic date via a mocked clock.* Use `vi.useFakeTimers()` + `vi.setSystemTime(new Date('2026-06-20'))` (restore in `afterEach`) and assert the prompt contains the exact `toLocaleDateString('en-US', …)` rendering of that date — pins the hoist and guards against locale/format drift.
- *Ordering: temporal block precedes active plans.* With a stubbed `planManager.getActivePlansContext` returning a recognizable `ACTIVE PLANS` sentinel, assert `indexOf('TEMPORAL CONTEXT') < indexOf('ACTIVE PLANS')` — locks the insertion point ([:1431](../../../src/providers/requestOrchestrator.ts#L1431) before [:1433](../../../src/providers/requestOrchestrator.ts#L1433)).
- *Single date source.* On a web-search turn (`searchForMessage` resolves content), assert both `WEB SEARCH RESULTS (<date>)` and the temporal block render the **same** date string — guards the hoist against reintroducing a second `new Date()`.
- *Reasoner path.* With `isReasonerModel` true, assert the temporal block is still present (the directive is model-agnostic and applies to the R1/native-shell path too).

**Unit — subagent exemption, `tests/unit/subagents/roles/webSearchDigest.test.ts`** (extend the existing `describe('buildSystemPrompt', …)` at line 65): assert the digest role's prompt does **not** contain `TEMPORAL CONTEXT` nor a "search first" directive — proves subagent prompts stay clean. Optionally add a parallel assertion in `tests/unit/subagents/router.test.ts` that routed subagent prompts carry no temporal block.

**Integration (optional, lighter touch):** the existing `tests/integration/midstream-interrupt.test.ts` and its `tests/integration/helpers.ts` show the integration harness shape. A new `tests/integration/temporal-grounding.test.ts` could assert that a turn whose user message asks a time-sensitive question yields a `web_search` tool call given the directive — but this is propensity, not a hard guarantee, so keep it as a smoke check and keep the load-bearing assertions in the unit layer above.

## Documentation plan

- **New guide: `docs/guides/system-prompt.md`.** No guide currently documents how `buildSystemPrompt` is assembled (the `docs/guides/` set covers shell-execution, custom-models, history, logging, etc., but not the system prompt). Create a short guide enumerating the prompt sections in order, where each comes from, and the new always-present temporal block — including the subagent-exemption rationale and the cross-links to ADRs [0009](0009-active-plan-recency-pinning.md), [0010](0010-web-search-query-ledger-and-cache.md), and [0011](0011-verification-gated-turn-completion.md). If a separate guide is judged too heavy, fold a "Temporal context" subsection into `docs/guides/shell-execution.md` (which already touches the reasoner web-search guidance), but a dedicated `system-prompt.md` is preferred given the section is otherwise undocumented.
- **`CHANGELOG.md`:** add an entry under `## [Unreleased]` describing the always-present date + staleness directive, citing ADR 0007 and `src/providers/requestOrchestrator.ts`, and noting the pairing with ADR 0010 for over-search mitigation — matching the format of the 0.5.0 ADR-0006 entry.
- **`docs/architecture/decisions/README.md`:** add an Index row — `| [0007](0007-system-prompt-temporal-grounding.md) | System-prompt temporal grounding: standing date + staleness directive | Proposed | 2026-06-20 |` (the orchestrator will perform the actual README edit).
