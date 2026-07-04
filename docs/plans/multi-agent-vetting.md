# Multi-Agent Code-Vetting Layer for Moby

**Status:** Design proposal — for `docs/plans/`
**Date:** 2026-06-26
**Author:** Lead architect (design draft)
**Anchors:** ADR [0011](docs/architecture/decisions/0011-verification-gated-turn-completion.md) (verification-gated turn completion), ADR [0006](docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md) (edit-safety), ADR [0008](docs/architecture/decisions/0008-request-scoped-stream-lifecycle-and-interrupt-teardown.md) (request-scoped stream lifecycle), ADR [0010](docs/architecture/decisions/0010-web-search-query-ledger-and-cache.md) (web-search query ledger + cache), [docs/plans/subagents.md](docs/plans/subagents.md) (subagent router), the `SubagentRouter` contract ([src/subagents/router.ts](src/subagents/router.ts)), `verifyTurnCompletion` ([src/providers/requestOrchestrator.ts:411](src/providers/requestOrchestrator.ts#L411)).

---

## 1. Executive recommendation

Moby already runs a **free, objective, per-turn quality gate** that most agentic coding tools do not have: `verifyTurnCompletion` ([requestOrchestrator.ts:411](src/providers/requestOrchestrator.ts#L411)). At the turn-stop seam it does two **deterministic, non-LLM** things — (Half 1) re-consults the **last build verdict** and forces a fix if the project check (`batch.command`) regressed after the final edit, and (Half 2) runs a language-agnostic **artifact-presence** check for the build-passes-but-output-empty/clobbered case. The build that backs Half 1 runs **at most once per turn**, only when edits occurred (non-editing turns pay nothing — [requestOrchestrator.ts:242](src/providers/requestOrchestrator.ts#L242)). **This is the load-bearing fact of the whole design: most of the vetting value Moby will ever want is the deterministic build+artifact gate it already has.**

So the recommendation is deliberately conservative and staged:

1. **First, build the cheap deterministic wins that are NOT multi-agent.** (a) Add a thin **non-LLM `vscode.languages.getDiagnostics()` reader** — Moby has *zero* diagnostics usage today (no tool, no internal read), yet the API is native and free; surfacing the language server's own errors/warnings on the changed files is a small building block that strengthens the existing gate with ground truth, not model opinion. (b) Add a **prompt-level "evidence-before-claims" completion discipline** to the main system prompt (the single lowest-effort, highest-ROI steal from the external research — and it requires *zero* subagent infrastructure). Ship and measure these first.

2. **Only then, and only if measurement shows residual escapes the deterministic gate cannot catch,** add **one** new subagent role: a V4-flash `diff-reviewer` critic that runs **once per completion attempt at the same `verifyTurnCompletion` seam**, routed through the existing `SubagentRouter`. Its findings either annotate the turn (default) or, on a confident hard finding, hold it open for repair (bounded by the existing budget). It must earn its place *above* the free gate by targeting **only what the build and diagnostics cannot catch**: logic/contract bugs, security, wrong-but-compiles, missing edge cases, and diff-vs-intent drift.

Everything else — LangGraph, a knowledge graph, BMad ceremony, the superpowers runtime — is a borrowed *concept*, not an adopted dependency.

One-line verdict on each avenue:

- **LangGraph / LangChain JS** — *Hand-roll; steal the graph-with-checkpoints mental model only.* Moby's loop is already a hand-rolled graph with request-scoped abort teardown (ADR 0008); adopting LangGraph would duplicate the event-sourced history (ADR 0003), sit entirely in `src/` (the `media/` bundle can't import it), and pull a large dependency tuned for a different model family.
- **BMad Method** — *Borrow the single idea of an explicit named gate verdict; skip the agile ceremony — and note BMad itself walked back its separate QA persona.*
- **Superpowers / SKILL.md** — *Adopt the "verification-before-completion" prompt discipline standalone and the file-format/library idea; do not take the plugin runtime.*
- **Knowledge graph** — *Don't build one. The five real LSP tools + an optional cached repo-map are your structural index, queried on-demand against the live tree.*
- **Deterministic vs. let-the-main-agent-decide** — *Hybrid. Determinism owns the **firing** (when the gate runs, what holds the turn). The agent owns the **depth** (how hard to look, what matters) — and, for the LLM critic specifically, may also own **whether the critic runs at all** on a given turn, because for many turns the deterministic gate is enough and the critic should be skipped.*

---

## 2. The core question: deterministic vs. agent-decided vs. hybrid

This is the question that determines whether the feature ships or rots, so take a hard position: **the firing of the *deterministic* gate must be deterministic; the *content* of any vetting must be agent-decided; and the firing of the *LLM critic* may itself be agent-decided depth, because skipping it is often correct.**

### Where determinism belongs: the gate

ADR 0011 exists *because* self-certification doesn't work. Its Alternative C — "ask the model 'are you actually done?'" — was rejected with a one-sentence kill: *"the model declared the slide done while it sat empty."* The invariant is that turn completion is decided **from observable ground truth, not the model's say-so**. That invariant must hold for the deterministic gate:

1. **A turn that applied edits in auto mode always passes through the gate before it can complete.** This is not a new control-flow primitive — it is *literally the condition `verifyTurnCompletion` already evaluates* ([requestOrchestrator.ts:414](src/providers/requestOrchestrator.ts#L414), aborts/non-auto early-return; [:439](src/providers/requestOrchestrator.ts#L439), reads applied changes from `diffManager.getFileChanges()`).
2. **The deterministic checks (build verdict, artifact presence, and the proposed diagnostics read) are ground truth and are never skipped on an editing turn.** They are cheap (the build is already bounded to once per turn) and immune to model sycophancy.
3. **The budget is the existing budget.** ADR 0011's defining discipline — *introduces no new counter* — is non-negotiable. Re-injection rides `_editRepairByFile` + the iteration cap ([requestOrchestrator.ts:466](src/providers/requestOrchestrator.ts#L466)).

### Where agent-discretion belongs: depth — and, for the LLM critic, *whether to run*

What a critic *looks at*, how *hard* it looks, and which findings *clear the bar* cannot be spelled out deterministically without rebuilding a linter — and Moby is deliberately language-agnostic (ADR 0011 Alternative D rejects bundled per-language checkers). So the critic model owns severity, load-bearing-ness, and which hunks deserve scrutiny.

Crucially — and this is a refinement of the original position — **for the LLM critic, "whether to run at all" is also a legitimate discretion point, because for many turns the deterministic gate is sufficient and the critic adds only cost.** The trap is *only* letting the **main agent** skip the **deterministic gate** (that is rebuilt self-certification). It is *not* a trap to let a deterministic classifier — or even the agent's own depth signal — decide that a given diff is low-risk enough that the *LLM critic* layer is skipped. The deterministic gate still fires; the speculative semantic layer is what's conditional.

### The synthesis, stated as a rule

> **Deterministic answers "did the build/artifact/diagnostics gate run, and does any finding hold the turn open?" — always, on every editing turn. A classifier (deterministic) plus the role's own `shouldRoute` answers "is this diff worth an LLM critic pass at all?" The critic answers "what's semantically wrong, and how much does it matter?"**

The boundary is the return value of `verifyTurnCompletion`: a `string` (hold the turn, deterministic consequence) carrying agent-authored content (the finding), or `null` (accept the stop).

---

## 3. Is the LLM critic even worth it? (the frank reckoning)

Before architecting the critic, reckon honestly with whether it adds signal **over the deterministic gate Moby already runs**. The external research cuts *against* the feature's premise in three specific ways, and the original draft of this document leaned on a capability Moby does not have to wave them off. Corrected:

**(i) Anthropic's published finding: naive multi-agent orchestration HURTS on coding specifically.** Anthropic's own multi-agent research reports that multi-agent systems help on *research/breadth* tasks (parallelizable, independent sub-questions) but are a poor fit for *coding*: *"most coding tasks involve fewer truly parallelizable subtasks… LLM agents are not yet great at coordinating and delegating."* Coding is different because it is **shared mutable state with a coherence requirement** — the diff must be internally consistent, and a second agent reasoning from partial context can degrade that coherence rather than improve it. A research swarm fans out over an effectively read-only world; a coding critic operates on a single living artifact where being *almost* right is often worse than being silent. This is the strongest external argument against the whole feature, and it is why the design is **one critic at one seam reviewing a settled diff**, not a swarm and not a per-edit interleave.

**(ii) The sycophancy / LLM-judge-reliability problem — and DeepSeek-critiquing-DeepSeek is the WEAK case.** LLM-as-judge verdicts are known to swing >10% on answer ordering and exceed 50% error on some bias benchmarks; ground-truth oracles dominate model judges wherever an oracle exists. A **same-family** configuration (DeepSeek reviewing DeepSeek) is the *worst* case: correlated blind spots and a strong prior to rubber-stamp the family's own output. The original draft's proposed mitigation — "lead with diagnostics" — **collapsed on inspection, because Moby has no diagnostics tool today.** Mitigations that actually hold:

  - **Make the deterministic gate the oracle and the LLM the escalation, not the first line.** The build verdict, the artifact check, and the *proposed new* `vscode.languages.getDiagnostics()` reader are oracles — immune to sycophancy. The LLM critic only speaks to what oracles cannot see (semantics, contracts, intent drift).
  - **Independent context (anti-sycophancy by construction).** The `diff-reviewer` role receives the **constructed diff + the user's intent (recent prompt) + structural blast-radius context from the five LSP tools** — and **must NOT receive the main turn's reasoning or session history.** A reviewer that reads the author's rationalization inherits its blind spots; a reviewer handed only "here is the change, here is what was asked, is the change correct?" is forced to evaluate independently. This is a *design requirement of the role*, not a nicety.
  - **Refute-by-default prompting + diverse lenses + structured verdicts.** Not a single "looks good?" pass. The role prompt instructs the critic to *try to break* the diff across named lenses (correctness/contract, security/IO, edge cases, diff-vs-intent), and to emit a structured verdict per finding rather than a prose blessing. Absence of a found defect is the *null* result; the critic is rewarded for refutation, not approval.

**(iii) Negation-blindness is real, and the most security-relevant findings are exactly what LLMs miss.** "DO NOT" constraints (never read `.env`, never write outside `src/`) are precisely the class LLM critics under-detect. **Do not hand the security story to the flaky LLM.** Route prohibitions to the **deterministic path-permission enforcement** already on the roadmap (CLAUDE.md Planned Work #3 — glob-based read/write rules). The LLM critic may *advise* on security smells; the *enforcement* of prohibitions is deterministic.

**Conclusion of the reckoning.** The honest framing: **most of the value is the deterministic build/artifact/diagnostics gate Moby already has (or can cheaply add); the LLM critic is a speculative semantic add-on of unproven marginal value, and for many turns it should be skipped entirely.** That is why §1 sequences the non-LLM wins *first* and gates the critic behind measurement (§5, §6). The critic ships *only if* it demonstrably catches a class of defect — logic/contract/security/intent-drift — that the oracles do not, at an acceptable false-gate rate.

---

## 4. Proposed architecture

### 4.1 Prerequisite building blocks (non-LLM, ship first)

- **Thin diagnostics reader (new, non-LLM).** A small `src/` helper around `vscode.languages.getDiagnostics(uri)` returning errors/warnings for the turn's changed files. Moby has **zero** existing usage; this does not exist yet. It is *not* a model tool and *not* a new LSP tool — it is an internal read consumed by the gate and (later) handed to the critic as oracle context. Optionally surface a `get_diagnostics` *model* tool later, but the gate needs only the internal read.
- **Evidence-before-completion prompt discipline (new, non-LLM).** A system-prompt rule requiring the model to cite observable evidence (a passing check, a non-empty file, a diagnostic-clean read) before claiming done. Zero infrastructure; ship and measure independently — it may capture much of the value before any critic exists.

### 4.2 The seam

The vetting layer hooks **`verifyTurnCompletion`** ([requestOrchestrator.ts:411](src/providers/requestOrchestrator.ts#L411)), called at the terminal break of *both* loops ([:3516](src/providers/requestOrchestrator.ts#L3516) streaming, [:3861](src/providers/requestOrchestrator.ts#L3861) non-streaming), returning `Promise<string | null>`. We add **Half 3** after the existing build-verdict (Half 1) and artifact-presence (Half 2) checks:

```
verifyTurnCompletion(signal):
  Half 1 — last build verdict regressed?  → re-inject (exists; one-shot guarded)
  Half 2 — applied file empty/clobbered?  → re-inject (exists)
  Half 3 — diff-reviewer critic [NEW]     → re-inject on HARD finding, else annotate
  → null (accept stop)
```

**Cadence, stated correctly (this corrects the original draft's central error).** `verifyTurnCompletion` fires at **every** terminal break. Half 1 is bounded to one shot per turn by `_verifyRegressionReinjected` ([requestOrchestrator.ts:424](src/providers/requestOrchestrator.ts#L424)); Half 2 is bounded by the per-file repair budget. **A naïve Half 3 would therefore re-fire on every completion attempt** — including each time a hard finding re-injects, the model edits, and the loop returns to the seam. The cadence is **once per completion attempt, not once per turn.** Two bounding mechanisms are mandatory:

1. **A diff-hash cache (the ADR 0010 lesson, applied).** Hash the constructed diff; cache the critic's verdict keyed by that hash. A completion attempt whose diff is unchanged (or whose changed region the prior finding already covered) **skips the LLM call entirely** and reuses the cached verdict. This directly addresses re-vetting a near-identical diff and is the same "cache the post-digest string so dups skip the provider" discipline ADR 0010 adopted after the 71-near-dup-searches incident.
2. **A one-shot/attempt-capped guard.** Mirror `_verifyRegressionReinjected`: a `_critGateAttempts` (riding the *existing* repair budget — no new user-facing counter) so the critic can re-inject a given finding-class at most `maxRepairAttempts` times before downgrading to annotate. This guarantees a vet/repair loop converges exactly as Half 2 does.

Why this seam and not "post-edit, per-batch" (`settleEditBatch` at [:3674](src/providers/requestOrchestrator.ts#L3674))? Because per-batch is *per-iteration* — a multi-iteration turn would invoke the critic N times on overlapping, half-finished diffs. The completion seam reviews the **settled diff** and matches the cadence of the gate it extends.

**The diff is reconstructable at the no-edit terminal point.** ADR 0011's whole motivation is that the model's final "done" iteration is often a **no-edit summary** that never hits `settleEditBatch`. The critic still has its input there: `diffManager.getFileChanges()` **persists applied changes** across iterations (it is exactly the source Half 2 reads at [:439](src/providers/requestOrchestrator.ts#L439)), so the full set of applied hunks is in hand at the terminal break even when that iteration applied nothing. The "settled diff" is not assumed — it is the same persisted change set the existing gate already consumes.

### 4.3 The critic's input contract (the actually-hard part)

This was hand-waved in the draft; specify it.

- **Diff construction.** From `diffManager.getFileChanges()` filtered to `status === 'applied'`, assemble a unified diff. `diffManager` holds before/after per file; the role builds per-file unified hunks (not whole files).
- **Size bounding (1M context, but cost-sensitive flash).** Although V4-flash carries a large context window, billing and latency scale with tokens, so bound the input deterministically: cap total diff bytes (e.g. ~32KB); when the turn touched many files (the "40 files" case), **rank by blast radius** — files with the most `find_references` fan-out and files on sensitive paths first — and include full hunks for the top-K, eliding the rest to a one-line-per-file summary noted in the prompt. The cap is a config knob; the *ranking* is what keeps a giant diff reviewable.
- **Oracle context attached, not re-read.** The critic is handed: the unified diff, the **diagnostics** for changed files (from the new reader), the **last build verdict/output**, and *on-demand* structural facts via the five real LSP tools (`outline`, `get_symbol_source`, `find_symbol`, `find_definition`, `find_references`). It does **not** re-read whole files — that is the context cost the subagent pattern exists to avoid — and it does **not** receive session history or the main turn's reasoning (§3(ii)).

### 4.4 The model and the router contract

The critic runs on **`deepseek-v4-flash-thinking`** (the cheap worker, [registry.ts:189](src/models/registry.ts#L189)), routed through the **existing `SubagentRouter`** ([router.ts](src/subagents/router.ts)), reusing `SubagentRole<TInput, TOutput>` ([types.ts](src/subagents/types.ts)) — `shouldRoute / buildSystemPrompt / buildUserMessage / parse / formatForMain`. The router gives us for free:

- **Per-modelId client cache**, never mutating the main client ([router.ts:21](src/subagents/router.ts#L21)).
- **Forced non-thinking** on every sub call ([router.ts:64](src/subagents/router.ts#L64)) — the latency lesson from web-search-digest (thinking was 4–7s/call). See the envelope caveat in §7.
- **Total failure-swallowing**: every fallback returns `{routed: false, reason}` ([router.ts:35](src/subagents/router.ts#L35)+). For a critic this is the *correct* default — a failed critic must never block the turn (fail-open, §7).
- **Capability gating**: the role runs only if the model declares it ([router.ts:43](src/subagents/router.ts#L43)). Add `'diff-reviewer'` to `deepseek-v4-flash-thinking.subagentRoles` and to the `SubagentRoleName` union ([types.ts:11](src/subagents/types.ts#L11)).

**Two real contract extensions (the draft understated one and mislabeled another):**

1. **`route()` gains an optional `signal`.** The underlying transport **already** supports abort — `ChatOptions.signal` exists ([deepseekClient.ts:91](src/deepseekClient.ts#L91)) and is threaded to `fetch` ([deepseekClient.ts:533](src/deepseekClient.ts#L533)). The router simply doesn't *pass* it today, because web-search-digest runs inside `webSearchManager` with its own controller — not because `chat()` can't take a signal. So the change is small and precise: `route(role, input, taskContext, signal?)`, forwarding `signal` into the existing `client.chat({ …, signal })` at [router.ts:66](src/subagents/router.ts#L66).

2. **A new *consumption mode* for `RouteResult`.** Every existing consumer substitutes the digest string *for* a tool result. The vetter instead consumes `RouteResult` to make a **control-flow** decision (continue vs. break) **and** to render a **structured** annotation. The role's `parse()` produces `{findings: [{severity, file, line, issue, fix}], gateOn}`; but the contract's `formatForMain` is typed to return the **digest string**, not structured findings. Reconcile this explicitly: `formatForMain` returns a human-readable digest string (used for the re-injection feedback text and the log), while the **structured findings travel on `RouteResult` as a typed side-channel** the orchestrator reads for the gate decision and the UI annotation. Do not overload `formatForMain` to emit structure it isn't typed for; widen `RouteResult` with an optional `findings?: VetFinding[]` that only this role populates. The router stays generic; the **orchestrator** owns the gate-vs-annotate policy (same division as ADR 0011: the validator computes the verdict, the orchestrator owns the stop decision).

### 4.5 Roles (sequenced, not all-at-once)

| Role | Input | Output | Consequence | When |
|---|---|---|---|---|
| `diff-reviewer` | unified applied diff + recent user prompt + diagnostics + on-demand LSP blast-radius (NO session history) | `{findings:[{severity,file,line,issue,fix}], gateOn}` | **HARD → re-inject (gate, budget-bounded); SOFT → structured annotation** | MVP |
| `test-synthesizer` | changed public symbols + their `find_references` | suggested test stubs | **annotate only**, never gates | Expansion |

`diff-reviewer` is the only role that can gate — keeping blast radius minimal, exactly as ADR 0011's artifact check is the only thing that holds a turn open on the "looks empty" signal. There is no per-hunk `edit-critic` fan-out in the plan: per-hunk fan-out is the cost-multiplier shape ADR 0010 burned on, and the blast-radius ranking in §4.3 already lets one call cover a large diff.

### 4.6 Deterministic blast-radius classifier (when does the critic fire?)

The cheapest way to make the critic fire **rarely and precisely** is a deterministic classifier in front of it (richer than a bare line-count `shouldRoute`):

- **Skip** when: total changed lines < N; diff is pure deletions; all changes are in ignored paths (`shouldIgnoreWatcherPath`, already applied at [:451](src/providers/requestOrchestrator.ts#L451)); diagnostics are clean *and* the diff is small.
- **Always fire** when the diff touches **sensitive paths** — auth, credential handling, file/network I/O, `.env`-adjacent, anything covered by the path-permission roadmap globs. This is the cheapest, highest-value trigger: it concentrates the LLM critic exactly where a wrong-but-compiles change is most dangerous, and it is fully deterministic.

This classifier *is* the "agent-decided whether to run" discretion of §2, expressed as code rather than left to the model.

### 4.7 Abort / interrupt interaction

`signal.aborted` already short-circuits the seam ([:414](src/providers/requestOrchestrator.ts#L414)): if the user hits stop, the critic never runs. The in-flight V4-flash call is torn down by threading the **stable local `signal`** that `verifyTurnCompletion` already receives into `route(role, input, ctx, signal)` (§4.4.1). (R1 swaps `this.abortController` mid-turn, but R1 is deferred for the MVP — §6 — so that closure hazard is moot here; the native-tool loops' `signal` is a stable local and is the right one to thread.)

### 4.8 Cost, latency, and the interactive budget (corrected math)

**Cadence:** **one V4-flash call per completion attempt**, gated by the §4.6 classifier and the §4.2 diff-hash cache (a re-vet of an unchanged diff is a cache hit, zero LLM calls). For a typical single-attempt turn that passes the classifier, that is **exactly one** non-thinking flash round-trip.

**Token estimate (single `diff-reviewer` call):** system+lens prompt ~600 tokens; bounded diff ~32KB ≈ ~8K tokens worst case (typically far less after ranking/elision); diagnostics+blast-radius context ~1–2K; structured-JSON output ~300–800 tokens. **Worst-case ~10–11K input / <1K output per call.** Non-thinking V4-flash latency for that envelope is **~1–3s**.

**Latency budget for interactive use:** target **≤ ~2s added** in the common case. Achieved by: classifier skips trivial turns (no call); diff-hash cache skips re-vets; **SOFT-by-default** means the common finding is an *annotation*, not a re-injection — the turn completes at normal latency and the badge appears after. Only a **HARD** finding pays the extra repair iteration, and a multi-attempt repair is bounded by §4.2's attempt cap so flash round-trips cannot stack unbounded.

**Non-blocking / annotate-only mode (mandatory option).** When latency would stall the user — large diffs, or a user who opts out of gating — run the critic in **annotate-only** mode: the turn completes immediately and findings are attached as a post-hoc annotation (rendered when they arrive). In this mode the critic **never** holds the turn open; it is pure advisory. This is the default ship state (§6) and the safe configuration for interactive feel.

**Spend backstop (the ADR 0010 lesson, applied).** A vet/repair loop is the same fan-out shape that produced ~140 flash calls from 71 near-dup searches. Add an explicit **per-turn vet-call budget** (e.g. ≤ 3 critic invocations per turn, config-bounded) so a pathological repair sequence cannot run the critic indefinitely — distinct from, and stricter than, the repair-attempt cap.

### 4.9 The UI annotation (real new message, designed)

A structured `{file, line, severity, issue}` finding is **more than the existing `_onWarning` channel carries** — `_onWarning` fires a flat `{message: string}` ([requestOrchestrator.ts:102](src/providers/requestOrchestrator.ts#L102)). So:

- **Extension side:** a new typed event, e.g. `_onVetFindings.fire({ requestId, findings })`. Per **ADR 0008**, the payload is **`requestId`-stamped** so a superseded turn's vet findings are dropped by the `chatProvider` relay and never paint over the live turn. (A SOFT finding may still degrade to a one-line `_onWarning` string for the simplest "review noted: X" badge, but the structured panel needs the new event.)
- **`media/` side:** a presentational annotation actor renders the findings list against the turn, comparing `requestId` to the active turn before painting. **No shared types cross the boundary** — define the `VetFinding` payload locally on each side per the standing `src`/`media` rule; the wire shape is duplicated, not imported.

This is the *only* `media/` touch, and it is genuinely new — not a free reuse of the string-warning channel.

### 4.10 ASCII flow (corrected)

```
        ┌──────────────────────────── agentic loop (auto mode) ───────────────────────────┐
        │                                                                                  │
        │   iteration N:  model → tool_calls? ──yes──► dispatch + settleEditBatch (0006)    │
        │                          │                  (build runs AT MOST ONCE/turn, 242)   │
        │                          no                                                       │
        │                          ▼                                                        │
        │              ┌──────────────────────── verifyTurnCompletion(signal) ───────────┐ │
        │              │  signal.aborted? ─yes─► return null (accept) ◄── ADR 0008/0011   │ │
        │              │  editMode != auto? ─► return null                                │ │
        │              │                                                                  │ │
        │              │  Half 1: last build verdict == regression?  ─► re-inject  [0011] │ │
        │              │          (one-shot via _verifyRegressionReinjected)              │ │
        │              │  Half 2: applied file empty/clobbered?      ─► re-inject  [0011] │ │
        │              │  [+ NEW non-LLM: read getDiagnostics(changed files) as oracle]   │ │
        │              │                                                                  │ │
        │              │  Half 3 [NEW]: blast-radius classifier                           │ │
        │              │     trivial / ignored / clean-diag+small ── skip ──► fall through │ │
        │              │     sensitive-path OR non-trivial                                │ │
        │              │        │                                                         │ │
        │              │        ▼  diff-hash cache hit? ──yes──► reuse verdict (no call)  │ │
        │              │        │ miss                                                    │ │
        │              │        ▼                                                         │ │
        │              │  route('diff-reviewer', unifiedDiff+intent+diagnostics+LSP,      │ │
        │              │         ctx, signal)   [NO session history → anti-sycophancy]    │ │
        │              │        │   └─► v4-flash-thinking (non-thinking, JSON, ~1-3s)     │ │
        │              │        ▼                                                         │ │
        │              │   findings ── HARD & attempts<cap ─► return feedback (GATE)      │ │
        │              │            └─ SOFT / non-block mode ─► _onVetFindings (ANNOTATE)  │ │
        │              │            └─ none ──────────────────► return null               │ │
        │              │   routed:false (sub failed/timeout) ─► return null  (FAIL-OPEN)  │ │
        │              └──────────────────────────────────────────────────────────────────┘ │
        │                          │                                                        │
        │   feedback? ─yes & under repair budget & vet-call budget─► push + continue        │
        │                          no ─► break (turn complete)                              │
        └──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Per-avenue verdicts with reasoning

### LangGraph / LangChain JS — *hand-roll; steal the concept*

**Verdict: do not adopt. Steal the "stateful graph with checkpoint/interrupt nodes" mental model and stop there.**

LangGraph reifies an agent loop as a graph of nodes with persisted state and explicit interrupt points — which is *what Moby already is*. Moby's loop has request-scoped stream lifecycle and interrupt teardown (ADR 0008), a verdict-gated terminal boundary (ADR 0011), recency-pinned plan state (ADR 0009), and event-sourced replayable history (ADR 0003). LangGraph's checkpointer would **duplicate** the event-sourcing you already have, and its node abstraction fights two hard constraints: (1) the **`src`/`media` bundle split** — it is a Node dependency that cannot cross into the webview, so it sits entirely in `src/` and buys nothing on the UI side; (2) **it is a large dependency tuned for a different model family**, with R1's inline-reasoning envelope and Moby's hand-rolled abort discipline both needing to be re-expressed inside its abstractions. (The "more precise cancellation than LangGraph" claim from an earlier draft is dropped — it was an unsupported flourish; the case against adoption rests on bundle split, duplication of event-sourcing, and dependency weight, which are sufficient.)

What to steal: the **discipline of naming nodes and edges.** The vetting layer is a node ("vet") with out-edges ("gate→continue", "pass→complete"). Writing it that way in the doc/comments keeps control flow legible — free, no framework.

### BMad Method — *borrow one idea; note BMad itself walked it back*

**Verdict: borrow the "explicit named gate verdict" framing (PASS / CONCERNS / FAIL); skip the SM/PO/Architect/Dev ceremony.**

The transferable idea is a gate with **explicit three-state verdicts**, which maps onto Moby's `null` / annotate / re-inject and usefully forces the soft-vs-hard distinction §4.8 depends on. **But cite the caveat honestly:** BMad v6 *consolidated* its standalone QA persona (Quinn) back into the Dev agent — i.e. **the framework itself walked back the separate-reviewer-persona** this design might otherwise hold up as validation. So BMad is *not* external proof that a separate critic agent is correct; if anything its trajectory is mild evidence that a fully separate persona has organizational cost. Take the **verdict vocabulary**, not the separate-agent endorsement.

Skip entirely: the multi-persona agile lifecycle. Moby is *one* agent doing a coding turn, not a simulated sprint team.

### Superpowers / SKILL.md — *adopt the verification-before-completion discipline STANDALONE; skip the runtime*

**Verdict: the single highest-ROI steal is the "verification-before-completion" prompt discipline — and it is NOT multi-agent. Ship it standalone (§4.1) before building any critic.**

The superpowers research's lowest-effort/highest-ROI item is a prompt-level **evidence-before-claims** gate: the agent must cite observable proof before declaring done. It requires **zero** subagent infrastructure and may capture much of the value the critic is chasing — so it must not be folded into the critic; it ships first and is measured on its own.

Secondarily, keep the **process-library / file-format** idea: encode the critic's review criteria (the lenses of §3) as a **data file the role reads**, shaped SKILL.md-compatibly for the already-deferred "Skills format support" item — tunable without code changes. But **do not take the plugin runtime**: it assumes a model trained to the skill-invocation convention; V4-flash has no such prior, so a "skill" is just a prompt to it. Adopt the *format and library concept*; skip the *runtime*.

### Knowledge graph — *don't build one; LSP + an optional cached repo-map is your index*

**Verdict: do not build a persisted knowledge graph. At most, a cached, on-demand repo-map; everything richer is served by the five LSP tools at vetting time.**

A persisted code graph is a **synchronization liability** — a second index of a tree the language server already indexes, stale the instant the agent edits a file (which, for a vetting layer, is *every time it matters*). The structural facts the critic needs — what references this changed symbol, where is it defined, what's its source — are answered against the **live tree** by Moby's five real tools: `find_references`, `find_definition`, `find_symbol`, `get_symbol_source`, `outline`. Querying on-demand is strictly more correct than a graph you'd invalidate on every edit.

The **smallest worthwhile build** is an optional *lightweight cached repo-map* (Aider-style: files → top-level symbols → signatures) derived from one `outline` pass per file, **in-memory with mtime invalidation, never persisted to SQLite** (the event-sourced DB is your durable layer; a stale code map in it is a footgun). Build it only if the `test-synthesizer` expansion needs it — the MVP `diff-reviewer` does not (it has the diff + diagnostics + on-demand LSP).

### "Let the main agent decide" — *right for depth; right for skipping the LLM critic; a trap only for the deterministic gate*

**Verdict: correct for vetting *depth*; correct that the *LLM critic* may be skipped on low-risk turns; a trap only for whether the *deterministic gate* fires.**

Where it's right: depth of scrutiny is genuinely model-territory (encoding it deterministically rebuilds a linter, contra ADR 0011 Alt. D). And **skipping the LLM critic on a low-risk diff is correct** — that discretion lives in the deterministic classifier (§4.6), not in the model's confidence.

Where it's a trap, stated bluntly: **a model confident enough to end its turn will not reliably choose to second-guess itself** — the exact failure ADR 0011 (Alternative C, self-certification) was written to fix. So the **deterministic gate** (build/artifact/diagnostics) must fire on every editing turn regardless of model confidence. Determinism owns *that* firing; the agent/classifier owns depth and the conditional LLM pass.

---

## 6. MVP → expansion sequencing

The proving-ground discipline is in the repo: `web-search-digest` shipped *alone, end-to-end* first ([docs/plans/subagents.md](docs/plans/subagents.md)). Mirror it — but front-load the non-LLM wins.

**PR 1 — non-LLM building blocks, no subagent at all.**
Ship (a) the `vscode.languages.getDiagnostics()` reader wired into `verifyTurnCompletion` as oracle context, and (b) the evidence-before-completion prompt discipline. **Measure** their effect on completion quality. This is the lowest-effort, highest-ROI step and it may move the metric enough that the critic is unnecessary. No router, no role, no `media/` change.

**PR 2 — `diff-reviewer`, annotate-only, behind a flag.**
Ship the role wired only on the **SOFT/annotate** path: the critic runs at Half 3, but every finding fires `_onVetFindings` and **nothing gates the turn**. Proves the full scaffolding — router-at-the-turn-boundary, the new role + capability tag, **diff construction + size bounding**, the diff-hash cache, the `signal` threading, the `requestId`-stamped UI annotation, the blast-radius classifier — with **zero risk of holding a turn open incorrectly.** Gate behind `moby.codeVetting.enabled` (default `false`) and `moby.codeVetting.gateOnHardFindings` (default `false`). Tests mirror `tests/unit/subagents/router.test.ts` plus an orchestrator test asserting the SOFT path never returns a gating string and that a superseded `requestId` is dropped.

**Kill criterion / success metric (the bar PR 2 must clear before PR 3).** Define explicitly so the feature cannot rot enabled-`false` forever:
  - **Primary:** *HARD-finding precision* on a labeled sample — fraction of HARD findings that are real defects the **build + artifact + diagnostics gate did NOT already catch.** Target ≥ ~0.7. If the critic mostly re-flags what the oracles already flag, it adds no signal — **kill it.**
  - **Guardrail:** *false-gate rate* (turns the HARD path *would* have held open on a non-defect) must be ≤ ~5% before `gateOnHardFindings` may default on.
  - **Cost:** measured added p50 latency ≤ ~2s on non-trivial turns; vet-call spend within the §4.8 backstop.
  If primary precision is not met, the LLM critic does **not** advance to gating and may be removed — the non-LLM gate from PR 1 stands on its own.

**PR 3 — enable the HARD gate (only if PR 2 clears the bar).**
Flip `gateOnHardFindings` live: a HARD finding returns feedback and `continue`s, bounded by the existing `_editRepairByFile` budget **and** the §4.2 attempt cap **and** the §4.8 per-turn vet-call backstop. Ship with conservative HARD-class definitions (a correctness/contract regression, or a sensitive-path security flag) so the gate fires rarely and precisely.

**PR 4 — repo-map + `test-synthesizer` (annotate-only).**
Build the in-memory cached repo-map (§5) and add `test-synthesizer` as an annotate-only role for changed public symbols. Never gates.

**Roadmap fit:** CLAUDE.md orders subagent routing as **"Next up #1"**, starting with low-blast-radius roles. The PR-1 non-LLM blocks are independent of all of it. The `diff-reviewer` reuses the identical scaffolding and proving-ground tactic, slotting in alongside the planned `search-digest`. It requires neither the MCP work (#2) nor — though it *coordinates with* — the path-permission rules (#3): the deterministic enforcement of prohibitions (#3) is where the security story lives, with the critic advisory on top.

---

## 7. Risks, failure modes, and open questions (Moby-specific)

**Does the LLM critic beat the free gate? (the headline risk).** Covered in §3: it must clear the §6 precision bar against the build+artifact+diagnostics oracles, or it does not ship gating. **The deterministic gate is the product; the critic is the bet.**

**Critic sycophancy with same-family models.** Mitigated structurally: oracles lead; the critic gets **no session history / no main reasoning** (independent context, §3(ii)/§4.3); refute-by-default prompting with diverse lenses and structured verdicts. Residual risk is real — hence the conservative HARD-class and the precision kill-criterion.

**Latency on an interactive agent.** Mitigations are structural (§4.8): classifier skips trivial turns; diff-hash cache skips re-vets; SOFT/annotate-only by default; ≤ ~2s budget; non-blocking mode for large diffs. **Open question:** is even one ~1–3s call per non-trivial turn acceptable for interactive feel? Measure; ship `enabled:false`.

**Thinking-mode is NOT a free toggle.** V4-flash-thinking has `supportsTemperature:false` and `reasoningEcho:'required'` — re-enabling thinking **changes the request envelope** (no temperature, echo required) and **re-incurs the 4–7s tax** the router's forced-non-thinking exists to avoid; it also streams `reasoning_content`, which interacts with the JSON-mode parse path the role depends on. So "non-thinking for speed, thinking for depth" is **not a per-finding dial** — it is a different request shape with a different latency class and parse path. **Decision for the MVP: non-thinking only.** A thinking-mode escalation, if ever, is a separate experiment with its own envelope handling, not a setting.

**Cost / fan-out blow-up.** No per-hunk fan-out (§4.5); single call per attempt; diff-hash cache + per-turn vet-call backstop (§4.8) bound spend, applying the ADR 0010 lesson directly.

**Non-convergence (vet → "fix" → vet again).** Solved by construction: the gate rides `_editRepairByFile` + the iteration cap (as Half 2 does, [:466](src/providers/requestOrchestrator.ts#L466)) **and** the §4.2 attempt cap. A finding-class that recurs `maxRepairAttempts` times downgrades to annotate. **No new user-facing counter.**

**Fail-open is mandatory.** A critic that throws, times out, or returns malformed JSON must **never** block the turn — `router.route` already returns `{routed:false}` on every failure path, and the orchestrator treats `routed:false` as "accept the stop" (return `null`). A vetting layer that can deadlock a turn on its own bug is worse than no vetting.

**R1's shell loop — deferred (and that makes its closure hazard moot).** ADR 0011 itself deferred the R1 reasoner-shell break; do the same. R1 applies edits via SEARCH/REPLACE + heredocs with its own path-semantics guards (ADR 0004), and swaps `this.abortController` mid-turn — but since R1 is out of MVP scope, that swap does not affect the native-tool loops, whose `signal` is a stable local (§4.7). Ship for the native-tool loops (V4 streaming + legacy `runToolLoop`) first.

**`src`/`media` boundary.** The vetting logic lives entirely in `src/`. The single `media/` touch is the `requestId`-stamped findings annotation (§4.9), over the existing `postMessage` bridge ([VirtualMessageGatewayActor.ts](media/actors/message-gateway/VirtualMessageGatewayActor.ts)). No shared types cross the boundary — the `VetFinding` shape is defined locally on each side.

**Open question — `RouteResult` consumption mode.** §4.4 widens `RouteResult` with an optional typed `findings?` side-channel rather than overloading `formatForMain`. Confirm this holds as roles multiply: if a future role needs different gating semantics, the **orchestrator's** Half 3 grows a small policy table; the **router** stays generic and never learns about gating.

---

**Bottom line:** Moby already owns the part of code-vetting that actually pays off — a deterministic, once-per-turn build+artifact gate at `verifyTurnCompletion`. The highest-leverage next steps are **non-LLM**: a thin `getDiagnostics` reader and an evidence-before-completion prompt rule. An LLM `diff-reviewer` critic is worth building **only as a measured, annotate-first, oracle-led, history-blind escalation** that earns its place above the free gate on a precision bar — and it should be skipped on the many turns where the deterministic gate already suffices. Don't add a framework, a graph, or a methodology to a codebase that already out-engineers all three on the axis that matters here: the seam is cut, the contract exists, and the cheapest wins aren't multi-agent at all.