# Pre-Release Blockers & Issues

Issues discovered during regression testing that must be addressed before v0.1.0 release.

---

## P0 — Must Fix Before Release

### ~~1. CQRS Event Log Records Events in Wrong Order~~ — DONE

**Discovered:** Fixture export of simple animals.txt session showed events out of order

**Root cause confirmed:** The `TurnEventLog` appends events in **arrival order** at the webview, not in semantic/timestamp order. During R1 streaming, thinking tokens and text tokens arrive interleaved from the ContentTransformBuffer, and the event log captures them in whatever order the gateway processes them.

**Evidence from fixture export:**
```
[0] thinking-start(iter=0)      ts: 7855
[1] text-append(iter=0)         ts: 9762  ← text BEFORE thinking-content
[2] text-finalize(iter=0)       ts: 0926
[3] thinking-content(iter=0)    ts: 7856  ← thinking-content AFTER text, but timestamp is BEFORE
[4] shell-start(sh-1)           ts: 0926
```

`consolidateForSave()` preserves this arrival order. `projectFull()` then replays events in this wrong order, producing incorrect rendering on history restore.

**Impact:** For simple sessions (1-2 iterations), the ordering might be close enough. For complex sessions (7+ iterations, tictactoe test), the disorder compounds and produces all thinking bubbles grouped at the top.

**Fix options:**
- Sort events by timestamp before consolidation
- Sort events by timestamp in `projectFull()` before projection
- Fix the event append ordering in the gateway to use timestamp-based insertion

### ~~2. Shell Tag Content Leaking Into Text Stream~~ — DONE

**Discovered:** Fixture export showed shell tag fragments in text content

**Evidence:**
```
text-append content: "...with \"wolf\" as the first entry.\n\nEOF</shell>\n\n..."
text-append content: "</shell>"
```

The `ContentTransformBuffer` is not correctly stripping `</shell>` closing tags and heredoc `EOF` markers from text segments. During streaming, content that should be hidden behind shell execution is leaking into the visible text.

**Impact:** Users see raw `</shell>`, `EOF`, and other markup in the chat during live streaming. On history restore, this markup is also visible.

**Likely causes:**
- ContentTransformBuffer holdback doesn't recognize heredoc blocks inside `<shell>` tags
- Shell tag close (`</shell>`) not stripped when it arrives in a separate chunk from the open tag
- Multi-line heredoc content (cat > file << 'EOF') confuses the buffer's pattern detection

### ~~3. R1 Thinking Content Contains Shell Tags~~ — DONE

**Discovered:** Fixture export showed `<shell>` tags inside thinking-content events

**Evidence:**
```
thinking-content: "...Let me check the current directory...\n\n<shell>pwd && ls</shell>"
```

R1's chain-of-thought reasoning includes `<shell>` tags as part of its planning. These are NOT commands to execute — they're R1 thinking about what to do. But our parser may try to extract and execute them.

**Impact:** Potential double-execution of shell commands, or confusing the ContentTransformBuffer. Needs investigation to confirm whether thinking-content shell tags are actually parsed.

### ~~4. Live Streaming Shows Raw Code Behind Placeholder~~ — DONE

**Discovered:** Tictactoe game test — code output visible as raw text during streaming

**Symptoms:**
- During live streaming, code output was visible as raw text instead of being behind the "Seeking/Developing..." placeholder animation
- Code blocks with heredocs (cat > file << 'EOF') not detected correctly by ContentTransformBuffer

### ~~5. History Restore Completely Broken for Complex R1 Sessions~~ — DONE

**Discovered:** Tictactoe game test — 7 iterations, 11+ shell commands, 94K tokens

**Symptoms:**
- History restore shows all thinking bubbles grouped at the top
- Interleaving completely lost — nothing matches the live streaming order
- Scrollbar height doesn't change during restore (content height not updating)
- The tictactoe session fixture export showed NO turnEvents (likely too large to save or webview couldn't send back in time)

**Likely compound of issues 1-3 above**, amplified by session complexity.

### 6. Shell Iteration Default Too High

**Current:** `moby.maxShellIterations` defaults to 100 (effectively unlimited)
**Impact:** R1 ran 7 iterations (94K tokens) for a simple tictactoe request
**Fix:** Change default to 5 — enough for read-edit-verify but prevents runaway loops

---

## P1 — Important But Not Blocking

### 7. Log Buffer Overflow on Large Sessions

**Discovered:** Tictactoe test — 2,374 extension logs, 5,000 webview logs (capped)

**Impact:** Oldest log entries lost, making debugging harder for long sessions
**Previous limits:** Extension: 5,000 | Webview: 5,000 | Traces: 10,000
**Current limits (temporary):** All increased to 50,000 for debugging
**TODO:** Reduce back to reasonable defaults before release, or gate by devMode

### ~~8. File Watcher Noise on npm install~~ — DONE

**Discovered:** Same test — file watcher detected 1,764 modified files from node_modules

**Impact:** Floods the diff tracking with node_modules entries
**Fix:** Add node_modules to file watcher exclusion pattern

### 9. Fixture Export Missing Data for Complex Sessions

**Discovered:** Tictactoe fixture export had no turnEvents in the assistant message

**Impact:** Can't create test fixtures for complex sessions. The turnEvents either weren't saved to DB or were too large.
**Needs investigation:** Check if the webview's `turnEventsForSave` message is size-limited or timing out for large event logs.

---

## P0 — Performance Issues (Must Fix Before Release)

### ~~10. EventStateManager — No Publication Batching~~ — DONE

**Problem:** Every `text-append` token triggers a full publish → broadcast → subscriber callback → DOM update cycle. A 94K token response generates 20,000+ individual publish cycles, each walking the subscription tree synchronously.

**Impact:** UI thread saturated during heavy streaming. Contributes to the "couldn't keep up" feeling where the webview falls behind the token stream.

**Fix:** Batch state changes within a single animation frame. Accumulate publications, then flush once per `requestAnimationFrame`. This collapses thousands of per-token updates into ~60 updates per second.

### ~~11. VirtualListActor — measureTurnHeight Layout Thrashing~~ — DONE

**Problem:** `measureTurnHeight` fires on every content change — every token append, every segment render. Each call reads `getBoundingClientRect()` which forces a synchronous browser layout reflow. During heavy streaming, this creates a thrash loop: content changes → layout → measure → content changes → layout → measure.

**Evidence from logs:** Dozens of `measureTurnHeight` calls per second, many with tiny deltas (Δ+1, Δ-1).

**Fix:** Throttle height measurements to at most once per 100ms per turn. Use `requestAnimationFrame` for measurements. Batch offset recalculations.

### 12. ContentTransformBuffer — Redundant Re-scanning

**Problem:** The 150ms debounce fires constantly during streaming. Each tick re-processes the entire accumulated buffer, scanning for shell tags, code blocks, and holdback patterns. For heredoc content (hundreds of lines inside a `<shell>` tag), the same growing content is scanned repeatedly from the beginning.

**Fix:** Track the last processed offset and only scan new content on each tick. Avoid re-scanning already-emitted segments.

### ~~13. No Back Pressure from Webview to Extension~~ — DONE

**Problem:** The extension streams tokens as fast as the API delivers them via `postMessage`. The webview processes them as fast as it can. There's no signal from the webview saying "I'm falling behind." The `postMessage` queue grows unbounded during heavy streaming.

**Impact:** For a 94K token response over ~10 minutes, the webview could be processing events from 30+ seconds ago while new ones pile up. This creates the "couldn't keep up" feeling and may contribute to event ordering issues (events arriving out of order due to message queue depth).

**Fix options:**
- Chunk tokens into batches (send 10-50 tokens per `postMessage` instead of 1)
- Add a flow control signal (webview sends "ready for more" after processing each batch)
- Buffer tokens in the extension and flush on a timer (e.g., every 50ms)

### 14. TurnEventLog — Unbounded Growth During Streaming

**Problem:** Every token, thinking chunk, and shell result appends to the event log. For the tictactoe session, the log grew to 5,068 events before `consolidateForSave()` reduced it to ~25. The log is a plain array with linear growth.

**Impact:** `consolidateForSave()` iterates all 5,068 events sequentially. Not a bottleneck for normal sessions (~200-500 events) but degrades for extreme cases. Also contributes to `turnEventsForSave` message potentially being too large to send back from the webview.

**Fix:** Consider consolidating incrementally during streaming (merge consecutive text-appends in-place) rather than accumulating all events and consolidating at the end.

---

## Status

| # | Issue | Priority | Category | Status |
|---|---|---|---|---|
| 1 | Event ordering in CQRS log | P0 | Correctness | ✅ Fixed — timestamp sort in consolidateForSave |
| 2 | Shell tags leaking into text | P0 | Correctness | ✅ Fixed — inline shell execution |
| 3 | Shell tags in thinking content | P0 | Correctness | ✅ Fixed — excluded reasoning from shell parsing + zero-content auto-continue |
| 4 | Raw code visible during streaming | P0 | Correctness | ✅ Fixed — inline shell execution holds tags |
| 5 | History restore broken (complex) | P0 | Correctness | ✅ Fixed — compound of #1-4 fixes |
| 6 | Shell iteration default too high | P0 | Config | Deferred — maybe change to 5 |
| 7 | Log buffer overflow | P1 | Debugging | Temporarily increased to 50K |
| 8 | File watcher noise | P1 | Correctness | ✅ Fixed — WATCHER_IGNORE_SEGMENTS + .git filter |
| 9 | Fixture export for complex sessions | P1 | Tooling | Needs investigation |
| 10 | EventStateManager no batching | P0 | Performance | ✅ Fixed — rAF batching |
| 11 | measureTurnHeight thrashing | P0 | Performance | ✅ Fixed — resolved by rAF batching |
| 12 | ContentTransformBuffer re-scanning | P0→P2 | Performance | Deferred — lower priority after #10/#13 |
| 13 | No back pressure webview↔extension | P0 | Performance | ✅ Fixed — 50ms token batching in chatProvider |
| 14 | TurnEventLog unbounded growth | P1 | Performance | Deferred — mitigated by #10/#13 |
| 15 | Shell tag fragment leak (Phase 4) | P1 | Correctness | Partially fixed by canFlushTokens(), see #19 |
| 16 | Approval not pausing token display | P1 | Correctness | Partially fixed by canFlushTokens(), see #19 |
| 17 | Scrollbar not updating during streaming | P1 | UI | ✅ Investigated — not a bug |
| 18 | Approval events missing from fixture/restore | P1 | Correctness | See details below |
| 19 | Forced flushes bypass canFlushTokens() | P0 | Correctness | New — Phase 5 scale failure |
| 20 | Multiple simultaneous approvals corrupt state | P0 | Correctness | New — Phase 5 scale failure |
| 21 | ContentTransformBuffer overwhelmed by heredocs | P0 | Correctness | New — Phase 5 scale failure |
| 22 | Fixture export empty for complex sessions | P1 | Tooling | New — Phase 5 scale failure |
| 23 | Code placeholder animation stuck | P1 | UI | New — Phase 5 scale failure |

### #18 Detail: Approval Events Not Persisted

**Investigation findings:** The gateway DOES emit `approval-created` and `approval-resolved` turn events via `emitTurnEvent()` (lines 1065-1067, 1072+ in VirtualMessageGatewayActor.ts). `consolidateForSave()` explicitly preserves approval events ("keeps all structural events as-is").

However, the test fixture showed 0 approval events after consolidation. Likely causes:
- `handleCommandApprovalRequired()` checks `this._currentTurnId` — if the turn ID was null between iterations (e.g., during inline execution pause), the event is silently dropped
- The approval happens during the `await` in the inline executor, which pauses the streaming callback. The gateway's `_currentTurnId` may be in an inconsistent state during this pause
- The `commandApprovalResolved` message arrives after the turn has ended (approval takes user time)

**Impact:** On history restore, there's no record that a command required approval. The approval widget doesn't appear. This is cosmetic (the command was approved, results are in shell-result) but loses context about what the user decided.

**Fix direction:** Ensure `_currentTurnId` is set when inline approval events fire, or record approval events on the extension side alongside shell results.

## Implementation Priority

### Phase 1: Quick Fixes — DONE
1. ~~**Fix #8** — Add node_modules to file watcher exclusion~~
2. ~~**Fix #1** — Sort events by timestamp before consolidation~~
3. **Fix #6** — Change `maxShellIterations` default to 5 (deferred)

### Phase 2: Correctness — DONE
4. ~~**Fix #2** — ContentTransformBuffer heredoc/shell tag awareness~~ (fixed by inline shell execution)
5. ~~**Investigate #3** — Confirm thinking-content shell tags aren't executed~~ (fixed — excluded reasoning from parsing + zero-content auto-continue)
6. **Investigate #9** — Why turnEvents missing for complex sessions (not yet investigated)

### Phase 3: Performance — DONE
7. ~~**Fix #11** — Throttle measureTurnHeight~~ (resolved by rAF batching)
8. ~~**Fix #10** — Batch EventStateManager publications per animation frame~~
9. **Fix #12** — Incremental buffer scanning (deferred — lower priority after #10/#13)
10. ~~**Fix #13** — Token batching (50ms accumulation in chatProvider)~~
11. **Fix #14** — Incremental consolidation (deferred — largely mitigated by #10/#13)

### Phase 4: Regression from Phase 1-3 Fixes
12. ~~**Shell tag fragment leaking into UI**~~ — Partially addressed by `canFlushTokens()` check.
13. ~~**Command approval not pausing token display**~~ — Partially addressed by `canFlushTokens()` check.
14. ~~**Scrollbar not updating during streaming**~~ — Investigated, not a bug. Height updates correctly, scrollbar thumb is small due to large content.
15. **Command approval box shown on history restore for already-approved commands** — Cosmetic, deferred.
16. ~~**Shell tag fragment leak**~~ — Merged with #12.

### Phase 5: Scale Failures (discovered during complex tictactoe regression test)

All of the following were discovered during a 14-iteration, 50K+ token tictactoe test session.
These are **not regressions from Phase 1-3** — they are fundamental limitations of the inline
shell execution architecture that only manifest at scale.

#### 19. Forced flushes bypass `canFlushTokens()` guard

**Problem:** `flushContentTokens()` is called directly (not via timer) before `shellExecuting`,
`iterationStart`, `toolCallsStart`, and `endResponse` events. These forced flushes ignore the
`canFlushTokens()` check, sending buffered tokens to the webview while approval is pending or
the buffer is holding back partial tags.

**Impact:** Content streams visibly behind approval prompts. Shell tag fragments leak into UI.

**Fix direction:** Forced flushes should also check `canFlushTokens()`. If not safe, the tokens
should stay buffered and the lifecycle event should proceed without them.

#### 20. Multiple simultaneous approvals corrupt gateway state

**Problem:** The gateway tracks `_pendingApprovalId` as a single value. With inline execution,
approval prompts can fire in quick succession (command A needs approval, then command B arrives
while A is still pending). The second approval overwrites `_pendingApprovalId`, so when the user
resolves either one, the gateway resolves whichever ID was last stored.

**Impact:** Clicking "Allow" on one approval resolves a different approval. Multiple approval
widgets show simultaneously but share one resolution slot.

**Fix direction:** Use a Map or queue for pending approvals instead of a single ID. Each approval
gets its own slot. The gateway matches the `commandApprovalResolved` message to the correct
approval by command text or a unique approval ID.

#### 21. ContentTransformBuffer overwhelmed by large heredoc content

**Problem:** When R1 produces a single iteration with 30K+ characters (multiple large heredoc
blocks for creating files), the ContentTransformBuffer's pattern matching gets overwhelmed.
The buffer holds back content looking for `</shell>` but the content between `<shell>` and
`</shell>` is massive (entire file contents). The holdback grows unboundedly.

Meanwhile, the 150ms debounce fallback fires and releases held content as text, thinking the
stream paused. This causes heredoc content to leak into visible text segments.

**Impact:** Raw file content (TypeScript source code, CSS, HTML) appears as streamed text
in the chat UI instead of being hidden behind shell execution.

**Fix direction:** The buffer should NOT release holdback content via debounce while inside
a `<shell>` tag. Once `<shell>` is detected, ALL content should be held until `</shell>`
arrives, regardless of debounce timers. The debounce fallback should only apply to ambiguous
partial tag starts (e.g., `<` that might become `<shell>` or might be content).

#### 22. Fixture export empty for complex sessions

**Problem:** The fixture export for the tictactoe session showed assistant content as mostly
`\n\n\n\n` with no actual text between shell commands. The 3,117 turn events were consolidated
but the content was lost.

**Impact:** Cannot create test fixtures for complex sessions, making regression testing impossible.

**Root cause:** The `consolidateForSave()` function merges `text-append` events by concatenation.
But with inline execution, text segments are finalized and new segments created between shell
commands. The consolidated events may reference iteration indices that don't align with the
content iterations recorded by the extension.

#### 23. Code placeholder animation stuck after response completes

**Problem:** The "Seeking/Developing..." code block placeholder animation remained visible
after the response finished. The animation is controlled by `_isStreaming` flag — when
`endStreaming()` is called, it should re-render to remove the placeholder. But with 3,117
events and a 39K pixel turn, the final re-render may not reach all containers.

**Fix direction:** `endStreaming()` should force a full re-render of all text segments,
not rely on incremental updates reaching every container.

---

## Architectural Assessment

Phase 5 issues share a root cause: **the inline shell execution model doesn't scale to
complex R1 sessions.** The model was designed for simple sessions (1-3 iterations, a few
shell commands) where:
- Each `<shell>` tag is small and arrives quickly
- Approvals are sequential (one at a time)
- Content between shell tags is short
- The total response is under 10K characters

For complex sessions (14 iterations, 30+ shell commands, 50K+ tokens), these assumptions break:
- Heredoc blocks inside `<shell>` tags contain thousands of characters
- Multiple approvals queue up while earlier ones await user input
- The ContentTransformBuffer's 150ms debounce fires mid-heredoc
- Turn event counts reach 3,000+ causing consolidation artifacts

**Options:**
1. **Fix each symptom individually** — patch the forced flush, approval queue, buffer debounce, and consolidation. This addresses the immediate issues but the architecture remains fragile at scale.

2. **Hybrid approach** — Keep inline execution for simple commands (single-line, non-heredoc) but fall back to batch execution for complex iterations (those with heredocs or multiple commands). The batch path already handles these correctly because it processes the full response after streaming completes.

3. **Rate-limit R1 iterations** — Set `maxShellIterations` to 5 (deferred #6). This prevents the most extreme cases but doesn't fix the architectural issues — a single iteration with 10 heredoc blocks would still break.

4. **Interrupt-and-resume** — Stop the stream when a `<shell>` tag is detected, execute the command, inject the result, and start a new API call. See Phase 6 below.

---

## Phase 6: Interrupt-and-Resume Shell Execution (Prototype Design)

### Concept

Instead of executing shell commands during or after streaming, **abort the stream** when a
`<shell>` tag is detected. Execute the command, then start a new API call with the partial
response + command result in context. R1 sees actual results before continuing.

This is how Claude Code handles tool calls — each tool use interrupts the response and
the model resumes with real data.

### Current Flow (Inline)
```
R1 streams: "Let me check.\n<shell>cat file</shell>\nNow I'll edit.\n<shell>cat > file << 'EOF'...</shell>\nDone."
                    ↓                                      ↓                                                    ↓
              text displayed                    command executed inline                              text displayed (speculative!)
                                                 (R1 doesn't see result)                            (assumes success)
```

### Proposed Flow (Interrupt-and-Resume)
```
R1 streams: "Let me check.\n<shell>cat file</shell>"
                    ↓
              ContentTransformBuffer detects complete <shell> tag
              → Abort the HTTP stream (signal.abort())
              → Flush text before tag: "Let me check."
              → Execute command: cat file → output: "wolf\nbear"
              → Show shell dropdown with result
              → Inject into context: assistant partial response + command result
              → Start NEW API call

R1 sees: "Let me check.\n[shell: cat file → wolf\nbear]"
R1 streams: "The file has wolf and bear. I'll add fox.\n<shell>cat >> file << 'EOF'..."
              → Same process repeats
```

### Implementation Plan

#### Step 1: ContentTransformBuffer — Shell Tag Abort Signal

Add a callback that fires when a complete `<shell>...</shell>` tag is detected:

```typescript
interface ContentTransformBufferOptions {
  // ... existing
  onShellDetected?: (command: string, textBefore: string) => void;
}
```

When the buffer detects a complete shell tag:
1. Emit `textBefore` as a final text segment
2. Call `onShellDetected(command, textBefore)`
3. Do NOT emit the shell tag content as text

#### Step 2: RequestOrchestrator — Abort and Queue

In `streamAndIterate`, when `onShellDetected` fires:

```typescript
// In the onToken callback or via a flag:
this._shellInterruptCommand = command;
this._shellInterruptTextBefore = textBefore;

// Abort the current stream
this.abortController?.abort();
```

The abort causes `streamChat` to throw `AbortError`. In the catch block, detect
that this was a shell interrupt (not a user stop):

```typescript
catch (error) {
  if (this._shellInterruptCommand) {
    // This was a shell interrupt, not a user abort
    const cmd = this._shellInterruptCommand;
    this._shellInterruptCommand = null;
    
    // Execute the command (with approval if needed)
    const result = await this.executeShellCommand(cmd, signal);
    
    // Build context for resume
    currentHistoryMessages.push({
      role: 'assistant',
      content: this._shellInterruptTextBefore
    });
    currentHistoryMessages.push({
      role: 'user', 
      content: `Shell command result:\n$ ${cmd}\n${result.output}`
    });
    
    // Continue the do/while loop — starts a new API call
    continue;
  }
  
  // Normal abort handling...
}
```

#### Step 3: Clean Up Inline Execution Code

Remove:
- `_pendingInlineShellCommands` queue
- `_inlineExecutedCommands` dedup set
- `_inlineExecutionPromise` tracking
- `_approvalPending` / `_heldTokens` / `_heldSegments` buffering
- Inline execution inside `onToken` callback
- `canFlushTokens()` coordination
- Forced flush gymnastics in chatProvider

The `onToken` callback becomes simple again — just append tokens and stream to UI.
Shell tags never reach the UI because the stream is aborted before the text after them.

#### Step 4: Approval Flow

With interrupt-and-resume, approval is clean:

1. Stream aborts at `<shell>` tag
2. Text before the tag is displayed
3. Shell dropdown appears with "Running..." or approval prompt
4. User decides (if needed)
5. Command executes
6. Result shown in dropdown
7. New API call starts — R1 resumes with knowledge of the result

Only ONE command is ever pending at a time. No race conditions. No multiple approvals.

### What This Fixes

| Issue | How Interrupt-Resume Fixes It |
|-------|-------------------------------|
| #15 Shell tag fragment leak | Tags never reach UI — stream aborts before text after tag |
| #16 Approval not pausing display | Stream is stopped — nothing to display during approval |
| #19 Forced flushes bypass guard | No forced flushes needed — stream is stopped |
| #20 Multiple simultaneous approvals | Only one command pending at a time |
| #21 Buffer overwhelmed by heredocs | Heredoc content is in the aborted stream, never reaches buffer |
| #23 Placeholder animation stuck | Each stream has clean start/end lifecycle |
| Speculative text | R1 sees real results, no "file updated" lies |

### What This Doesn't Fix

| Issue | Why |
|-------|-----|
| #18 Approval events in fixture | Still need to record approval events |
| #22 Fixture export empty | Separate issue with consolidation |
| Cost/latency | More API calls, higher token usage |

### Performance Considerations

**Token usage:** Each interrupt means the partial response is sent back as context.
For a session that currently has 3 iterations × 10 shell commands = 30 commands,
the interrupt approach would make ~30 API calls. Each call includes growing context.

**Mitigation:**
- The partial response before a `<shell>` tag is usually short (1-3 sentences)
- R1's reasoning tokens are NOT re-sent (they're ephemeral)
- Content tokens are smaller per call (each call produces less content before the next interrupt)
- Net token usage may not increase much — same total content, just spread across more calls

**Latency:** Each interrupt adds ~1-2 seconds (abort + new API call setup + first token).
For 30 commands, that's ~30-60 seconds of added latency over the session.

**Mitigation:**
- Simple commands (`pwd`, `ls`) execute in <100ms — the API call overhead is the bottleneck
- Could batch simple consecutive commands: if R1 outputs `<shell>pwd</shell>\n<shell>ls</shell>`,
  detect both before aborting and execute them together

### Prerequisite Fix

Before implementing interrupt-and-resume, fix the ContentTransformBuffer debounce (#21):
- Track `_insideShellTag` state
- Don't release held content via debounce while inside a shell tag
- This fix is needed regardless of which approach we choose

### Implementation Order

1. **Fix ContentTransformBuffer debounce** (needed for both approaches)
2. **Add `onShellDetected` callback to buffer** (detection without execution)
3. **Wire abort-on-shell in requestOrchestrator** (stop the stream)
4. **Add resume logic** (inject partial response + result, start new call)
5. **Remove inline execution code** (clean up)
6. **Test with simple sessions** (1-2 commands)
7. **Test with complex sessions** (tictactoe test)
8. **Handle edge cases** (multiple shell tags before abort registers, web_search tags)
