# Pre-Release Blockers & Issues

Issues discovered during regression testing that must be addressed before v0.1.0 release.

---

## Phase 1: Quick Fixes — DONE

1. ~~**Fix #8** — Add node_modules to file watcher exclusion~~
2. ~~**Fix #1** — Sort events by timestamp before consolidation~~

## Phase 2: Correctness — DONE

3. ~~**Fix #2** — ContentTransformBuffer heredoc/shell tag awareness~~ (fixed by inline shell execution)
4. ~~**Investigate #3** — Confirm thinking-content shell tags aren't executed~~ (fixed — excluded reasoning from parsing + zero-content auto-continue)

## Phase 3: Performance — DONE

5. ~~**Fix #11** — Throttle measureTurnHeight~~ (resolved by rAF batching)
6. ~~**Fix #10** — Batch EventStateManager publications per animation frame~~
7. ~~**Fix #13** — Token batching (50ms accumulation in chatProvider)~~

## Phase 4: Regression from Phase 1-3 Fixes — DONE

8. ~~**Shell tag fragment leaking into UI**~~ — Fixed by interrupt-and-resume (Phase 6).
9. ~~**Command approval not pausing token display**~~ — Fixed by interrupt-and-resume (Phase 6).
10. ~~**Scrollbar not updating during streaming**~~ — Investigated, not a bug.

## Phase 5: Scale Failures — SUPERSEDED BY PHASE 6

All Phase 5 issues (#19-#23) were fundamental limitations of the **inline shell execution**
architecture. They have been **superseded by Phase 6 (interrupt-and-resume)**, which replaced
inline execution entirely. The stream is now aborted at `<shell>` detection — no more inline
execution races, no forced flush gymnastics, no multiple simultaneous approvals.

## Phase 6: Interrupt-and-Resume Shell Execution — DONE

Implemented interrupt-and-resume: ContentTransformBuffer detects complete `<shell>` tags via
`onShellDetected` callback, aborts the HTTP stream, executes the command (with approval if
needed), injects results into context, and starts a new API call. R1 sees real command output
before continuing.

Key implementation points:
- `ContentTransformBuffer.onShellDetected` callback + `isInsideOpenTag()` debounce guard
- `requestOrchestrator` catch block handles shell interrupt (new AbortController, parse, approve, execute, resume)
- Long-running command detection (`isLongRunningCommand()`) — ~50 regex patterns, skips servers/watchers
- Batch shell path disabled for reasoner model (`hasShell = false`) — interrupt-and-resume handles it
- Batch web search path still active (no interrupt equivalent for `<web_search>` tags)
- `generationStopped` message includes `userStopped: true` flag
- `handleGenerationStopped(userStopped)` only shows "*[User interrupted]*" when user actually clicked stop

---

## Status

| # | Issue | Priority | Category | Status |
|---|---|---|---|---|
| 1 | Event ordering in CQRS log | P0 | Correctness | ✅ Fixed — timestamp sort in consolidateForSave |
| 2 | Shell tags leaking into text | P0 | Correctness | ✅ Fixed — interrupt-and-resume |
| 3 | Shell tags in thinking content | P0 | Correctness | ✅ Fixed — excluded reasoning from shell parsing |
| 4 | Raw code visible during streaming | P0 | Correctness | ✅ Fixed — interrupt-and-resume |
| 5 | History restore broken (complex) | P0 | Correctness | ✅ Fixed — compound of #1-4 fixes |
| 6 | Shell iteration default too high | P1 | Config | Open — Phase 7 |
| 7 | Log buffer overflow | P2 | Debugging | Open — Phase 7 |
| 8 | File watcher noise | P1 | Correctness | ✅ Fixed — WATCHER_IGNORE_SEGMENTS + .git filter |
| 9 | Fixture export for complex sessions | P2 | Tooling | Open — Phase 7 |
| 10 | EventStateManager no batching | P0 | Performance | ✅ Fixed — rAF batching |
| 11 | measureTurnHeight thrashing | P0 | Performance | ✅ Fixed — resolved by rAF batching |
| 12 | ContentTransformBuffer re-scanning | P2 | Performance | Deferred — Phase 7 |
| 13 | No back pressure webview↔extension | P0 | Performance | ✅ Fixed — 50ms token batching |
| 14 | TurnEventLog unbounded growth | P2 | Performance | Deferred — Phase 7 |
| 15 | Shell tag fragment leak (Phase 4) | P1 | Correctness | ✅ Superseded — Phase 6 |
| 16 | Approval not pausing token display | P1 | Correctness | ✅ Superseded — Phase 6 |
| 17 | Scrollbar not updating during streaming | P1 | UI | ✅ Not a bug |
| 18 | Approval events missing from fixture | P2 | Correctness | Open — Phase 7 |
| 19 | Forced flushes bypass canFlushTokens() | P0 | Correctness | ✅ Superseded — Phase 6 |
| 20 | Multiple simultaneous approvals | P0 | Correctness | ✅ Superseded — Phase 6 |
| 21 | Buffer overwhelmed by heredocs | P0 | Correctness | ✅ Superseded — Phase 6 |
| 22 | Fixture export empty for complex sessions | P2 | Tooling | Open — Phase 7 |
| 23 | Code placeholder animation stuck | P1 | UI | ✅ Superseded — Phase 6 |
| 24 | R1 loop exits early (shellCreatedFiles) | P0 | Correctness | Open — Phase 7 |
| 25 | dist/ missing from Modified Files | — | Correctness | Won't fix — VS Code watcher excludes dist/ |
| 26 | Code placeholder missing heredoc filename | P2 | UI | Open — Phase 7 |
| 27 | Stop button pulse animation missing | P2 | UI | Open — Phase 7 |
| 28 | Code placeholder cycling blank entries | P2 | UI | Open — Phase 7 |
| 29 | Stats modal blank — field name mismatches | P1 | Feature | ✅ Fixed — corrected interface + API field mapping |
| 30 | User interrupted duplicated/late | P1 | Correctness | Partial — Phase 7 |
| 31 | Chat model file creation broken | P0 | Correctness | Open — Phase 7 |
| 32 | Update tests for Phase 6-7 changes | P0 | Testing | Open — Phase 7 |
| 33 | History restore shows extra content after stop + "Generation Stopped" vs "User interrupted" | P1 | Correctness | Open — Phase 7 |

---

## Phase 7: Current Work

All remaining open issues. This is the only active phase.

### P0 — Must Fix

#### 24. R1 loop exits early — incomplete task

**Problem:** After 6 iterations (pwd → ls → mkdir → cat index.html → cat style.css → 44 chars),
the loop exited because the auto-continuation guard checks `!state.shellCreatedFiles`. Since
heredoc `cat >` commands set `shellCreatedFiles = true`, the guard thinks "files were created,
task is done" and doesn't auto-continue.

**Evidence from logs:**
```
[R1-Shell] Iteration 6 complete, response length: 44 chars
[R1-Shell] Response preview: Now let's create the TypeScript source file:...
[R1-Shell] shellCreatedFiles=true, shellDeletedFiles=false
[R1-Shell] Loop exiting: iteration=5, hasCodeEdits=false, autoContinuations=0/2
```

R1 clearly wasn't done — it said "Now let's create the TypeScript source file:" and had more
heredocs to write. But the loop exited because `shellCreatedFiles` was true.

**Fix direction:** `shellCreatedFiles` should not prevent auto-continuation when the response
ends mid-sentence or is very short. Check if the last iteration's content suggests R1 wants to
continue (e.g., ends with `:`, is very short, no period at end). Or simply: always auto-continue
if the response is under ~100 chars and doesn't look like a final answer.

#### 31. Chat model (non-reasoner) cannot create files

**Problem:** The Chat model (deepseek-chat, non-R1) doesn't have the interrupt-and-resume
shell execution flow. It needs a working path for file creation via code blocks with
`# File:` headers and SEARCH/REPLACE format. This path may be broken or not fully wired up.

**Fix direction:** Test the Chat model flow end-to-end. Ensure `containsCodeEdits()` detection,
`diffManager.handleCodeBlockDetection()`, and the apply/reject flow work correctly for
non-reasoner models.

#### 32. Update tests for Phase 6-7 changes

**Problem:** Significant architectural changes (interrupt-and-resume, batch path disabled,
generationStopped flag, stats modal field fixes, Tavily client changes, long-running command
detection) need test coverage.

**Areas needing tests:**
- ContentTransformBuffer `onShellDetected` callback + `isInsideOpenTag()` debounce guard
- RequestOrchestrator shell interrupt catch block (mock abort → execute → resume)
- `isLongRunningCommand()` pattern matching
- `handleGenerationStopped(userStopped)` — only shows message when true
- Stats modal field mapping (balance.balance, totalMessages, null Tavily fields)
- Tavily client `getApiUsage()` with account-level plan data
- Batch shell path disabled (`hasShell = false` for reasoner)

### P1 — Important

#### 6. Shell iteration default too high

**Current:** `moby.maxShellIterations` defaults to 100 (effectively unlimited).
**Fix:** Change default to something reasonable (10-15). Enough for multi-file creation but
prevents runaway loops. Related to #24 — the auto-continuation logic matters more than the cap.

#### 30. "User interrupted" message duplicated and delayed

**Problem:** When the user clicks stop, two `*[User interrupted]*` messages appear.
`handleGenerationStopped` emits both a CQRS event (`text-append` + `text-finalize`) AND calls
`virtualList.addTextSegment()`. Both trigger a render, causing duplication.

**Fix:** Already partially addressed — `userStopped` flag gates the message. Still need to fix
the duplication: either emit CQRS events only (and let projection render) or call
`addTextSegment()` only (skip CQRS events for the interrupted message).

#### 33. History restore shows extra content after stop + inconsistent stop message

**Problem:** Two related issues:

1. **Extra content on restore:** When the user clicks stop during streaming, the live view
   correctly stops showing content. But on history restore, the saved response includes tokens
   that were buffered/in-flight at the time of abort — content the user never saw live. The
   extension saves the full `accumulatedResponse` including tokens that arrived between the
   abort signal and the stream actually stopping.

2. **Inconsistent terminology:** Live stop shows `*[User interrupted]*` (from gateway's
   `handleGenerationStopped`), but history restore shows "Generation Stopped" (likely from
   the extension-side save logic or a different code path). These should use the same message.

**Fix direction:**
- On abort, truncate `accumulatedResponse` to only the content that was actually flushed to
  the webview before the stop signal. Or mark the stop point and trim on save.
- Unify the stop message: find where "Generation Stopped" is emitted (likely in history save
  or `projectFull()`) and change it to match "*[User interrupted]*", or pick one term and
  use it everywhere.

### P2 — Nice to Have

#### 7. Log buffer overflow on large sessions

Temporarily increased to 50K for debugging. Reduce back to reasonable defaults before release,
or gate by devMode setting.

#### 9. Fixture export missing data for complex sessions

Fixture export had no turnEvents for complex sessions. Needs investigation into whether
`turnEventsForSave` message is size-limited or timing out.

#### 12. ContentTransformBuffer redundant re-scanning

Deferred. Lower priority after rAF batching (#10) and token batching (#13) reduced the
frequency. Could still improve by tracking last processed offset.

#### 14. TurnEventLog unbounded growth during streaming

Deferred. Mitigated by #10/#13. Could improve with incremental consolidation.

#### 18. Approval events missing from fixture/restore

Approval events may be dropped when `_currentTurnId` is null between iterations. Cosmetic —
the command was approved and results are in shell-result, but history restore loses the
approval context.

#### 22. Fixture export empty for complex sessions

Consolidated events lost content for complex sessions. Related to #9.

#### 26. Code placeholder not showing filename for `cat >` heredoc commands

The `buildCodeGeneratingHtml()` regex may not be matching heredoc filenames during streaming.
Check that the regex runs on the right content (shell command text vs. streamed text).

#### 27. Stop button pulse animation missing

CSS `stopping` class is added but animation not visible. Check that keyframes are defined
in toolbar shadow styles.

#### 28. Code placeholder cycling through blank entries

Placeholder cycles through text options with blank entries between filename appearances.
Change to static display: show filename when available, "Developing..." as default.
Remove cycling animation.
