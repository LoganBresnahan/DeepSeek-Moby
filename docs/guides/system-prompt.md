# System Prompt Assembly

How Moby's **main-agent** system prompt is built each turn, section by section, and why the order matters.

## Overview

The main agent's system prompt is assembled fresh on every turn by `buildSystemPrompt` in [requestOrchestrator.ts](../../src/providers/requestOrchestrator.ts). It is **not** a static string — most sections are dynamic (editor state, modified files, web-search results, active plans, user instructions), so the prompt the model sees reflects the live workspace at the moment the turn starts.

Two layout principles drive the ordering:

- **Primacy** — identity and standing rules go near the top, where the model weights them as policy.
- **Recency** — the things that should most strongly steer *this* turn go last, closest to the user message, to counter the "lost in the middle" effect.

## Section order

`buildSystemPrompt` appends sections in this order:

| # | Section | Source | Always present? |
|---|---------|--------|-----------------|
| 1 | **Identity + conversational gate** | inline (`buildIdentityPrompt`) | yes |
| 2 | **Model-specific tool guidance** | inline, keyed on model capabilities | yes |
| 3 | **Code edit format** | inline (`editModeDescriptions[editMode]`) | yes |
| 4 | **Dynamic context** — editor context, modified-files context, pre-fetched web-search results | `editorContextProvider()`, `diffManager.getModifiedFilesContext()`, `webSearchManager.searchForMessage()` | conditional |
| 4.5 | **Temporal context** — standing date + staleness directive | inline (see below) | **yes** |
| 5 | **Active plans** | `planManager.getActivePlansContext()` | conditional |
| 6 | **User custom instructions** | `savedPromptManager.getActiveContent()` | conditional |

Section 6 is appended **last on purpose** — user instructions take priority over defaults, and recency is the lever that enforces that.

## Temporal context (section 4.5)

> Decision record: [ADR 0007 — System-prompt temporal grounding](../architecture/decisions/0007-system-prompt-temporal-grounding.md).

A short, **always-present** block giving the model (a) today's date and (b) an explicit staleness directive:

```
--- TEMPORAL CONTEXT ---
Today's date is <Weekday, Month D, YYYY>.
Your training data has a cutoff and may be out of date. For time-sensitive
facts — current events, live scores/standings, prices, the latest version of
a library or tool, who currently holds an office or title — do NOT answer from
memory. Call web_search first and prefer fresh results over your prior
knowledge. If web_search is unavailable this turn, say what you'd verify rather
than assert a possibly-stale fact as current.
--- END TEMPORAL CONTEXT ---
```

### Why it exists

Before ADR 0007, today's date entered the prompt in exactly **one** place — the `--- WEB SEARCH RESULTS (<date>) ---` header — and only when a manual-mode web search had pre-fetched results that turn. On a normal turn the prompt had **no date and no staleness cue at all**. A model confident in a stale-but-fluent fact (e.g. "the 2026 World Cup hasn't happened yet") would answer from memory and never reach for `web_search`, because nothing told it its knowledge might predate the event.

The fix is structural: the date is now **hoisted** so it is computed once per prompt build regardless of whether web search ran, and the standing directive sits at the system-prompt level — where it conditions the model's decision to search *before* it picks a tool, rather than living inside a tool description that is only read at tool-selection time.

### Design notes

- **Model-agnostic staleness.** The wording says "may be out of date" rather than naming a concrete training cutoff. Moby runs an open model registry (DeepSeek V3/V4, R1, and custom/local models like `qwen-coder-14b-16k`), each with a different and often unpublished cutoff; a hard-coded date would be wrong for most of them. If a per-model cutoff is ever wanted, it belongs as structured data in the capability registry, not as a prompt literal.
- **Single date source.** The hoisted `today` value feeds both the temporal block and the web-search header, so the two never drift and there is only one `new Date()` call per build.
- **Graceful degradation.** On a manual-mode web-search turn the tool is *not* in the schema ("do not call web_search, it is unavailable this turn"). The block's final clause — "If web_search is unavailable this turn, say what you'd verify…" — covers exactly that case, so the directive stays self-consistent even when search can't run.
- **Advisory, not enforced.** The block raises the model's propensity to search for time-sensitive facts; it does not gate turn completion on having done so. Hard verification of specific claims is a separate concern — see [ADR 0011](../architecture/decisions/0011-verification-gated-turn-completion.md).

## Subagents are exempt

Subagent system prompts are built **separately**, per-role, via `SubagentRole.buildSystemPrompt(taskContext)` — e.g. the web-search-digest role in [webSearchDigest.ts](../../src/subagents/roles/webSearchDigest.ts), routed through [router.ts](../../src/subagents/router.ts). They never pass through the main agent's `buildSystemPrompt`, so they **do not** inherit the temporal block — which is correct: a digester ranking already-fetched results has no use for a "search first" imperative and must not be nudged to spawn more searches. The exemption is structural (the insertion point excludes them) and is locked in by a unit test.

## Related decisions

- [ADR 0007](../architecture/decisions/0007-system-prompt-temporal-grounding.md) — this section (date + staleness directive).
- [ADR 0009](../architecture/decisions/0009-active-plan-recency-pinning.md) — active-plan **recency** pinning. The plan is already injected in section 5 (primacy); 0009 adds a terse "current step N of M" reminder at recency so the model doesn't lose the thread mid-turn.
- [ADR 0010](../architecture/decisions/0010-web-search-query-ledger-and-cache.md) — a per-turn search ledger + near-duplicate cache that **bounds** the extra searches this directive encourages. ADR 0007 raises search propensity; 0010 caps the cost. They are designed to ship together.
- [ADR 0011](../architecture/decisions/0011-verification-gated-turn-completion.md) — turning "did you verify this?" from advice into a gate on turn completion.

## Tests

`buildSystemPrompt` is exercised through `handleMessage` by reading the system-prompt argument passed to `streamChat` (`mockClient.streamChat.mock.calls[0][2]`). Coverage for the temporal block lives in the `describe('temporal grounding (ADR 0007)', …)` block of [tests/unit/providers/requestOrchestrator.test.ts](../../tests/unit/providers/requestOrchestrator.test.ts): presence on a no-search turn, a deterministic date under a mocked clock, ordering before active plans, a single shared date source on a web-search turn, and presence on the reasoner path. The subagent exemption is pinned in [tests/unit/subagents/roles/webSearchDigest.test.ts](../../tests/unit/subagents/roles/webSearchDigest.test.ts).
