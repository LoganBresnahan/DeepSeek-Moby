# Improve file-corruption handling

**Status:** Diagnosis complete. Remediation in [ADR 0006](../architecture/decisions/0006-edit-safety-checkpoint-and-validation.md) (reference: [edit-safety.md](../architecture/integration/edit-safety.md)) — **implemented (Phases 1–3)**: checkpoint, atomic batch, and the validation gate with *differential (error-set) attribution* against a pre-edit baseline now ship; the latent SSE-buffering bug (item 6) is fixed.
**Date:** 2026-06-18 (diagnosis); 2026-06-19 (remediation spec)

## TL;DR

The file "corruption" we keep chasing is **the model emitting clean-but-wrong JSON
tokens**, applied faithfully by the diff engine — it is **not** a diff-engine bug and
**not** a streaming/parse bug in the extension. The `a5b71c1` hard-fail refactor was
correct, but it hardened the *no-match* path, while the actual failure mode is
*SEARCH matches, REPLACE is garbled*. There is no layer guarding that case today; that
missing layer (a post-apply validation gate) is the real fix. Separately, there is a
genuine latent SSE-buffering bug that did **not** cause this incident but should be
fixed so it never confuses future triage.

This doc is grounded in one fully-traced run: `deepseek-v4-pro-thinking`
(→ `deepseek-v4-pro`, `reasoning_effort=max`) building a "Pig Dice Game" Blazor slide,
2026-06-18 22:10–22:17, log
`~/.vscode-server/data/logs/20260618T221012/exthost1/LoganBresnahan.deepseek-moby/DeepSeek Moby.log`.

## What the data shows

Run shape: 41 API iterations, ~7m08s wall-clock, 9 `edit_file` calls across 8 fix
rounds, ~24 distinct garbled tokens, ending on a clean `dotnet build`. It converged
mostly because later full-file `write_file` rewrites blew away garbled regions
wholesale — not because the patches were reliably clean. Passing *despite* the model,
via build-driven self-healing.

The garble is in the model's raw output bytes, in both `edit_file` REPLACE strings and
`write_file` content payloads. Representative sample (all written verbatim, then later
repaired):

| Garbled (model emitted) | Correct | Where |
|---|---|---|
| `border-color:(--accent);` | `border-color: var(--accent);` | css REPLACE/write |
| `}\n.dice-player.active {` (literal `\n`, two chars) | real newline | css write |
| `0%, 100% { opacity 1; }` | `opacity: 1;` (missing colon) | css write |
| `border: 16px;` | `border-radius: 16px;` (property name truncated) | css write |
| `transform: rotate(0deg) scale();` | `scale(1);` (arg dropped) | css write |
| `.dice-turn-scoreost {` | `.dice-turn-score.lost {` | css write |
| `.dice.hold {` | `.dice-btn.hold {` | css write |
| `@(_gameOver && _ == 1 ...)` | `_winner` (identifier truncated to `_`) | razor write |
| `classdice-player-name` | `class="dice-player-name"` | razor write |
| `StateChanged();` | `StateHasChanged();` | razor write |
| `_turn += _dieValue;` | `_turnScore += _dieValue;` | razor write |

**Whack-a-mole is the smoking gun.** The iter-15 "Fix 5 compilation errors" edit
correctly repaired four garbles (`_`→`_winner`, `""`→`"active"`,
`classdice-player-name`→`class="dice-player-name"`, inserted a missing `&&`) — but in
the *same* REPLACE it re-truncated `_turnLost` to `_Lost`, forcing a dedicated
follow-up edit at 22:16:04 to undo it. A mechanical SEARCH/REPLACE engine cannot
*manufacture* `_Lost`; it can only write what the model sent. One fix call directly
spawned the next.

## Diagnosis

### 1. The corruption is model-side; the engine applies it faithfully

On an exact-match apply, [diff.ts:144](../../src/utils/diff.ts#L144) does
`content = content.replace(block.search, block.replace)` — native JS `String.replace`
with the model's REPLACE string, byte-for-byte, logged as "Applied via exact match"
([diff.ts:146](../../src/utils/diff.ts#L146)). Across the 6 successful calls every
matched block reported success (2/2, 1/1, 5/5, 1/1, 1/1). The engine never normalized
or mutated content. Whatever the model put in REPLACE lands on disk unchanged.

### 2. Why the `a5b71c1` refactor didn't help

`a5b71c1` removed `locationBasedReplace` (the anchor-reconstruction splice — the one
real engine-side corruption vector) and added the stale-content hard-fail. That stops
the most dangerous mode and the retry-then-corrupt amplifier. But it only guards the
**no-match** path: when no strategy matches, `applySearchReplace` returns
`success:false` and [diffManager.ts:992](../../src/providers/diffManager.ts#L992)
returns `false`, surfacing the re-read nudge at
[requestOrchestrator.ts:2345](../../src/providers/requestOrchestrator.ts#L2345).

Our actual failure mode is **SEARCH matches, REPLACE is garbled** (appends, tiny
searches that apply via exact match). Once SEARCH matches — even loosely via the
whitespace-tolerant `compareLine` at [diff.ts:280](../../src/utils/diff.ts#L280) — the
entire REPLACE, garble and all, is spliced in. The corruption never flows through the
path the refactor hardened, so the refactor structurally cannot touch it.

It *did* earn its keep once this run: the iter-28 stale-content hard-fail (SEARCH
similarity 0.01 < 0.75 threshold, [diff.ts:166](../../src/utils/diff.ts#L166)) rejected
an edit whose REPLACE carried a brand-new `rgba(76, 139 245, .3)` missing-comma garble —
keeping it off disk. Real, but incidental to the dominant failure mode.

### 3. Model-vs-harness: conclusively model-fidelity

The arg pipeline is byte-faithful: [httpClient.ts:176-177](../../src/utils/httpClient.ts#L176)
emits raw chunks → [deepseekClient.ts:693](../../src/deepseekClient.ts#L693)
`acc.argumentsStr += tcDelta.function.arguments` →
[requestOrchestrator.ts:2597](../../src/providers/requestOrchestrator.ts#L2597)
`JSON.parse(toolCall.function.arguments)` into the diff. No escape/unescape/re-stringify
between assembly and the diff engine.

The decisive discriminator is the lone literal `\n` (backslash-n) sitting amid
otherwise-correct newlines in the CSS REPLACE. Our only transform is `JSON.parse` +
concat, which turns escaped newlines into real ones and **never re-escapes** — a harness
re-escape bug would corrupt *every* newline uniformly, not exactly one. A single
localized double-escape can only come from the model's own wire bytes: a per-token
serialization slip. Every other reported signature (`var(--accent)`→`(--accent)`,
`border-radius`→`border`, missing colon, `_winner`→`_`) is an *interior* edit that still
parsed cleanly and matched exactly — the model emitting clean-but-wrong JSON, not the
pipeline dropping bytes. **Verdict: model-fidelity** — `deepseek-v4-pro` @
`reasoning_effort=max` dropping/mangling tokens while serializing its own tool-call args
(classic quantization/sampling artifact).

## The real latent bug (separate; did NOT cause this incident)

[deepseekClient.ts:624](../../src/deepseekClient.ts#L624) splits each chunk on `\n` with
**no cross-chunk carryover buffer**:

```js
const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
```

The transport ([httpClient.ts:169-177](../../src/utils/httpClient.ts#L169)) emits raw
`Buffer.from(value)` per `reader.read()` with no line framing. So when one `data:` SSE
frame straddles a TCP/chunk boundary:

- the truncated tail of chunk N fails `JSON.parse` (swallowed at the try/catch), and
- the head of chunk N+1 doesn't start with `data: `, so it's silently dropped.

Result: the **entire delta** vanishes (reproduced: empty `arguments`). A multibyte
UTF-8 char split across a Buffer boundary also yields U+FFFD via `toString()`. This is a
*coarse* whole-delta loss that usually breaks `JSON.parse` — which is exactly why it
cannot produce the fine-grained, cleanly-parsing corruptions above, and why it's ruled
out as the cause here. But it is a real wholesale-drop waiting on a network boundary and
should be fixed so it never gets confused with model garble in future triage.

**Fix:** accumulate a residual buffer across chunks; only split off complete lines, keep
the trailing partial for the next chunk. Decode bytes through a streaming UTF-8 decoder
(e.g. `TextDecoder({stream:true})`) rather than per-chunk `toString()`.

## Remediation plan (prioritized against the real root cause)

1. **Instrument the generation boundary.** Log the raw REPLACE / `write_file` content
   the moment it exits `finalizeToolCalls` ([deepseekClient.ts:569](../../src/deepseekClient.ts#L569)),
   before the diff sees it. Yields a per-model, per-`reasoning_effort` corruption-rate
   metric and ends the misattribution to the diff path.

2. **Add a post-apply validation gate — the actual missing layer.** ✅ **Implemented.**
   After a batch of edits applies, run the *project's own* check command (the `dotnet build`
   we already run, discovered from workspace markers — no bundled language parsers) and,
   on a *new* error versus the pre-edit baseline, **revert to a checkpoint** and feed the
   scoped errors back to the model. Attribution is *differential* — a normalized error-set
   diff against a baseline measured on the pristine tree — so it works from any starting
   state (clean or already-broken) and reverts only edits that make the tree measurably
   worse. Makes "applied" mean "applied and verified." Auto stays Auto: on an exhausted
   repair budget the turn **halts** (never demotes to Ask — Alternative G). Specified and
   built in [ADR 0006](../architecture/decisions/0006-edit-safety-checkpoint-and-validation.md)
   ([edit-safety.md](../architecture/integration/edit-safety.md)).

   **Extended to the turn boundary ([ADR 0011](../architecture/decisions/0011-verification-gated-turn-completion.md)). ✅ Implemented.**
   The batch gate above catches "applied but broke the build." It does **not** catch
   *build-pass ≠ artifact-produced*: in the `914pm` trace `Slide3Demo.razor` was clobbered
   to an empty `<div>`, which **compiles fine**, so the verdict was `clean` and the turn
   completed "successfully" (the user had to ask to restore it the next session). ADR 0011
   re-consults the last batch verdict at the loop's *terminal stop* and adds a
   language-agnostic **artifact-presence check** — a file the turn just wrote that reads
   back empty holds the turn open for one bounded repair pass. So "done" now means "built
   and the deliverables are present + non-empty," not just "the last edit compiled."

3. **Attack the source.** Corruption tracks `deepseek-v4-pro` @ `reasoning_effort=max`.
   Re-run the same task at lower effort / lower temperature, and — if this is a
   local/quantized serve — a higher-precision quant. Localized double-escapes and dropped
   chars in JSON serialization are textbook quantization/sampling slips.

4. **Bias high-churn files toward full `write_file`.** This run converged via wholesale
   rewrites; the small patches are what spawned fresh garble (the `_Lost` loop). Fewer
   independent REPLACE strings = fewer garble dice rolls.

5. **Close the partial-match gap the refactor left.** Require a minimum SEARCH length /
   uniqueness check before allowing an apply, so a short SEARCH can't splice a REPLACE
   into the wrong region.

6. **Fix the latent SSE-buffering bug** at [deepseekClient.ts:624](../../src/deepseekClient.ts#L624)
   (see above). Independent of the corruption work; do it so the two failure classes stay
   distinguishable. ✅ **Done** — buffered line framing + streaming UTF-8 decode shipped on
   branch `fix/sse-chunk-boundary-buffering` with 6 regression tests.

## References

- Run log: `~/.vscode-server/data/logs/20260618T221012/exthost1/LoganBresnahan.deepseek-moby/DeepSeek Moby.log`
- Refactor under discussion: commit `a5b71c1` "fix(diff): hard-fail unmatched edits instead of force-applying them"
- Exact-match apply: [diff.ts:144](../../src/utils/diff.ts#L144) · stale-content hard-fail: [diff.ts:166](../../src/utils/diff.ts#L166) · whitespace-tolerant match: [diff.ts:280](../../src/utils/diff.ts#L280)
- Auto-apply return-false: [diffManager.ts:992](../../src/providers/diffManager.ts#L992) · re-read nudge: [requestOrchestrator.ts:2345](../../src/providers/requestOrchestrator.ts#L2345)
- Arg assembly: [deepseekClient.ts:693](../../src/deepseekClient.ts#L693) · parse into diff: [requestOrchestrator.ts:2597](../../src/providers/requestOrchestrator.ts#L2597) · raw chunk emit: [httpClient.ts:176](../../src/utils/httpClient.ts#L176)
