# 0008. Request-scoped stream lifecycle and interrupt teardown

**Status:** Accepted — implemented. Three refinements vs. this text: (1) the teardown is serialized by deferring `generationStopped` until the loop's `finally` (which matches the webview's existing stop→`generationStopped`→send flow) plus a `sendMessage` `isGenerating` guard, rather than the `sendMessage` handler awaiting `stopGeneration` directly (it does not call it today); (2) `requestId` is stamped at the **chatProvider relay** from a single `currentRequestId` getter rather than on the event types + every fire site — equivalent because the orchestrator's `EventEmitter.fire()` is synchronous, so the relay reads the id at the instant of the fire (a dying request's late `endResponse` still carries its own id); (3) the webview ignores a superseded request's shell event by identity **regardless of whether a turn is open** (the ADR scoped it to the no-turn case), matching the `endResponse` guard. The structural-event-stream tagging (Follow-ups) remains deferred.
**Date:** 2026-06-20

## Context

A traced on-stage session at 9:14pm exposed a defect that begins as a cosmetic UI glitch and ends in file corruption. The user interrupted a running generation by sending a new message; the new turn rendered briefly, then the live UI went dead — tool and shell events stopped appearing, with the webview log filling with `shellExecuting: NO CURRENT TURN ID - dropping message!`. Worse: a follow-up interrupt did **not** cancel the still-running backend, so two model loops ran concurrently and raced on the same `write_file` targets, clobbering one file down to an empty shell. The same edit-fidelity failure family that ADR [0006](0006-edit-safety-checkpoint-and-validation.md) addresses, but here the trigger is a **lifecycle race**, not a garbled REPLACE.

The stream lifecycle is a single global event bus with no per-request identity, and the interrupt path tears down nothing it can wait on. Three independent defects compound:

1. **Abort teardown is not awaited.** The orchestrator owns one mutable `abortController`, created per request at [requestOrchestrator.ts:814](../../../src/providers/requestOrchestrator.ts#L814) (right next to `_userInitiatedStop = false` at [:816](../../../src/providers/requestOrchestrator.ts#L816) — ADR 0001's stop flag). `stopGeneration()` ([requestOrchestrator.ts:1312](../../../src/providers/requestOrchestrator.ts#L1312)) calls `abortController.abort()` and returns `void` **synchronously** — it does not wait for the streaming loop to unwind. The loop's abort handling lives in the `catch` ([requestOrchestrator.ts:1156](../../../src/providers/requestOrchestrator.ts#L1156), abort branch [:1158](../../../src/providers/requestOrchestrator.ts#L1158)–[:1216](../../../src/providers/requestOrchestrator.ts#L1216)) and `finally` ([requestOrchestrator.ts:1286](../../../src/providers/requestOrchestrator.ts#L1286)–[:1301](../../../src/providers/requestOrchestrator.ts#L1301)), and the aborted request still fires its trailing `_onEndResponse` from the abort branch ([requestOrchestrator.ts:1195](../../../src/providers/requestOrchestrator.ts#L1195)). Nothing connects that teardown to the start of the next request.

2. **The sendMessage handler does not serialize requests.** `onDidReceiveMessage` is registered as an `async` callback ([chatProvider.ts:506](../../../src/providers/chatProvider.ts#L506)); the `sendMessage` case `await`s `handleMessage` ([chatProvider.ts:516](../../../src/providers/chatProvider.ts#L516)). But `await` only serializes *within one callback invocation* — a second `sendMessage` (the interrupt) arrives as a **separate** dispatch and runs concurrently with the first. So the new `handleMessage` begins while the aborted request is still inside its `catch`/`finally`, replacing `abortController` at [:814](../../../src/providers/requestOrchestrator.ts#L814) and `_currentTurnId` at [:774](../../../src/providers/requestOrchestrator.ts#L774) out from under the loop that is still tearing down. Two loops overlap.

3. **Lifecycle events carry no correlation id, and the webview tracks a single global turn.** `_onStartResponse.fire()` ([requestOrchestrator.ts:821](../../../src/providers/requestOrchestrator.ts#L821)) and every `_onEndResponse.fire()` ([:1088](../../../src/providers/requestOrchestrator.ts#L1088), [:1195](../../../src/providers/requestOrchestrator.ts#L1195), [:1265](../../../src/providers/requestOrchestrator.ts#L1265)) — plus tool/shell fires — carry no request identity (`StartResponseEvent` / `EndResponseEvent` / `ShellExecutingEvent` at [types.ts:118](../../../src/providers/types.ts#L118) / [:124](../../../src/providers/types.ts#L124) / [:155](../../../src/providers/types.ts#L155) carry only `correlationId`, a *tracing* id, not a *control* id). The relay forwards each to the webview verbatim ([chatProvider.ts:283](../../../src/providers/chatProvider.ts#L283)–[:380](../../../src/providers/chatProvider.ts#L380)). On the webview side, `VirtualMessageGatewayActor` keeps one `_currentTurnId` ([VirtualMessageGatewayActor.ts:75](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L75)). `handleStartResponse` mints a fresh `turn-N` and sets it ([VirtualMessageGatewayActor.ts:880](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L880)–[:881](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L881)); `handleEndResponse` clears it on **any** endResponse ([VirtualMessageGatewayActor.ts:990](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L990)); `handleShellExecuting` drops the event when it is `null` ([VirtualMessageGatewayActor.ts:1008](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1008)–[:1011](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1011)).

Put together, the 9:14pm sequence is forced:

```
  req-A streaming ─ user interrupts ─ stopGeneration() aborts A (returns immediately)
  req-B handleMessage starts (concurrent) ─ startResponse(B) ─ webview turn-2 opens
  req-A's trailing endResponse fires ─ webview clears _currentTurnId (turn-2!)  ◄ wrong turn ended
  req-B's date-check shell fires ─ _currentTurnId === null ─ "NO CURRENT TURN ID" drop
  user interrupts again ─ but turn looks "ended", and abortController now points at B…
  …A's loop never truly stopped ─ two loops race on the same write_file ─ file clobbered
```

The UI symptom (a dead turn) and the data-loss symptom (concurrent writes) share one root: **stream lifecycle has no notion of *which request* an event belongs to, and the interrupt does not wait for the prior request to finish dying before starting the next.** This is the control-plane analogue of ADR [0003](0003-events-table-sole-source-of-truth.md)'s data-plane unification: there, two channels authored the same fact; here, two requests author lifecycle events into one unlabelled stream.

This ADR does **not** revisit ADR [0001](0001-stop-button-discards-partial.md)'s save semantics (a user stop still persists marker-only; a backend abort still keeps the partial). It changes only **event correlation** and **teardown ordering** — the `_userInitiatedStop` flag and the abort-branch save at [requestOrchestrator.ts:1158](../../../src/providers/requestOrchestrator.ts#L1158)–[:1216](../../../src/providers/requestOrchestrator.ts#L1216) are untouched.

## Decision

Give every request a `requestId` and make the lifecycle request-scoped end to end. Three coordinated edits across the extension/webview boundary:

### 1. Mint a `requestId` per request and tag every lifecycle event

Mint one id where the request's `abortController` is created — [requestOrchestrator.ts:814](../../../src/providers/requestOrchestrator.ts#L814), alongside `_userInitiatedStop` ([:816](../../../src/providers/requestOrchestrator.ts#L816)) so the stop surface and the correlation surface live together:

```ts
this.abortController = new AbortController();
this._currentRequestId = `req-${sessionId ?? 'no-session'}-${Date.now()}`;
this._userInitiatedStop = false;
```

Add `requestId: string` to `StartResponseEvent`, `EndResponseEvent`, and `ShellExecutingEvent` ([types.ts:118](../../../src/providers/types.ts#L118) / [:124](../../../src/providers/types.ts#L124) / [:155](../../../src/providers/types.ts#L155)), and stamp it on the fires — `_onStartResponse.fire` ([:821](../../../src/providers/requestOrchestrator.ts#L821)), all three `_onEndResponse.fire` sites ([:1088](../../../src/providers/requestOrchestrator.ts#L1088), [:1195](../../../src/providers/requestOrchestrator.ts#L1195), [:1265](../../../src/providers/requestOrchestrator.ts#L1265)), `_onToolCallsStart`/`Update`/`End`, `_onShellExecuting` / `_onShellResults`, and `_onIterationStart`. Critically, the abort and error end-fires read the id captured **at request start** (a local snapshot), so a superseded request's late endResponse still carries *its own* id, not the successor's. The relay at [chatProvider.ts:283](../../../src/providers/chatProvider.ts#L283)–[:380](../../../src/providers/chatProvider.ts#L380) is the single stamping choke point — every `postMessage` there already spreads or copies the payload, so each forwards `requestId` with one field add per fire. This is distinct from `correlationId` (a tracing concern, ADR-adjacent to the logging guide): `requestId` is a **control** id used to route and gate, never just to trace.

### 2. Webview scopes turn state by `requestId`

`VirtualMessageGatewayActor` gains `_currentRequestId` next to `_currentTurnId` ([VirtualMessageGatewayActor.ts:75](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L75)):

- `handleStartResponse` ([:860](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L860)) records `this._currentRequestId = msg.requestId` when it mints `turn-N` at [:880](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L880).
- `handleEndResponse` ([:966](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L966)) clears the turn **only if the ids match**; a stale end is ignored explicitly:

  ```ts
  if (msg.requestId !== this._currentRequestId) {
    log.debug(`endResponse from superseded request ${msg.requestId} — ignored`);
    return;  // do NOT clear _currentTurnId at line 990
  }
  ```

- `handleShellExecuting` ([:1004](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1004)) and the other event handlers distinguish two cases instead of the single `null` drop at [:1008](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1008)–[:1011](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1011): an event whose `requestId === _currentRequestId` but with no turn is a real bug (keep the warn); an event from a **superseded** request is expected during teardown and is ignored quietly (`superseded request — ignored`, not `NO CURRENT TURN ID`). This removes the misleading drop log and, more importantly, stops a stale end from killing the live turn.

### 3. Serialize: `stopGeneration` returns a teardown promise the sender awaits

`stopGeneration()` ([requestOrchestrator.ts:1312](../../../src/providers/requestOrchestrator.ts#L1312)) returns a `Promise<void>` that resolves when the in-flight loop reaches its `finally` ([:1286](../../../src/providers/requestOrchestrator.ts#L1286)). The orchestrator holds a `_teardownDeferred` resolved at the end of the `finally`; `stopGeneration` aborts and returns that promise (already-resolved when nothing is running):

```ts
async stopGeneration(): Promise<void> {
  this._userInitiatedStop = true;
  if (this.abortController) { this.abortController.abort(); this.abortController = null; }
  this.diffManager.cancelPendingApprovals();
  this.commandApprovalManager?.cancelPendingApproval();
  this._onGenerationStopped.fire();
  return this._teardownDeferred?.promise ?? Promise.resolve();
}
```

The `sendMessage` handler ([chatProvider.ts:508](../../../src/providers/chatProvider.ts#L508)) awaits teardown of any in-flight request before starting the new one:

```ts
case 'sendMessage': {
  if (this.requestOrchestrator.isGenerating()) {
    await this.requestOrchestrator.stopGeneration();   // ◄ wait for req-A's finally
  }
  const result = await this.requestOrchestrator.handleMessage(/* req-B */ …);
  …
}
```

Because `handleMessage` now starts only after the prior `finally` has run, `abortController`, `_currentRequestId`, and `_currentTurnId` are never mutated under a still-running loop — the two-loops-overlap window in defect 2 closes, which is the window the concurrent `write_file` race needed. We explicitly **reject** a `setTimeout` sleep before starting req-B (Alternative A): a fixed delay is a guess about how long teardown takes and is flaky under load. Teardown completion is an event we can await, so we await it.

These three changes are interdependent and must ship together or behind one flag: tagging without webview scoping (1 without 2) leaves the stale-end kill in place; scoping without serialization (1+2 without 3) fixes the UI but still permits two backend loops to race on writes. The webview gracefully ignores a missing `requestId` (treats it as "always current") so a version-skewed extension degrades to today's behavior rather than dropping everything.

## Alternatives considered

### A. `setTimeout(50)` before starting the interrupting request

Sleep a fixed interval after `stopGeneration()` so the prior loop "probably" finishes its `finally`, then start the new request.

Rejected. It is the exact anti-pattern this ADR replaces with an awaited signal. 50ms is a guess: under a slow `await recordAssistantMessage` in the abort branch ([requestOrchestrator.ts:1180](../../../src/providers/requestOrchestrator.ts#L1180)) or a contended event loop it is too short (the race reopens), and on the happy path it is pure added latency on every interrupt. Teardown has a real completion point (the `finally`); awaiting it is both correct and faster.

### B. Full message queue with backpressure

Introduce a request queue with a worker that drains one request at a time, with bounded backpressure and cancellation semantics.

Rejected as over-built for this model. Moby is single-active-request by design — there is never a legitimate backlog of more than "the one running + the one interrupt." The interrupt UX (ADR 0001 / `midstream-interrupt.test.ts`) already collapses multiple rapid interrupts to the *latest* pending message. A serialize-on-await point gives the same guarantee as a one-deep queue with none of the queue machinery, lifecycle, or new failure modes. If multi-request concurrency ever becomes a feature, a real queue is the right tool then.

### C. Reuse the same UI turn for the interrupt

Treat the interrupt as a continuation of the current turn: keep `_currentTurnId`, let req-B's events flow into the existing turn rather than opening `turn-N+1`.

Rejected — they are genuinely distinct turns. The interrupt produces its own user message row and its own assistant response; ADR 0001 already persists the interrupted turn (marker-only) as a *completed* history row, and `handleStartResponse` minting a fresh `turn-N` ([VirtualMessageGatewayActor.ts:880](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L880)) is correct. Merging them would corrupt history shape and conflate two model responses. The bug is not "too many turns," it is "events routed to the wrong turn" — which `requestId` scoping fixes without collapsing turns.

### D. Stamp only `correlationId` and reuse it for control

`correlationId` already crosses the boundary in `startResponse` (logging-and-tracing guide, cross-boundary correlation). Reuse it to gate turn state instead of adding a new field.

Rejected. `correlationId` is a *tracing* id with its own lifecycle (it can be absent — `correlationId || undefined` at [requestOrchestrator.ts:823](../../../src/providers/requestOrchestrator.ts#L823) — and is set/cleared on the webview tracer independently). Overloading it as a control id couples two concerns that should stay separable: tracing can be sampled, disabled, or re-scoped without affecting turn routing. A dedicated, always-present `requestId` is the honest primitive. The two coexist (the relay forwards both).

## Consequences

**Positive:**

- Interrupting on stage no longer kills the live UI: a superseded request's late `endResponse` is ignored, so the new turn keeps streaming and its shell/tool events render instead of hitting `NO CURRENT TURN ID`.
- Closes the concurrent-write corruption path directly. Awaiting teardown before the next `handleMessage` guarantees one backend loop at a time, so two model loops can no longer race on the same `write_file` target — the 9:14pm file-clobber cannot recur from this cause. Complements ADR [0006](0006-edit-safety-checkpoint-and-validation.md), which guards a *single* loop's edits; this guarantees there is only one loop.
- Late events route or ignore deterministically by id, replacing a misleading global "NO CURRENT TURN ID" drop with an explicit, debuggable "superseded request" path.
- No change to ADR [0001](0001-stop-button-discards-partial.md) save semantics — only correlation and ordering. The `_userInitiatedStop` flag and the abort-branch persistence are untouched.

**Negative / accepted costs:**

- A new `requestId` field on every stream lifecycle event and every relay `postMessage`. Small and additive, but it touches the event type surface (`types.ts`) and every fire/forward site.
- A coordinated change spanning the **extension** (`requestOrchestrator`, `chatProvider`, `types`) **and** the **webview** (`media/`). The webview's missing-id fallback makes a partial rollout safe to *run*, but the fix is only complete when both sides ship; sequence the rollout (extension first, webview second) and keep them in one release.
- `stopGeneration` becomes `async`. Its other call sites — the reset/clear paths at [chatProvider.ts:1189](../../../src/providers/chatProvider.ts#L1189) and [:1590](../../../src/providers/chatProvider.ts#L1590) — must be reviewed; where teardown ordering matters they should `await`, where it doesn't a fire-and-forget is acceptable but should be deliberate (a floating promise lint may flag them).
- A tiny added latency on interrupt: the new request waits for the prior `finally` instead of starting eagerly. This is the *correct* wait (it was the source of the race), and on the no-interrupt path `stopGeneration` is never called.

**Follow-ups:**

- Consider extending `requestId` to the *structural* event stream (ADR [0003](0003-events-table-sole-source-of-truth.md)) so a turn's persisted events are also request-tagged, making cross-request forensics trivial on restore. Out of scope here (this ADR is the live control plane), noted there.
- Audit whether `_lastStreamingTurnId` ([VirtualMessageGatewayActor.ts:78](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L78)) — used as a fallback for late tool/approval events at [:1080](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1080) / [:1194](../../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L1194) — should also be request-scoped, or whether request scoping makes that fallback unnecessary.
- Relates to the interrupt-and-resume work cross-linked with ADR [0007](0007-system-prompt-temporal-grounding.md) (the date-check shell that hit the drop in the trace) and ADR [0011](0011-verification-gated-turn-completion.md) (a verification turn must not be ended by a superseded request's end-fire).

## Test plan

**Integration (extend existing).** `tests/integration/midstream-interrupt.test.ts` already models the interrupt flow with a local `currentTurnId` state machine; extend its `TestSystem` to carry a `currentRequestId` and have `startResponse`/`endResponse` take a `requestId`, mirroring the production scoping. Add a `describe('request-scoped lifecycle')` with:

- **stale endResponse does not end the new turn:** start req-A, interrupt → start req-B (new `requestId`, new `turn-N`), then deliver req-A's trailing `endResponse(requestId: A)`; assert `currentTurnId` is still req-B's turn and the streaming turn was **not** ended (`endStreamingTurn` not called for the B turn).
- **new-request shell/tool events are not dropped:** after the above, deliver a `shellExecuting(requestId: B)`; assert it is routed to req-B's turn (a `pushTurnActivity('shell', …)` for that turn) and **not** dropped.
- Keep the existing "only one stopGeneration" and "latest message wins" cases green — they assert the unchanged interrupt-collapse UX.

**Actor unit (add to existing dir).** Extend `tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts` (it already mocks all sub-actors) with a `describe('requestId scoping')`:

- `handleEndResponse` with `msg.requestId !== _currentRequestId` is a no-op: `_currentTurnId` unchanged, `endStreamingTurn` not called, a debug "superseded" log (not a clear).
- `handleEndResponse` with a matching id clears `_currentTurnId` and ends the turn as today (regression guard).
- `handleShellExecuting` with a superseded `requestId` is ignored quietly (no `NO CURRENT TURN ID` warn); with a matching id and an open turn it routes normally; with a matching id and **no** turn it still warns (the genuine-bug path is preserved).

**Provider unit (add).** Add `tests/unit/providers/streamLifecycle.test.ts` (vitest, the `WorkingEventEmitter`/`vi.mock('vscode')` pattern from `chatProvider.queuing.test.ts`):

- **teardown promise resolves before next handleMessage:** drive a fake in-flight request to its `finally`, assert `stopGeneration()` resolves only after the `finally` ran, and that a `sendMessage` started after `await stopGeneration()` does not begin `handleMessage` until teardown completed (order assertion via a shared event log).
- **requestId stamping:** assert `_onStartResponse` / `_onEndResponse` / `_onShellExecuting` fires carry a `requestId`, and that the abort/error end-fires carry the **request-start** id (snapshot), not a successor's. Co-locate with the existing `requestOrchestrator.test.ts` if it already exercises the loop; otherwise the new file keeps the lifecycle concern isolated.
- Extend the **event wiring contract** block in `tests/unit/providers/chatProvider.lifecycle.test.ts` (it already asserts payload shapes per fire) to assert the relay forwards `requestId` on `startResponse`/`endResponse`/`shellExecuting`.

Split: actor + provider cases are unit; the cross-boundary stale-end/no-drop behavior is integration.

## Documentation plan

- **Update `docs/guides/logging-and-tracing.md`.** The cross-boundary correlation section (the `setExtensionCorrelationId` flow) and the `startResponse` example each describe the `correlationId` that crosses the boundary; add a short subsection distinguishing **`requestId` (control: routes and gates turn state, always present)** from **`correlationId` (tracing: may be sampled/absent)**, and note the new field on `startResponse` / `endResponse` / `shellExecuting`.
- **Note in ADR `0003-events-table-sole-source-of-truth.md`'s follow-ups** (orchestrator to apply, not edited here) that live lifecycle events are now request-correlated and the structural/persisted stream may follow — recorded as the cross-link in this ADR's Follow-ups.
- **New doc — `docs/plans/interrupt-lifecycle.md`** capturing the 9:14pm trace, the forced sequence, and the rollout order (extension-first, webview-second, single release) as the implementation reference.
- **`CHANGELOG.md`:** add an entry under the next version — "Fixed: interrupting a running generation no longer kills the new turn's UI or spawns a second concurrent backend loop (request-scoped stream lifecycle + awaited interrupt teardown). Stream lifecycle events now carry a `requestId`."
- **Add an Index row to `docs/architecture/decisions/README.md`** for 0008 (Proposed, 2026-06-20) — the orchestrator will apply the actual README edit.
