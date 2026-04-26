# 0004. R1 path-semantics guards and model-specific guard policy

**Status:** Accepted
**Date:** 2026-04-20

## Context

R1 uses two file-writing mechanisms with **different relative-path semantics**, and has no built-in way to reconcile them:

1. **Shell `cat > file << EOF` heredocs** — each `<shell>` invocation runs in a fresh shell. A `cd X` in one `<shell>` block does not persist to the next. Files written in a later block land at workspace root unless the `cd` is in the same block.
2. **SEARCH/REPLACE code blocks with `# File: path` headers** — always applied workspace-root-relative by the diff engine. The header's path is *literal*; there is no "current directory" the diff engine consults.

A real test session (captured in traces at [docs/plans/](../../plans/) area, 2026-04-20) showed R1 creating `tictactoe-ts/` with `mkdir -p tictactoe-ts/src tictactoe-ts/dist\ncd tictactoe-ts` in one shell, then writing `package.json`, `tsconfig.json`, `index.html` in *subsequent* shells that assumed cwd had persisted. Same turn, SEARCH/REPLACE blocks wrote `src/index.ts` and `style.css` at workspace root. R1 then spent 12+ iterations running `cd tictactoe-ts && npm run build` against a directory that had no source files, rewriting the file repeatedly, and eventually producing duplicate identifiers. User halted the turn.

The event-sourcing persistence (ADR 0003) handled the thrash correctly — every shell, approval, and file modification landed in the events table; the user's abort saved a clean marker per ADR 0001. The system's structure was not at fault; R1's mental model of where files landed was wrong and never got corrected.

Two levers were available:

- **Prompt clarity** — tell R1 the rules explicitly.
- **Tool-result ground truth** — tell R1 where files actually landed after each shell command, with absolute paths, so mid-turn self-correction is possible.

A third lever — **detector-style guards** (thrash detection, auto-halt on repeated writes, etc.) — was also on the table but deferred (see Alternatives).

## Decision

Ship two complementary guards, both narrowly scoped to R1:

**A. Four path rules in `getReasonerShellPrompt()`.** Added explicitly to R1's system prompt:
1. `# File:` headers are always workspace-root-relative.
2. Shell `cd` does not persist between `<shell>` invocations.
3. To write into a subdirectory, pick *one*: single-block `cd subdir && cat > ...`, or explicit path `cat > subdir/file.ts`, or `# File: subdir/file.ts`.
4. Trust the absolute paths in each tool result over any assumption about cwd.

**B. Absolute-path ground truth in shell tool results.** `formatShellResultsForContext()` gained an optional `{ modifiedFiles, deletedFiles, workspacePath }` parameter. When supplied, the injected result appends a `--- Files touched by this command (absolute paths) ---` section listing each changed file with its fully resolved absolute path. Wired at three call sites in [requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts) (post-stream interrupt, main R1 shell interrupt, batch path). The fourth call site — inline-executed results being re-emitted — was intentionally skipped: those results were already delivered with paths on first injection, and per-command attribution isn't tracked at that point.

**Policy: tool-surface improvements vs. detector-style guards.** Improvements to the *tool surface* (clearer prompts, ground-truth feedback, better error shapes) are model-agnostic in spirit even when implemented on one path — they survive model changes because they make the tool better, not the model smarter. Detector-style guards (repeat-write detection, auto-halt on same error, etc.) are inherently model-specific — they assume a failure mode that's native to one model's habits and are likely noise or wrong-shape for stronger models. Detectors will only be built when real usage produces traces of a failure mode that prompt clarity + ground-truth feedback did not address.

## Alternatives considered

### A. Shell cwd persistence across `<shell>` invocations

Make `cd` actually persist within a turn so R1's mental model matches reality. Matches typical terminal semantics.

Rejected — for now — because the surface is larger than it looks. Open questions: where does cwd reset (per turn? per session? per fork?), how does it survive interrupt-and-resume, does the UI display it, what happens if R1 `cd`s to a non-existent directory, does it leak into the Chat path if a model ever gets both. Real change to extension semantics that deserves its own ADR if we pursue it. The prompt-clarity route closes most of the user-visible pain without the architectural commitment.

### B. Thrash / repeat-write detection

Track per-path write counts per turn; if R1 writes the same file twice with ≥90% content overlap, halt or inject a "you wrote this file earlier, read it first" nudge.

Rejected as premature. Without real traces of non-path-related thrash, we don't know which detector shape matches the actual failure distribution. Building detectors blind risks false positives that frustrate more than occasional thrash. Data-gated: revisit if traces after A+B show thrash from triggers other than path confusion (e.g., unparseable compiler errors, test oscillation, phantom errors — enumerated in the strategy conversation but not yet observed in our traces).

### C. Drop R1 support entirely

Retire the `<shell>` / SEARCH-REPLACE protocol, ship Chat-only.

Rejected — for now — because Chat's tool surface is currently weaker than R1 for agentic work. Chat can't create or delete files (planned work, [CLAUDE.md](../../../CLAUDE.md)). Dropping R1 before Chat reaches parity cuts off the only agentic option. The path forward is **Chat parity first, then reconsider R1's status.** Gated on the write_file / delete_file work.

### D. Comment model-scope inline in the prompt text

Put "(V4 with native tools won't need these rules)" inside the prompt template.

Rejected immediately after trying it — HTML comments inside a template literal are sent *to the model* as part of the prompt. Model-scope commentary belongs in source-code comments, not prompt text. The TS docstring on `getReasonerShellPrompt()` now carries it.

## Consequences

**Positive:**
- Path-confusion thrash (the observed failure mode) has two independent lines of defense: R1 knows the rules, and if it violates them anyway the tool result tells it where files actually landed. Self-correction mid-turn becomes possible.
- B's pattern is model-agnostic even though its implementation is R1-specific. When Chat's `edit_file` tool result grows richer feedback, the same "absolute path of what changed" shape transfers directly.
- No detector-style guards ship. No false-positive risk, no model-specific tuning cost, no "guards rotting as V4 changes behavior" liability.
- Policy articulated: future "should we build a guard?" debates have a test — is it tool-surface or detector? Tool-surface wins by default; detectors require data.

**Negative / accepted costs:**
- A+B may not be sufficient. If R1 still thrashes in path-unrelated ways, we'll need detectors we've deferred — and we won't have started building them.
- A is dead weight if V4 supports native tool calling. `getReasonerShellPrompt()` is gated behind `isReasonerModel()` so it doesn't leak, but the file exists to be retired someday.
- The fourth `formatShellResultsForContext` call site (inline-executed re-emission, [requestOrchestrator.ts:1932](../../../src/providers/requestOrchestrator.ts#L1932)) is not wired. Low severity — the info arrives on the main interrupt path — but not fully uniform. Documented at the call site.

**Follow-ups:**
- Observe next R1 sessions for thrash patterns. If path-confusion is closed but new shapes emerge, capture traces and revisit the detector question with data.
- When Chat grows `write_file` / `delete_file`, apply the B pattern to Chat's tool-result builders. That's the first test of whether the policy holds — is the B pattern genuinely model-agnostic, or does it need adaptation?
- Giant-command approval UX (24KB heredoc preview was unreviewable). Not this ADR — separate UX issue tracked in CLAUDE.md.
- ADR 000X (future): if we do move to persistent shell cwd, that's a semantic change worth its own record.
