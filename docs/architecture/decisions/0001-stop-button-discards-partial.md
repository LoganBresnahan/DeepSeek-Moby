# 0001. Stop button discards partial assistant content

**Status:** Accepted
**Date:** 2026-04-17

## Context

When the user clicks the stop button mid-stream, the extension aborts the in-flight request and saves what was streamed so far to history. Previously the saved record was `${partialContent}\n\n*[Generation stopped]*` — the partial assistant text the user saw, plus a marker.

In practice this caused unwanted content to persist. R1 sometimes streams raw text from inside SEARCH/REPLACE blocks (CSS, HTML, etc.) before the parser can route it to a code block segment. When the user stops, that raw content is already on screen and gets saved — so on reload, the messy half-stream renders again.

The user's intent when clicking stop is "don't keep doing this" — they're rejecting what's happening, not pausing for later review.

## Decision

For **user-initiated** stops (via the stop button), save **only the marker** `*[User interrupted]*` as the assistant message content. Drop the partial text.

For **backend aborts** (network errors, timeouts), keep the existing behavior: save `${partialContent}\n\n*[Generation stopped]*`. This preserves partial work for forensics in failure cases the user didn't intend.

The marker is determined by the `_userInitiatedStop` flag on `RequestOrchestrator`, set in `stopGeneration()` and reset on each new request.

## Alternatives considered

### A. Save partial content with a "discarded" flag
Save the partial content to the DB but tag it as discarded. The history renderer would skip rendering the content but the data is preserved.

Rejected because: the data has no observable use case. The user demonstrated they didn't want it by stopping. Trace logs already capture raw stream content if forensics are ever needed. Adding a flag means schema and renderer changes for no real benefit.

### B. Keep the existing behavior (save partial content)
Status quo. User has to manually delete or fork around the bad content.

Rejected because: the bad content is exactly what the user was rejecting. Persisting it defeats the user's action.

### C. Pattern-match and strip "obviously bad" partial content
Detect raw SEARCH/REPLACE markers, raw CSS/HTML, etc. in the partial and strip them.

Rejected because: heuristic, fragile, and the user might also stop for other reasons (response too long, wrong direction). The cleanest signal is the user's intent: they pressed stop.

## Consequences

**Positive:**
- Stopping mid-stream cleanly removes the unwanted content from history. Restoring the session shows the marker, not the dump.
- Backend errors still save partial content for debugging.
- No schema change required.

**Negative / accepted costs:**
- If a user stops for "I want to keep what's there but pause," they lose the content. We assume this is rare — pause-style stops aren't a feature; the user can always reread the message they sent and prompt again.
- Reasoning iterations and file modifications are still saved (they go through separate code paths), so the session isn't fully empty after a stop. This is intentional — those represent work that completed, not partial work-in-progress.

**Follow-ups:**
- If we ever add a "pause and inspect" mode, it should be a separate UI affordance from "stop."
