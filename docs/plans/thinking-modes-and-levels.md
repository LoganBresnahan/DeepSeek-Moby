# Thinking Modes and Declarative Levels — Design

**Status: all 7 phases shipped 2026-08-12. Dev-host verification ([M47](manual-test-backlog.md), [M48](manual-test-backlog.md)) is what remains.** Decisions recorded in [ADR 0017](../architecture/decisions/0017-declared-provider-differences.md). Supersedes the "two registry entries per upstream model" comment at [registry.ts:203-209](../../src/models/registry.ts#L203) — that plan is deliberately abandoned here, see [Why not separate model entries](#why-not-separate-model-entries).

## Goal

Two user-visible gaps, one root cause.

1. **Non-thinking sessions are unreachable.** DeepSeek V4 Flash and Pro are dual-mode models, but Moby exposes only High/Max. The API's `thinking: {type:'disabled'}` path is already implemented in the client and is only ever reached by the subagent router.
2. **Reasoning level is meaningless on custom models.** `reasoningEffort` validates on a custom entry and is never written to the wire. Worse, it renders a working-looking pill.

Root cause: **thinking is modeled as a closed union of DeepSeek's values, fused to DeepSeek's wire format.** The fix is to let each model *declare* its levels the way `disableThinkingParam` already lets it declare its off-knob.

## Ground truth (verified 2026-08-12, at `1c2c69d`)

- **The disabled path exists and works.** [`applyThinkingMode`](../../src/deepseekClient.ts#L376) sends `thinking: {type:'disabled'}` and omits `reasoning_effort`. Its only caller is [router.ts:144](../../src/subagents/router.ts#L144). No user-facing path exists.
- **The read seam is per-request, not cached.** The pill writes `moby.modelOptions.<id>.reasoningEffort`; [deepseekClient.ts:380](../../src/deepseekClient.ts#L380) reads it fresh on every request. Confirmed by the comment at [chatProvider.ts:630-636](../../src/providers/chatProvider.ts#L630). A level change lands on the next turn with nothing to invalidate.
- **Mode is resolved too late.** `applyThinkingMode` runs *after* message serialization and *after* the temperature gate in **both** paths ([:448](../../src/deepseekClient.ts#L448) chat, [:592](../../src/deepseekClient.ts#L592) stream). The two sites that need to know the mode cannot.
- **`reasoningEffort` is dead on custom models.** `applyThinkingMode` returns early when `!caps.sendThinkingParam` ([:354-369](../../src/deepseekClient.ts#L354)), and `sendThinkingParam` is not in the `customModels` schema.
- **The dead pill is real, not hypothetical.** [registry.ts:353](../../src/models/registry.ts#L353) copies `reasoningEffort` → `reasoningEffortDefault` for custom entries, and [ModelSelectorShadowActor.ts:189](../../media/actors/model-selector/ModelSelectorShadowActor.ts#L189) renders the control on that field's presence. Latent only because no shipped template declares it.
- **`sendThinkingParam` bundles four unrelated behaviors**: inject the `thinking` wrapper, inject `reasoning_effort`, strip the `-thinking` id suffix, and delete four sampling params. Kimi K3 needs the second without the first, which is what breaks the abstraction.
- **`customModels` is `additionalProperties: false`** and its property list omits `reasoningEcho`, `sendThinkingParam`, `contextWindow`, `maxOutputTokensCap`, `lspTools`, and `promptStyle` — all accepted at runtime, all editor errors to declare. Same trap `streamingToolCalls` hit (fixed 2026-08-03).

## What the two APIs actually do

| | DeepSeek V4 Flash / Pro | Kimi K3 |
| --- | --- | --- |
| Enable/disable | `thinking: {type: "enabled" \| "disabled"}` | **Cannot be disabled** — "K3 always thinks" |
| Level param | `reasoning_effort`, alongside the wrapper | `reasoning_effort`, **top-level, no wrapper** (K2.x used `thinking`) |
| Values | `low`, `high`, `max` (default `high`) | `low`, `high`, `max` (default `max`) |
| Temperature | rejected **in thinking mode** | fixed 1.0, omit from requests |
| `reasoning_content` echo | required in thinking mode w/ tool calls | required — return the assistant message unchanged |

Sources: [Thinking Mode | DeepSeek API Docs](https://api-docs.deepseek.com/guides/thinking_mode/), [Kimi K3 Quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart).

**K3 is the case that settles the design.** It needs graded effort with no thinking wrapper and no off state. Any scheme that treats "thinking" as one boolean plus a DeepSeek-shaped enum cannot express it.

⚠️ **Two facts to confirm before shipping, not assumed away:**
- DeepSeek's `low` is documented for the Anthropic-format and Responses-API surfaces; **unconfirmed on the OpenAI-format `reasoning_effort` field** we use. One request settles it — a wrong value 400s at request time, so it fails loudly rather than silently.
- The K3 numbers below come from vendor docs, not from a turn we ran. Verify before the template ships.

## Design

### Capabilities: declare levels, don't enumerate them

```ts
interface ModelCapabilities {
  /** Ordered map of selectable thinking levels. Keys are the pill labels;
   *  values are request-body params merged when that level is selected.
   *  Absent = the model has no level control. */
  thinkingLevels?: Record<string, Record<string, unknown>>;
  /** Which key applies when the user has not chosen. */
  defaultThinkingLevel?: string;
  /** Params that turn thinking OFF. Absent = cannot be turned off.
   *  Already exists — this design generalizes around it. */
  disableThinkingParam?: Record<string, unknown>;
  /** Thinking mode rejects temperature/top_p/presence_penalty/frequency_penalty.
   *  Replaces that half of `sendThinkingParam`. */
  noSamplingParamsWhenThinking?: boolean;
  /** Wire model id when it differs from the registry key. Replaces the
   *  implicit `-thinking` suffix strip. */
  wireModelId?: string;
}
```

DeepSeek V4 Pro:

```ts
thinkingLevels: {
  low:  { thinking: { type: 'enabled' }, reasoning_effort: 'low'  },
  high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
  max:  { thinking: { type: 'enabled' }, reasoning_effort: 'max'  },
},
defaultThinkingLevel: 'max',
disableThinkingParam: { thinking: { type: 'disabled' } },
noSamplingParamsWhenThinking: true,
wireModelId: 'deepseek-v4-pro',
```

Kimi K3 — the same vocabulary, a different shape, no code change:

```ts
thinkingLevels: {
  low:  { reasoning_effort: 'low'  },
  high: { reasoning_effort: 'high' },
  max:  { reasoning_effort: 'max'  },
},
defaultThinkingLevel: 'max',
// no disableThinkingParam → no Off pill, because K3 has no off state
```

`sendThinkingParam` disappears entirely; its four jobs become `thinkingLevels`, `disableThinkingParam`, `wireModelId`, and `noSamplingParamsWhenThinking`.

### Resolution, hoisted early

One pure helper, called before serialization in both paths:

```ts
resolveThinking(modelId, override?): { on: boolean; level: string | null; params: Record<string, unknown> }
```

Precedence: the subagent router's forced `'disabled'` wins over the user pill (roles must stay cheap); then the user's `thinking`/`thinkingLevel` settings; then `defaultThinkingLevel`. A model with no `disableThinkingParam` can never resolve to `off` — the router's request is honored by selecting the cheapest declared level instead, which is the closest available answer and beats sending an invented param.

Three call sites become mode-aware. **All three are the same bug** — capabilities read as static while the mode became dynamic:

| Site | Today | After |
| --- | --- | --- |
| [`serializeMessagesForRequest:330`](../../src/deepseekClient.ts#L330) | `caps.reasoningEcho === 'required'` | `… && thinking.on` |
| [temperature gate :432 / :571](../../src/deepseekClient.ts#L432) | `caps.supportsTemperature` | `… && !(thinking.on && caps.noSamplingParamsWhenThinking)` |
| [`applyThinkingMode:392-395`](../../src/deepseekClient.ts#L392) | unconditional `delete temperature/top_p/…` | gated on `thinking.on && caps.noSamplingParamsWhenThinking` |

The third row is a trap worth naming: those unconditional deletes would strip the temperature the second row just correctly added, so fixing the gate alone looks right and does nothing.

### Settings

```jsonc
"moby.modelOptions": {
  "deepseek-v4-pro-thinking": { "thinking": "off", "thinkingLevel": "max" },
  "kimi-k3": { "thinkingLevel": "low" }
}
```

`thinking: 'on' | 'off'` stays a closed union — it is a Moby concept, not a provider one. `thinkingLevel` is a **model-declared string**, validated against that model's `thinkingLevels` keys; an unknown key is dropped with an explanation and the default used, matching the existing validate-and-drop convention. Two keys rather than one so turning thinking off and back on remembers the level.

**Deliberate back-compat exception.** Conventions say no shims unless needed; here it is needed. `reasoningEffort` shipped in 0.8.0 and is persisted in real user settings, so the read falls back `thinkingLevel ?? reasoningEffort` and the key stays in the schema marked deprecated. Dropping it would silently reset a user's Max to the default — a settings-visible regression with no error.

### UI

```
  DeepSeek V4 Pro          Highest-quality reasoning
  Thinking:  [ Off ] [ On ]
  Effort:    [ Low ] [ High ] [ Max ]      ← dimmed when off

  Kimi K3                  Moonshot frontier model
  Effort:    [ Low ] [ High ] [ Max ]      ← no Thinking row; K3 can't be turned off
```

Both rows render **from declared params**: the Thinking row iff `disableThinkingParam` exists, the Effort row iff `thinkingLevels` is non-empty, one pill per key in declaration order. This kills the dead-pill bug structurally rather than by a guard — a pill exists if and only if there are params to send. `RegisteredModelInfo` carries `thinkingLevels` keys + the effective selection in place of `reasoningEffortDefault`.

## Why not separate model entries

The alternative — `deepseek-v4-flash` and `deepseek-v4-pro` as their own non-thinking registry entries, as [registry.ts:203-209](../../src/models/registry.ts#L203) promised — gets the capability differences right for free, since caps resolve per model id.

Rejected because it scales wrong and models the vendor wrong. It doubles the dropdown for every dual-mode model, forces a model switch mid-conversation to change one request param, and says "two models" where DeepSeek ships one dual-mode model. It also cannot express K3, which grades effort without having two modes at all. And it carries a live trap: a non-thinking entry with `sendThinkingParam: false` sends **no** `thinking` param, so the API's enabled-by-default wins and the "non-thinking" model thinks. The comment at :203-209 should be rewritten to point here rather than left as a stale promise.

## Schema gaps to close (`moby.customModels`)

Add: `thinkingLevels`, `defaultThinkingLevel`, `reasoningEcho`, `contextWindow`, `maxOutputTokensCap`, `lspTools`. All are accepted at runtime today and are editor errors to declare.

`reasoningEcho` is the urgent one — **K3 requires the echo, and without the schema entry a K3 entry cannot declare it, so multi-turn tool calls 400.** That is the shipped `moonshot-v1-128k` template's latent failure the day someone points it at a thinking model.

## Template fix — Kimi

The two shipped templates ([extension.ts:688](../../src/extension.ts#L688), [:711](../../src/extension.ts#L711)) target `moonshot-v1-128k` / `-vision-preview`: no thinking, `supportsTemperature: true`, 32K output. K3 is native-vision, so both collapse into **one** entry serving chat and `image-describe`:

```ts
id: 'kimi-k3',
apiEndpoint: 'https://api.moonshot.ai/v1',
toolCalling: 'native', reasoningTokens: 'inline', reasoningEcho: 'required',
supportsTemperature: false,          // fixed 1.0 upstream; omit rather than pin
maxOutputTokens: 131072, maxOutputTokensCap: 1048576, contextWindow: 1048576,
acceptsImages: true, subagentRoles: ['image-describe'],
thinkingLevels: { low: {...}, high: {...}, max: {...} }, defaultThinkingLevel: 'max',
```

Note `supportsTemperature: false` rather than `temperatureFixedValue: 1` — the docs say omit, and omitting is the weaker claim.

## Phases

| # | Slice | Effort | Notes |
| --- | --- | --- | --- |
| 1 | ✅ **DONE 2026-08-12** — `resolveThinking` + capability fields; the three mode-aware sites; `sendThinkingParam` deleted | M | Pure extension-side; no user-facing way to reach off/level yet |
| 2 | ✅ **DONE 2026-08-12** — V4 Flash/Pro re-expressed in the new vocabulary | S | Byte-identical at defaults, see below |
| 3 | ✅ **DONE 2026-08-12** — settings schema + `reasoningEffort` fallback + `setThinking`/`setThinkingLevel` handlers | S | Both handlers *refuse* states the model can't reach |
| 4 | ✅ **DONE 2026-08-12** — data-driven pill rows in the selector | M | Pills render from declarations, so a dead control is now unrepresentable |
| 5 | ✅ **PARTLY DONE 2026-08-12** — `customModels` schema gaps closed; `kimi-k3` replaced both `moonshot-v1-128k` entries | S | Remaining: nothing, unless phase 7 surfaces more fields |
| 6 | ✅ **DONE 2026-08-12** — [ADR 0017](../architecture/decisions/0017-declared-provider-differences.md) (tests landed alongside each phase) | S | Spine is the serialization-vs-behavior taxonomy, not just the thinking work |
| 7 | ✅ **DONE 2026-08-12** — every stencil refreshed; 3 stale replaced, 2 added, coverage added | M | See below |

Phase 2 was the safety phase: if the V4 entries re-expressed in declarative form didn't produce a byte-identical request body at default settings, the abstraction was wrong and phases 3+ would be built on sand. **Confirmed** — every existing enabled-path wire assertion in `deepseekClient.test.ts` (`thinking: {type:'enabled'}`, `reasoning_effort` from registry default and from user override, wire model id, sampling-param stripping) passed **unchanged**. The only three tests that moved were asserting the old vocabulary, and one of them was asserting the bug.

### Phase 7 — stencil refresh

The `CUSTOM_MODEL_TEMPLATES` in [extension.ts:602-750](../../src/extension.ts#L602) are what users click in *Moby: Add Custom Model*, so a stale one ships a broken entry to someone who never edits JSON. The Kimi entry was **three** kinds of stale at once — wrong model id, wrong limits (32K vs 1M context), and missing `reasoningEcho`, which 400s on the second iteration of a tool loop rather than the first. That is the failure mode to expect from the rest.

| Stencil | Status |
| --- | --- |
| Kimi (Moonshot) | ✅ → `kimi-k3`, absorbed the vision sibling (K3 is natively multimodal) |
| Ollama — Qwen 2.5 Coder 7B | stale generation — check current Qwen coder tag |
| OpenAI GPT-4o mini | stale generation |
| Llama 3.3 70B (Groq) | stale generation |
| LM Studio (Local) | placeholder id by design — verify fields, not the name |
| llama.cpp Server | placeholder id by design — same |

Each refresh is a **lookup, not a guess**: current model id, context window, output cap, tool-calling support, vision, and whether it reasons — and if it does, `thinkingLevels` / `disableThinkingParam` / `reasoningEcho`, which the phase-5 schema work now makes declarable. Record the verification date in the template comment; vendor model names go stale on a scale of months, and a stencil that looks authoritative and is wrong is worse than no stencil.

Two follow-ups this phase should also settle: whether any refreshed entry wants `subagentRoles`/`acceptsImages` (the vision picker only lists models declaring both), and whether the remaining `temperatureFixedValue: 1` usages are still right for their providers — K3 moved to `supportsTemperature: false` because the vendor says omit rather than pin.

## Verification roster

**Unit, proven-to-fail-first:**
- Thinking off → request carries **no** `reasoning_content` on any assistant message, **and** carries `temperature`.
- Thinking off → no `reasoning_effort`; thinking on at each level → exactly that level's declared params.
- Router's forced-disabled beats the user pill; on a model with no off-knob it degrades to the cheapest level rather than inventing a param.
- A custom entry declaring `thinkingLevels` gets those params on the wire — the assertion `reasoningEffort` never could make.
- Unknown `thinkingLevel` → dropped with an explanation, default applied.
- Legacy `reasoningEffort: 'max'` in settings still selects max.
- **Byte-identical default request body** for both V4 entries before/after phase 2.

**Dev host** (new manual-test-backlog entries — none of these are reachable from a mock):
- V4 Pro with thinking off: real turn completes, no reasoning block renders, no 400 on iteration 2 (the echo gate is the risk).
- V4 Pro at `low`: confirms the OpenAI-format field accepts it, or 400s and we drop the pill.
- K3: a multi-turn tool-calling session, which exercises `reasoningEcho` and the wrapper-less `reasoning_effort` together.

The pill row is webview-local, so `test:e2e:harness` covers the render; only the wire claims need a real key.

## Open questions

1. **Does DeepSeek's OpenAI-format `reasoning_effort` accept `low`?** Blocks the Low pill on V4 only; the design is unaffected either way.
2. **Should `thinking: 'off'` survive a model switch?** Settings are per-model-id, so it does by construction. Probably right, but it means a model can sit in off-mode across sessions with only the pill to show it — worth a glance at whether the header should say so.
3. **Does K3 emit `reasoning_content` at `low`?** If it emits nothing, `reasoningEcho: 'required'` still needs the empty-string placeholder, which is the [deepseekClient.ts:338-343](../../src/deepseekClient.ts#L338) path — likely fine, unverified.


## Phase 3/4 as built (2026-08-12)

**One resolver, two consumers.** [`resolveThinkingSelection()`](../../src/models/registry.ts) is shared by the request path and `sendModelList`. The webview never recomputes precedence — it renders what the extension resolved. Two implementations of "user setting beats default, caller override beats user" would drift, and the symptom would be a pill showing a level the wire isn't sending, which is exactly the confusion this effort exists to remove.

**The handlers refuse rather than persist.** `setThinking: 'off'` on a model with no off-knob, and `setThinkingLevel` naming an undeclared level, are both dropped with a log line. Persisting them would leave a setting that reads as authoritative while every request ignores it — the dead-control bug one layer up, in settings instead of in the DOM. The UI shouldn't be able to send either, so these are defence in depth against a stale webview or a hand-edited settings file.

**Off is dimmed, not hidden.** When thinking is off the Effort row stays visible at 45% opacity with its pills disabled. Hiding it would read as the level having been lost, when the two-key design exists precisely so it is remembered.

**Labels are derived** (`level.charAt(0).toUpperCase() + …`), never mapped from a fixed list — a provider declaring `medium` must render as *Medium* without a code change, or the declarative model is only half real.

Verification: `test:all` green twice (3,640), `test:e2e:harness` 82/82, typecheck + compile clean. The protocol golden was regenerated via the documented `MOBY_PROTOCOL_UPDATE=1` path and came back with exactly the intended swap — `setReasoningEffort` out, `setThinking` + `setThinkingLevel` in, **no orphans**, which confirms both new types have handlers and the removed one left no stray sender.
## Bugs found by the first dev-host run (2026-08-12) — B1–B3 FIXED same day

Three defects surfaced by the K3 test profile. **None are caused by this effort** — the thinking work is what made them observable, by putting a second real reasoning model on a code path only R1 and V4 had exercised.

### B1. `sendMessage` can dispatch twice — the guard is check-then-act ✅ FIXED

Evidence: two identical requests **1ms apart**, which no human produces:

```
20:34:28.017 → Request: 4 messages  Model: kimi-k3
20:34:28.018 → Request: 4 messages  Model: kimi-k3
20:34:28.616 [ERROR] ... reached max organization concurrency: 1
```

The provider's concurrency limit is the only thing that caught it. ADR 0008's guard at [chatProvider.ts:545](../../src/providers/chatProvider.ts#L545) reads:

```ts
if (this.requestOrchestrator.isGenerating()) { await this.requestOrchestrator.stopGeneration(); }
const result = await this.requestOrchestrator.handleMessage(...);
```

`isGenerating()` is `this.abortController !== null` ([:1548](../../src/providers/requestOrchestrator.ts#L1548)), and `handleMessage` starts at [:906](../../src/providers/requestOrchestrator.ts#L906) but doesn't assign `abortController` until [:1020](../../src/providers/requestOrchestrator.ts#L1020) — **114 lines and at least one `await` later** (`createSession` at ~:941). So there is a wide window in which a turn is running and `isGenerating()` still answers `false`. Two sends landing in that window both pass the guard and both start a loop.

The ADR's stated invariant — *never run two `handleMessage` loops at once* — is therefore not enforced by this code. It holds only against a send arriving during an **established** generation, not against two arriving together.

**Fix:** the flag that guards must be set **synchronously**, before the first `await`. Add a `_starting` latch set at the top of `handleMessage` and cleared where `abortController` is nulled ([:1519](../../src/providers/requestOrchestrator.ts#L1519), [:1573](../../src/providers/requestOrchestrator.ts#L1573)), and make `isGenerating()` return `abortController !== null || this._starting`. Preserves ADR 0008's interrupt-then-restart semantics; only closes the window. The subtlety to get right is `stopGeneration()` against a turn that is starting but has no `AbortController` yet — it must await the starting turn rather than no-op.

**Not yet established: what produced two sends.** The webview's own path is unproven, and it does not matter for the correctness of the guard, but it should be instrumented (log the dispatch origin) rather than assumed.

### B2. `clearConversation()` has no re-entrancy guard — two sessions, one orphaned ✅ FIXED

Same run, same second:

```
20:34:27.927 🌐 Web search cache cleared
20:34:27.929 [CM] createSession id=fb69feea title="New Chat"
20:34:27.929 🌐 Web search cache cleared
20:34:27.930 [CM] createSession id=92068357 title="New Chat"
```

[`clearConversation()`](../../src/providers/chatProvider.ts#L1270) is `async`, awaits `createSession`, then assigns `this.currentSessionId`. Two concurrent calls both create a session; the second wins and the first is orphaned — a stray "New Chat" in history, and briefly an ambiguous current session (the log's `switchSession: null → 0cfd90a8` reads as exactly that confusion).

It has three entry points — the `moby.newChat` command ([extension.ts:237](../../src/extension.ts#L237)), `case 'clearChat'`, and `selectModel` on a non-empty session ([:610](../../src/providers/chatProvider.ts#L610)) — and nothing serializes them.

**Fix:** an in-flight promise latch; a second caller awaits the first and returns instead of creating another session.

**Incidental finding:** `case 'clearChat'` ([:559](../../src/providers/chatProvider.ts#L559)) is **dead** — no webview code posts that type (the three `postMessage({type:'clearChat'})` sites are all extension→webview). It belongs on the protocol-orphan cleanup list, not in the dispatch path.

### B3. Custom reasoning models lose their reasoning on the legacy path ✅ FIXED

```
kimi-k3:                    reasoning=29 chars, reasoning_chunks=9  →  [HistorySave] reasoning=0
deepseek-v4-flash-thinking: reasoning_chunks=34                     →  [HistorySave] reasoning=1 (142 chars)
```

In [`streamAndIterate`](../../src/providers/requestOrchestrator.ts#L1935) the reasoning capture is gated:

```ts
// R1-only: save iteration reasoning/content for the per-iteration replay UI.
if (isReasonerModel) { state.reasoningIterations.push(...) }
```

The `streamingToolCalls` path ([:3639](../../src/providers/requestOrchestrator.ts#L3639)) pushes unconditionally, which is why V4 records and K3 doesn't. The gate was correct when R1 was the only non-V4 model emitting `reasoning_content`; **any custom model declaring `reasoningTokens: 'inline'` on the legacy path now silently drops it.** It doesn't 400 today only because `reasoningEcho: 'required'` falls back to the documented empty-string placeholder — but the vendor requires the real content back on tool-calling turns, so this is a latent 400 on exactly the multi-turn tool loop M47 S4 exercises.

**Fix:** widen the gate from `isReasonerModel` to `caps.reasoningTokens === 'inline'`. Model-scope comment required per Conventions — the *contentIterations* half stays R1-only (it feeds R1's per-iteration replay UI), so the two halves of that block are no longer the same scope.

### B4. K3 pays for every turn twice (not a defect — a missing declaration)

```
[ApiCall] model=kimi-k3 iter=1 mode=non-stream ... prompt=12,298 completion=49
[ApiCall] model=kimi-k3 iter=1              ... prompt=1,650  completion=28
```

K3 doesn't declare `streamingToolCalls`, so [requestOrchestrator.ts:1230](../../src/providers/requestOrchestrator.ts#L1230) routes it to `runToolLoop` — a non-streaming probe carrying the full 54-tool array, whose answer is then discarded and regenerated by the stream. Same double-generation shape as the 2026-08-04 non-native-custom fix, reached legitimately here because K3 *is* native.

**Fix:** add `"streamingToolCalls": true` to the stencil — **but only after confirming Moonshot streams `delta.tool_calls`**, which has been the open Kimi question (M40.2) since 2026-08-03 and is now answerable with a real K3 key. Note this also sidesteps B3 for K3, since the streaming path records reasoning unconditionally — but B3 must still be fixed for every other custom model on the legacy path.


### As fixed (2026-08-12)

**B1** — `_starting` is set at the synchronous top of `handleMessage` and folded into `isGenerating()`. The teardown deferred moved up with it: it was previously minted beside the `AbortController`, so a `stopGeneration` during the starting window awaited a *resolved* deferred from the **previous** turn and returned immediately — which is what let the second send proceed. Both halves were needed. A stop landing in that window now sets `_stopRequestedWhileStarting`, applied the moment the controller exists, so the turn unwinds instead of running to completion after the user asked it to stop.

**B2** — `clearConversation()` is now a latch around `doClearConversation()`; concurrent callers join the in-flight promise. Released via `.finally()`, so a throwing clear can't wedge new-chat for the rest of the session.

**B3 turned out to have *two* gates, not one.** Widening the push was inert on its own: the `onReasoning` callback passed to `streamChat` was itself `isReasonerModel ? … : undefined` ([:2107](../../src/providers/requestOrchestrator.ts#L2107)), so nothing ever accumulated for a non-R1 model. Both now read one `capturesReasoning` local. The test caught this — it still failed after the first fix, which is the only reason the second gate was found.

**A regression the existing suite caught:** the first attempt *replaced* `isReasonerModel` with the capability check rather than widening it, which broke *should include reasoning iterations in endResponse* — that test mocks `isReasonerModel` true while `getModel()` returns `deepseek-chat`, so the capability check alone said "no reasoning". The gate is `isReasonerModel || caps.reasoningTokens === 'inline'`; strictly widening keeps R1 exactly as it was.

Verification: 9 new tests, **5 mutations each killing exactly the tests naming that behavior** (latch ignored, stop-during-start dropped, each reasoning gate reverted, latch removed). `test:all` green twice (3,646), typecheck + compile clean. **B4 is deliberately not done** — `streamingToolCalls` on the K3 stencil needs a real tool-calling turn against Moonshot first, and declaring it unverified would break tool dispatch rather than merely cost tokens.

### B5. Context starvation — the K3 stencil's cap exposed a three-layer defect (2026-08-12) ✅ FIXED

`[Context] 2,094/0 tokens | 1 dropped`. The user's question was discarded and the request went out anyway; the model answered from the system prompt and looked confidently wrong. Trigger was the stencil declaring `maxOutputTokensCap: 1048576` equal to `contextWindow: 1048576` — true to the vendor docs, and a footgun because the model selector adopted the **cap** as a fresh selection's max_tokens, leaving `budget = window − max_tokens = 0`.

Fixed at all three layers rather than only the stencil, because each was independently wrong: the selector now defaults to the model's own `maxOutputTokens` (new `defaultMaxTokens` on `RegisteredModelInfo`); `ContextBuilder` clamps the reserve so the conversation always keeps ≥10% of the window; and dropping the entire conversation logs WARN instead of INFO.

**The clamp threshold is the interesting call.** A generous split (half the window) *looks* safer and is worse — R1 legitimately reserves 65,536 of 128,000, and the half-window clamp silently shrank it. The existing R1 budget test caught that immediately. The floor is therefore deliberately small: intervene only when the conversation would get essentially nothing, never second-guess a reserve that merely looks large.

**Note for existing K3 users:** the bad `maxOutputTokens: 1048576` is already persisted in `moby.customModels` from the old selector behaviour. The clamp makes it survivable (budget becomes ~104K), but it should be reset to `131072` by hand or by re-adding the stencil.
## Phase 7 research — provider survey (2026-08-12)

Done **before** the ADR deliberately: five providers is the first real test of whether "declare levels as named param bundles" holds outside DeepSeek and Kimi. It does — and the survey found one client-level blocker.

### The design validation

| Provider | Level param | Values | Disable mechanism |
| --- | --- | --- | --- |
| DeepSeek V4 | `reasoning_effort` **+ `thinking` wrapper** | low, high, max | `{"thinking":{"type":"disabled"}}` |
| Kimi K3 | `reasoning_effort` (bare) | low, high, max | **none — always reasons** |
| Gemini (OpenAI-compat) | `reasoning_effort` | minimal, low, medium, high | `"none"` — **2.5 only**; 3.x cannot disable |
| GLM (Zhipu) | `reasoning_effort` | high, max | `{"enable_thinking": false}` |
| OpenAI GPT-5.x | `reasoning_effort` | none, minimal, low, medium, high, xhigh, max (model-dependent) | `"none"` |

Five providers, five different value sets, **three structurally different disable mechanisms**, and two models that cannot be disabled at all. A closed union would need seven values and still couldn't express the disable variance. `thinkingLevels` + `disableThinkingParam` covers every row without a code change — including the case where disabling is expressed *as a level value* (`{"reasoning_effort": "none"}` is just another param bundle in `disableThinkingParam`).

Gemini was the case worth checking, because its native API uses an integer `thinkingBudget`. On the OpenAI-compat endpoint Google maps effort names onto it themselves (`medium` → 8,192 tokens on 2.5), so we never see the integer. Had we needed it, a named level pointing at `{"thinkingConfig":{"thinkingBudget":8192}}` would still have worked — the map holds arbitrary params, not enum values.

**Conclusion: the capability model survives contact with four more providers. The ADR can be written against it.**

### Blocker found: `max_tokens` vs `max_completion_tokens`

Kimi K3 documents `max_completion_tokens`; OpenAI's reasoning models require it and **reject `max_tokens`**. Moby sends `max_tokens` at [deepseekClient.ts:448](../../src/deepseekClient.ts#L448) and [:590](../../src/deepseekClient.ts#L590).

This is a **prerequisite for phase 7**, not a detail inside it: two of the five stencils would ship broken. It didn't surface on K3 because Moonshot appears to accept the alias (turns completed), but "completed" only proves it wasn't rejected — with our value equal to the vendor default, an ignored param is indistinguishable from an honoured one.

Cheapest probe: set K3's max tokens to ~2,000 and ask for a long answer. Overrun ⇒ the param is being ignored. Likely fix is a `maxTokensParam?: 'max_tokens' | 'max_completion_tokens'` capability, declared per entry — same shape as every other provider-quirk axis here.

### Draft stencils — NOT yet verified against live APIs

Numbers below come from vendor docs and secondary sources. Per the phase-7 rule, each needs one real turn before shipping, and the template comment should carry the verification date.

| Model | id | Context | Default out | Levels | Disable | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Gemini Flash | `gemini-3.6-flash` | 1,048,576 | 65,536 | minimal/low/medium/high | ✗ (3.x) | base `https://generativelanguage.googleapis.com/v1beta/openai/` |
| GPT-5.5 | `gpt-5.5` | 1,050,000 | 128,000 | none…xhigh, default medium | `"none"` | needs `max_completion_tokens`; **GPT-5.6 shipped 2026-07 — check before pinning 5.5** |
| GLM | `GLM-5.2` | 1,000,000 | 131,072 | high, max | `enable_thinking:false` | endpoint + exact id unconfirmed (Zhipu direct vs Together vs Alibaba differ) |
| Qwen (Ollama) | — | — | — | — | — | existing stencil stale; local, so limits are user-config |
| Groq Llama | — | — | — | — | — | existing stencil stale |

Open questions to settle during phase 7: whether OpenAI's `reasoning_effort` works on `/chat/completions` (Moby's endpoint) or only the Responses API; whether reasoning models reject `temperature` outright (`supportsTemperature: false` vs `noSamplingParamsWhenThinking`); and the exact GLM endpoint/id, which differs per host.


## Phase 7 as built (2026-08-12)

**Eight stencils, all dated.** Three were pointing at superseded models and one at a *deprecated* one:

| Stencil | Was | Now |
| --- | --- | --- |
| Ollama | `qwen2.5-coder:7b-instruct` | `qwen3-coder:30b` — 256K context |
| OpenAI | `gpt-4o-mini` | `gpt-5.6` — 1.05M context, graded reasoning, **`max_completion_tokens`** |
| Groq | `llama-3.3-70b-versatile` | `openai/gpt-oss-120b` — the old id was **deprecated by Groq 2026-06-17** |
| Moonshot | `moonshot-v1-128k` ×2 | `kimi-k3` (done earlier — native vision collapsed the pair into one) |
| Gemini | — | `gemini-3.6-flash` (new) |
| GLM | — | `glm-5.2` (new) |
| LM Studio, llama.cpp | placeholder ids **by design** | fields re-checked, unchanged |

Every entry now carries the date its facts were checked, and values that came from vendor docs rather than a live turn are marked `UNVERIFIED` inline — the OpenAI `reasoning_effort`-on-chat-completions question, Gemini 3.6's exact limits, GLM's model id, and whether Groq honours `reasoning_effort` for gpt-oss.

**Every hosted stencil now declares `contextWindow`.** None of the five originals did, so they all silently fell back to 128,000 — harmless on a small local model, wrong by an order of magnitude on every modern hosted one, and invisible because nothing errors.

**Extracted to [customModelTemplates.ts](../../src/models/customModelTemplates.ts).** They were inline in `extension.ts`, which meant importing them for a test dragged in the whole activation graph — so they had **zero** coverage. Now 56 tests, including:

- every stencil passes the same `validateCustomModelEntry` a user entry does (a failing stencil is silently dropped at load: the user clicks Add, sees JSON appear, and gets no model);
- `apiEndpoint` matches the endpoint shown in the quickPick description;
- hosted stencils declare `contextWindow`; local ones declare a port matching their URL;
- anything declaring `thinkingLevels` also declares `reasoningTokens: 'inline'` — the K3 dropped-reasoning shape;
- `maxOutputTokens` leaves room for a conversation — the **K3 starvation shape**, caught directly;
- the package.json schema `examples` match the templates exactly.

That last one closed a live drift: four of the six examples pointed at models the quickPick no longer offered. They are now generated from the templates, and the test keeps them that way.

Three mutations were run against the suite — a starving stencil, a hosted stencil missing `contextWindow`, and a reasoning stencil claiming `reasoningTokens: 'none'` — each killed exactly the test named for it.

**Ten stencils after a follow-up pass**, adding the two providers that genuinely exercise the escape hatch:

- **OpenRouter** — the first shipped `extraParams` user, carrying provider-routing preferences (`provider: {allow_fallbacks}`, `transforms`) that Moby never reasons about. It also brings a **sixth** reasoning shape: OpenRouter normalizes reasoning into a nested `reasoning: { effort }` object and deprecates flat `reasoning_effort`. Other clients have shipped 400s by sending both; we send exactly what's declared, so there is nothing to collide. Its `id` is an example to swap — OpenRouter fronts hundreds of models, and the capability fields track whichever one you point at while the reasoning shape tracks OpenRouter.
- **vLLM** — its docs describe the hatch almost verbatim ("parameters that are not part of the OpenAI API… merge them into the JSON payload"). But the interesting half is that its *thinking* knob went to `disableThinkingParam`, not `extraParams`: a Qwen3 under vLLM disables reasoning via `{"chat_template_kwargs": {"enable_thinking": false}}` — **nested two levels**, a fourth structurally distinct off-knob. It fit because the field holds arbitrary params rather than an anticipated shape. Deliberately ships **without** `extraParams`: vLLM's extras are sampling knobs, and a stencil pinning those imposes a sampling policy rather than describing a provider.

So the original prediction held for the eight surveyed providers, and the hatch earned itself on the ninth. Running tally of disable mechanisms: a nested wrapper (DeepSeek), a sibling boolean (GLM), a sentinel level value (OpenAI), a chat-template kwarg (vLLM), and two models with no off state at all (Kimi K3, Gemini 3.x).

**Known boundary:** `extraParams` is body-only. Azure OpenAI needs `api-version` as a query parameter and `api-key` as a header, so it would require separate `extraHeaders`/`extraQuery` work — the hatch does not quietly cover it.