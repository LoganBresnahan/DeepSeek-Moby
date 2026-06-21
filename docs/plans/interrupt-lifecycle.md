# Interrupt Lifecycle

How Moby handles a user interrupting a running generation, and why the stream lifecycle is request-scoped. Implementation reference for [ADR 0008](../architecture/decisions/0008-request-scoped-stream-lifecycle-and-interrupt-teardown.md).

## The failure it fixes

A traced on-stage session (the 9:14pm trace, and again in the 16:06 trace) showed an interrupt that began as a cosmetic glitch and ended in data loss:

1. A generation (`req-A`) is streaming.
2. The user types a new message and submits — the webview sends `stopGeneration`, then sends the queued message.
3. The new turn (`req-B`) renders briefly, then the live UI goes dead — tool/shell events stop appearing and the log fills with `shellExecuting: NO CURRENT TURN ID — dropping message!`.
4. Worse: `req-A`'s backend loop never actually stopped, so **two model loops ran concurrently** and raced on the same `write_file`, clobbering a file down to an empty shell.

Two independent defects combined:

- **Teardown was not awaited.** `stopGeneration()` aborted and returned immediately; `generationStopped` fired before the loop had unwound. The webview then sent the queued message, so `req-B`'s `handleMessage` began while `req-A` was still inside its `catch`/`finally` — two loops overlapped.
- **Lifecycle events had no request identity.** The webview tracked a single global `_currentTurnId`. `req-A`'s trailing `endResponse` cleared it — but by then it was `req-B`'s turn, so the live turn was killed, and `req-B`'s shell events then hit `NO CURRENT TURN ID`.

## The forced sequence (pre-fix)

```
req-A streaming ─ user interrupts ─ stopGeneration() aborts A (returns immediately)
req-B handleMessage starts (concurrent) ─ startResponse(B) ─ webview turn-2 opens
req-A's trailing endResponse fires ─ webview clears _currentTurnId (turn-2!)   ◄ wrong turn ended
req-B's shell fires ─ _currentTurnId === null ─ "NO CURRENT TURN ID" drop
req-A's loop never truly stopped ─ two loops race on the same write_file ─ file clobbered
```

## The fix

Two layers (see the ADR for the full decision and alternatives):

### 1. Awaited teardown serialization — the keystone

`stopGeneration()` is `async` and fires `generationStopped` only **after** the in-flight loop reaches its `finally` (a per-turn `_teardownDeferred` resolved there). Because the webview gates the next send on `generationStopped`, the next turn can't begin while the prior loop is still alive — and the `sendMessage` handler additionally tears down + awaits any in-flight turn before starting, covering a bare concurrent send. **Only one `handleMessage` loop ever runs**, which closes the concurrent-`write_file` race at the source. With one loop and `postMessage`'s in-order delivery, `req-A`'s `endResponse` reaches the webview *before* `req-B`'s `startResponse`, so it clears the correct turn — the dead-UI symptom is resolved too.

### 2. Request-scoped lifecycle events — defense-in-depth + diagnostics

Every turn carries a `requestId` (minted in `requestOrchestrator`, exposed via `currentRequestId`). The chatProvider relay stamps it on `startResponse` / `endResponse` / `shellExecuting` — read **synchronously at fire time**, so a dying request's late event carries its own id. The webview (`VirtualMessageGatewayActor`) routes by it:

- a late `endResponse` whose `requestId` ≠ the current one is **ignored** (it never clears the live turn);
- a superseded request's shell event is **dropped quietly** (`debug`), not logged as the misleading `NO CURRENT TURN ID` (which is now reserved for the genuine "current request, no turn" bug);
- a missing `requestId` (version-skewed extension) falls through to the prior unconditional behavior.

This makes correctness depend on event **identity** rather than on the timing invariants layer 1 relies on (one-loop-at-a-time, no event escaping the teardown window, an in-order relay) — so a future regression in any of those degrades to a quiet, logged "superseded request — ignored" instead of recurring as an intermittent, hard-to-diagnose dead UI.

## Rollout

The two layers are independent and were shipped in sequence on one branch: the teardown serialization first (it alone closes the bug under today's invariants), then the `requestId` scoping (hardening). The webview tolerates a missing `requestId`, so an extension-first / webview-second partial rollout degrades to today's behavior rather than dropping events; ship both in one release.

## Tests

- Teardown ordering: `generationStopped` fires only after the loop's `finally` ([tests/unit/providers/requestOrchestrator.test.ts](../../tests/unit/providers/requestOrchestrator.test.ts), `describe('stopGeneration')`).
- requestId scoping: a stale `endResponse` is a no-op, a matching one clears, a superseded shell isn't routed, and a missing id stays back-compatible ([tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts](../../tests/actors/message-gateway/VirtualMessageGatewayActor.test.ts), `describe('requestId scoping (ADR 0008)')`).
- The interrupt-append UX (queue → stop → send, latest-message-wins) stays green in [tests/integration/midstream-interrupt.test.ts](../../tests/integration/midstream-interrupt.test.ts).
