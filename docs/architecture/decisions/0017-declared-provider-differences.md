# 0017. Provider differences: declare serialization, code behavior

**Status:** Accepted — thinking axes shipped 2026-08-12; the taxonomy is the standing rule for new axes
**Date:** 2026-08-12

## Context

Moby's model registry started as a table of facts about DeepSeek's two models. It is now the compatibility layer for an open set of OpenAI-compatible providers — DeepSeek, Moonshot, Zhipu, Google, OpenAI, plus whatever a user hand-writes into `moby.customModels`. Every provider agrees on the envelope (`POST /chat/completions`, `messages`, `tools`) and disagrees on nearly everything else.

The immediate forcing case was reasoning control. A survey of five providers (2026-08-12, recorded in [thinking-modes-and-levels.md](../../plans/thinking-modes-and-levels.md#phase-7-research--provider-survey-2026-08-12)):

| Provider | Level param | Values | Disable mechanism |
| --- | --- | --- | --- |
| DeepSeek V4 | `reasoning_effort` **plus a `thinking` wrapper** | low, high, max | `{"thinking":{"type":"disabled"}}` |
| Kimi K3 | `reasoning_effort`, bare at top level | low, high, max | **none — the model always reasons** |
| Gemini (OpenAI-compat) | `reasoning_effort` | minimal, low, medium, high | `"none"`, but **only on 2.5**; 3.x cannot disable |
| GLM (Zhipu) | `reasoning_effort` | high, max | `{"enable_thinking": false}` |
| OpenAI GPT-5.x | `reasoning_effort` | none…xhigh, model-dependent | `"none"` |

Five value sets, three structurally different disable mechanisms, and two models with no off state at all. The pre-existing design — a closed `ReasoningEffort = 'high' | 'max'` union fused to DeepSeek's wire shape via a `sendThinkingParam` boolean — could express exactly one row.

The registry had also accumulated two *different* strategies for absorbing differences, without anyone naming the split:

- **Interpreted flags**, each requiring a hand-written call site: `supportsTemperature`, `temperatureFixedValue`, `reasoningEcho`, `streamingToolCalls`, `toolCalling`, `reasoningTokens`, `promptStyle`, `editProtocol`, `shellProtocol`, `lspTools`, `acceptsImages`, `wireModelId` — about thirteen.
- **Declared param bundles**, merged with no interpreting code: `disableThinkingParam` — one.

Adding a provider therefore mostly meant editing code, and each new quirk added a branch. Three defects found in one dev-host session on 2026-08-12 sharpened what actually goes wrong: `reasoningEffort` validated on a custom entry and never reached the wire; a custom model's `reasoning_content` was dropped by an `isReasonerModel` gate; and a max-tokens value equal to the context window starved the conversation to zero budget. Only the first was a serialization problem. The other two were behavioral, and no amount of config would have prevented them.

## Decision

**Classify every provider difference as either *serialization* or *behavior*, and handle each class with a different mechanism.**

**Serialization differences** — what a parameter is named, how it is nested, which values it accepts, whether it is sent at all — are **declared as data** and merged into the request body with no interpreting code. `thinkingLevels` is the reference implementation: an ordered map from a level name to the request params that level sends.

```ts
thinkingLevels?: Record<string, Record<string, unknown>>;   // name → params to merge
defaultThinkingLevel?: string;
disableThinkingParam?: Record<string, unknown>;             // absent = cannot be disabled
```

Because the values are arbitrary param objects rather than enum members, one mechanism covers all five providers above: DeepSeek's wrapper-plus-effort, Kimi's bare effort, and Zhipu's separate `enable_thinking` boolean are the same shape of declaration. The case where disabling is itself expressed as a level value (`{"reasoning_effort": "none"}`) is just another bundle. Gemini's native integer `thinkingBudget` would also fit, as `{"thinkingConfig": {"thinkingBudget": 8192}}`, though its OpenAI-compat endpoint does that mapping server-side.

**Behavioral differences** — which code path runs, what must be echoed, what the provider rejects mid-loop — stay **in code**, gated on a named capability. `reasoningEcho`, `streamingToolCalls`, `toolCalling`, and `noSamplingParamsWhenThinking` are behavior, not payload, and a config table cannot express them.

**Absence in a declaration is meaningful and must be honored.** A model that declares no `disableThinkingParam` cannot be turned off; the UI renders no Off control and the request path never invents one. We never guess a provider's knob, because a wrong guess is a 400 rather than a slow answer.

**A rename is not an alias unless the meaning is identical.** `max_tokens` and `max_completion_tokens` are *not* interchangeable: the latter is spent on the reasoning trace as well as the visible answer. Where a rename changes the denominator, it is modeled explicitly rather than mapped.

## Alternatives considered

### A. Keep widening the closed unions

Add `low` and `medium` to `ReasoningEffort`, add a boolean per provider quirk. Smallest diff per change, and the shape everyone reaches for first.

Rejected because it does not converge. Absorbing the five providers above needs seven enum values and still cannot express *how* each disables — one wants a nested wrapper, one a sibling boolean, one a sentinel value, and two have no off state at all. Worse, it puts vendor knowledge in the extension binary: a provider shipping a new level requires a Moby release, and a user's hand-written `moby.customModels` entry can never describe a model we did not anticipate.

### B. A universal parameter-mapping table

One `paramAliases: { max_tokens: "max_completion_tokens" }` map applied to the whole request body, so adding a provider becomes pure configuration.

Rejected as a leaky abstraction over a real semantic difference. A rename table asserts identity, and `max_completion_tokens` is not `max_tokens` renamed — on a reasoning model the budget covers the reasoning trace too. Aliasing them silently changes what the number means: set 2,000, the model spends 1,900 reasoning, and the answer truncates while the UI shows a short reply rather than an error. That is the same failure shape as the context-starvation bug of the same day, where a number meaning "reserve" was used as though it meant "limit". A flat map also cannot express nesting or value domains, so it would have to be supplemented by the declarations above anyway.

The deeper objection is that it advertises a false promise. It would make adding a provider *look* like configuration, when the failures that actually bite are behavioral — a 400 on the second tool iteration, reasoning silently dropped, a discarded double generation. Kimi K3 looked healthy on turn one and failed structurally on the paths tests did not cover.

### C. Per-provider adapter classes

A `Provider` interface with a class per vendor owning request construction end to end. Maximum expressiveness, clean separation.

Rejected as disproportionate. Providers agree on the envelope and differ in a handful of fields; an adapter per vendor duplicates the 95% that is identical to get at the 5% that is not. It also puts vendors back in the binary — a user cannot write a class into `settings.json`, and supporting an unanticipated backend is the whole point of `moby.customModels`. Worth revisiting only if a non-OpenAI request format (`requestFormat: 'anthropic'`) is ever actually implemented, where the envelope itself diverges.

### D. Two registry entries per upstream model

Model non-thinking and thinking as separate model ids, as the V4 entries' original comment proposed. Capability differences resolve per id for free.

Rejected: it doubles the picker for every dual-mode model, forces a model switch to change one request parameter, and cannot express a model that grades effort without having two modes at all (Kimi K3). It also carries a trap — an entry that simply omits the thinking param still thinks, because the API defaults to enabled.

## Consequences

**Positive:**

- New providers with new level vocabularies need a settings edit, not a release. A provider's `medium` renders as a pill and reaches the wire with no code change.
- Dead controls become structurally unrepresentable in the class of UI driven by these declarations. The model picker renders one pill per declared level and an Off control only when an off-knob exists, so a control cannot exist without params behind it. This closed a real latent bug where a custom model rendered a working-looking High/Max row that reached no wire.
- One precedence resolver ([`resolveThinkingSelection`](../../../src/models/registry.ts)) is shared by the request path and the picker, so the UI cannot display a level the wire is not sending.
- The taxonomy gives new axes a default home and a test to apply: *does this change the payload, or the code path?*

**Negative / accepted costs:**

- Declarations are unvalidated against the provider. A wrong param name in `thinkingLevels` is a 400 at request time, not a startup error. This is deliberate — the alternative is a vendor allowlist, which is exactly the coupling being removed — but it moves a class of error to runtime.
- `moby.customModels` entries are more verbose, and a hand-written entry can be subtly wrong in ways the schema cannot catch. The shipped stencils are the mitigation, which makes stencil accuracy load-bearing: the `moonshot-v1-128k` stencil was wrong on the model id, the limits, and `reasoningEcho` simultaneously, and the last of those 400s on the *second* tool iteration rather than the first.
- The split is a judgment call at the margin. `noSamplingParamsWhenThinking` is a flag because it is conditional on resolved state, but it could be argued as serialization.
- Roughly thirteen interpreted flags predate this ADR and are not being migrated. The rule applies to new axes; consolidating the existing serialization-shaped ones (`supportsTemperature`, `temperatureFixedValue`) into a single request-params descriptor is a follow-up, not a prerequisite.

**Follow-ups:**

- ~~`maxTokensParam`~~ **shipped 2026-08-12**, alongside `extraParams` — see "Escape hatch" below.
- Phase 7 stencil refresh under this rule ([plan](../../plans/thinking-modes-and-levels.md)). Each stencil is a lookup, not a guess, and carries its verification date.
- Possible consolidation of the serialization-shaped legacy flags (`supportsTemperature`, `temperatureFixedValue`) into one `requestParams` descriptor, if the per-flag call sites keep accumulating.
- Dev-host verification of the shipped thinking work: [M47](../../plans/manual-test-backlog.md).


## Addendum — the escape hatch (2026-08-12)

The decision above answers *how* to model a difference, but not *whether* Moby should model it at all. Applying it to five providers made the missing rule obvious:

> **A provider field earns a named capability only when Moby's own code must read the value** — it renders a control, computes the number, or branches on it. Everything else is pass-through, and Moby never needs to know the field exists.

`extraParams` is that pass-through: an object merged into every request for the model. It generalizes a mechanism the thinking work had already proven but bound to one axis — `Object.assign(requestBody, thinking.params)` was a user-declared param bundle all along, just conditional on thinking state.

| Field | Moby reads it? | Home |
| --- | --- | --- |
| `reasoning_effort` levels | Yes — renders pills, router forces off | `thinkingLevels` |
| `enable_thinking: false` | Yes — router triggers it | `disableThinkingParam` |
| max output value | Yes — computes, clamps, reserves context against it | `maxTokensParam` (name only) |
| `safety_settings`, `service_tier`, `num_ctx` | No | `extraParams` |

Two details are load-bearing:

**Merge order.** `extraParams` is merged **before** the thinking params, so a declared level always wins. The reverse would let a static `extraParams.reasoning_effort` silently deaden the effort pill — a live control overridden by config is the same dead-control bug this design exists to prevent, one layer up.

**Reserved keys are rejected, not dropped.** `model`, `messages`, `stream`, `tools`, `max_tokens`, and `max_completion_tokens` are Moby's to construct; the token fields specifically because overriding them bypasses clamping and the context reserve computed from them. A config typo that silently replaced `messages` would corrupt every request with no error to notice — so validation fails loudly and names the supported mechanism instead.

**Boundary:** `extraParams` covers the request *body* only. A provider needing a query parameter or a custom header (Azure OpenAI: `api-version`, `api-key`) is not covered and would require separate axes. Stated so nobody assumes the hatch is universal.

**Expected outcome: the stencils will mostly not use `extraParams`.** All five surveyed providers fit the named axes, which is evidence the named set is well-chosen rather than arbitrary. This is insurance for the providers nobody surveyed — its success condition is that it stays absent from shipped stencils while unblocking a user who would otherwise wait for a release.

**Outcome (2026-08-12, ten stencils):** the prediction held for the eight surveyed providers — none needed it. The hatch earned itself on the ninth, **OpenRouter**, whose provider-routing preferences are exactly the "Moby never reasons about this" case. **vLLM** was the more interesting result: its extras are sampling knobs that a stencil shouldn't pin, but its *thinking* knob (`{"chat_template_kwargs": {"enable_thinking": false}}`, nested two levels) dropped into `disableThinkingParam` untouched. Six distinct reasoning shapes are now expressed by the same two fields, with no code branching on any of them.