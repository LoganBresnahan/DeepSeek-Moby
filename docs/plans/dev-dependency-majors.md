# Dev-dependency major bumps — 10 Dependabot alerts, 4 majors

**Status:** planned (2026-08-12). Follows the `/dep-audit` safe-tier pass
(`a5925d0`), which closed 25 of 35 alerts mechanically. These four are what's
left, and none of them is mechanical.

**Scope:** `happy-dom ^15→20`, `vitest ^2→3` (+ `@vitest/ui`,
`@vitest/coverage-v8`, transitively `vite 5→7`), `esbuild ^0.19→0.25`,
`copy-webpack-plugin ^13→14`.

---

## Why this is a plan and not a `npm audit fix`

`npm audit fix` moves lockfile pins **inside** declared semver ranges — the
author's compatibility promise covers those, and our tests catch a broken
promise. These four require editing `package.json` across a major boundary,
where the author has explicitly said "I broke something."

**Nothing here ships to users.** All ten alerts are `development` scope;
`.vscodeignore` excludes `tests/**`, `src/**`, `media/**`, and only `dist/`
lands in the VSIX. But dev-scope splits into two categories that deserve
different care:

| | Packages | Why it matters |
| --- | --- | --- |
| **Build path** | `esbuild`, `copy-webpack-plugin`→`serialize-javascript` | Don't ship, but **write what ships**. `vscode:prepublish` → `package` → `build:media` (esbuild) + webpack production ([webpack.config.js:6](../../webpack.config.js#L6)). Output is signed and published to six platforms. |
| **Test only** | `happy-dom`, `vitest`, `vite` | Never touch `dist/`. Breakage is loud and local. |

**None of the four CVEs is currently exploitable against us** — every one
needs a feature we don't invoke (`esbuild serve`, the Vitest UI server) or
attacker-controlled input we don't feed it (webpack cache keys, our own test
fixtures). This is **hygiene, not incident response**: a permanently-red
security tab is one you stop reading, and that's how a real alert gets missed.
Schedule accordingly — no urgency, but don't let it rot.

---

## The thing this plan is actually designed around

**Our gate catches loud breakage; it does not catch silent drift.** A bump
that makes the build crash or a test fail is self-reporting — `test:all` and
`compile` handle it. The two failure modes worth engineering against:

1. **A test runner that silently runs fewer tests.** vitest 3 changes config
   defaults; a glob or `exclude` that stops matching leaves the suite
   **green with less coverage**. Green is not the invariant — *count* is.
2. **A bundler that produces subtly different output.** esbuild 0.25 can
   build cleanly and emit different codegen. `compile` succeeding proves
   nothing about the artifact's behavior.

Both are addressed by explicit steps below, not by trusting the gate.

### Baseline to hold (captured green at `a5925d0`, 2026-08-12)

```
test:unit          2392 passed + 27 todo   (94 files)
test:actors        1055 passed             (36 files)
test:events         117 passed             ( 3 files)
test:integration     41 passed             ( 4 files)
                   ────
                   3605 passed / 3632 total
e2e:harness          82 passed
```

**Updated 2026-08-12 (post-Phase 3):** `test:unit` is now **2398 passed + 27 todo**
(3611 / 3638 total), file counts unchanged. The +6 are the `ripgrep resolution`
tests added by a `/shipshape` gate, not a dependency bump — compare the vitest
re-attempt against *these* numbers.

**Any bump that changes a count is failed until explained**, even if green.
Record file counts too — a dropped *file* is the likeliest silent regression.

---

## Ground rules

- **One bump per commit, one variable at a time.** Never move happy-dom and
  vitest together: both change the test environment, and a joint failure is
  un-attributable. Revert is `git revert <sha>`; the lockfile rides along.
- **Full `/dep-audit` gate per bump**: `typecheck` · `compile` ·
  `test:all` ×2 · `e2e:harness`. Plus the per-phase extra verification below.
- **Never adjust a test to absorb a dependency's behavior change** without
  understanding the change. A test edited to make a bump pass is the bump
  hiding a regression. If a test must change, that's a finding — write it
  down here.
- Known flakes get one re-run before counting as red: `TraceCollector`
  time-based eviction, MCP `fixtureServer` restart-budget (both in
  CLAUDE.md Active Bugs).

---

## Phase 1 — `copy-webpack-plugin ^13.0.1 → 14` (XS) — ✅ DONE 2026-08-12

Closes **#12** (high), **#29**. Build path.

**Outcome: clean, zero surprises.** Installed 14.0.0, which pulled
`serialize-javascript@7.1.0` (past both the 7.0.3 and 7.0.5 patch lines).
Gate green first try — typecheck + compile clean, `test:all` twice at exactly
the baseline (2392+27 / 1055 / 117 / 41, files 94/36/3/4), `e2e:harness`
82/82. No flake re-runs needed.

**The extra check paid off in the strongest way available:** `dist/` came out
**byte-identical** — same 18 files, every file the same size. So `CopyPlugin`
14 does exactly what 13 did to the shipped artifact, which is the claim that
actually mattered for a build-path bump. Predicted risk (very low) matched
observed risk; the node ≥20.9 floor was a non-event as expected.

The lockfile diff is exactly two version lines — `copy-webpack-plugin@14.0.0`
and `serialize-javascript@7.1.0` — and `package.json` moved one range. Nothing
else drifted, which is the cleanest possible attribution for a bump commit.

**Why it's first:** it is the smallest real change in the set and it proves
the whole loop — bump, gate, verify alert closure, commit — on something that
almost cannot break. Do not skip it as trivial; it's the rehearsal.

**Established:** the entire diff from 13 to 14 is `serialize-javascript ^6→^7`
(the fix itself) plus an engines floor of `node >= 20.9.0`. CI pins
`node-version: '20.x'` (resolves ≥20.19) and local is 25.4.0 — **the floor is
already satisfied**, verified. Peer stays `webpack ^5.1.0`.

**Steps**
1. `npm install --save-dev copy-webpack-plugin@^14`
2. Confirm `npm ls serialize-javascript` shows ≥7.0.5.
3. Standard gate.
4. **Extra:** confirm the copied assets still land — `CopyPlugin` at
   [webpack.config.js:47](../../webpack.config.js#L47) is what puts the
   tokenizer/wasm/media assets into `dist/`. Compare `find dist -type f | sort`
   before and after; expect an identical list.

**Risk:** very low. **Rollback:** revert the commit.

---

## Phase 2 — `esbuild ^0.19.12 → 0.25` (S, but the one to verify hardest) — ✅ DONE 2026-08-12

Contributes to **#1**. Build path — this bundles the entire webview.

**Outcome: shipped at 0.25.12. The artifact is effectively unchanged, and the
one scare was a pre-existing flake, not the bump.**

Artifact verification (the reason this phase existed):

| Build | `chat.js` | `dev.js` |
| --- | --- | --- |
| dev | 1,024,960 → 1,022,330 (**−0.26%**) | 118,441 → 117,785 (−0.55%) |
| **production** | 635,257 → 635,254 (**−3 bytes**) | 73,387 → 73,387 (**identical**) |

The dev-build shrink is **fully explained and benign**: esbuild 0.25 collapses
single-statement `if` bodies onto one line where 0.19 broke them (405 fewer
lines). Pure pretty-printer change in non-minified output — the whitespace is
the entire delta. Production, where minification erases formatting, is
byte-identical but for 3 bytes, which is the strongest possible evidence that
codegen is semantically unchanged. Identical `dist/` file list. `e2e:harness`
82/82 against the rebuilt bundle. Production `pure` stripping still correct:
0 `console.debug`/`console.info`, 11 `console.warn`/`console.error` retained.

**#1 stays open, as predicted** — vite's nested `esbuild@0.21.5` is still in
the tree and the advisory covers it. It closes with Phase 4.

### The false alarm — worth reading before Phase 3

`fixtureServer.test.ts` → *"exhausts the budget on a handshake-then-exit crash
loop"* failed **four times running** right after the bump, including in
isolation. That looks exactly like "the bump broke a test," and the plan's own
rule says a deterministic break means the bump is not safe.

It was not the bump. A 5-run A/B settled it:

| esbuild | isolated runs |
| --- | --- |
| 0.19.12 (pre-bump baseline) | **2 failed / 5** |
| 0.25.12 (bumped) | 0 failed / 5 |

It fails on the *old* version too. The initial 1-sample-each read
("0.25 fails, 0.19 passes") was coincidence — exactly the trap a known-flaky
test sets for an upgrade. **Lesson for Phase 3/4: when a bump appears to break
a flaky test, A/B it with ≥5 runs per arm before believing either direction.**
One re-run, which is all the standard gate calls for, is not enough to
attribute anything.

Two findings about that flake fell out and are now in CLAUDE.md Active Bugs:
it **does** fail in isolation (the tracker previously said it passed 16/16
alone), and the failures **cluster** right after heavy `test:all` runs, which
points at leftover child-process/resource state rather than pure in-run timing.

Note: `dist/media/*.map` files survive a production `package` because the build
doesn't clean `dist/` — they are stale dev artifacts. Pre-existing, and they
never ship ([.vscodeignore:44](../../.vscodeignore#L44) excludes them).

**Established:** [scripts/build-media.js](../../scripts/build-media.js) uses
`esbuild.buildSync` with `entryPoints`, `outfile`, `bundle`, `platform`,
`target: 'es2020'`, `sourcemap`, `minify`, `loader: {'.css':'text'}`,
`define`, and `pure`. All are long-stable options — no use of `serve`,
incremental, or the plugin API, which is where most 0.20–0.25 churn landed.

**Alert #1 will not close on this bump alone.** esbuild is in the tree
**twice** — our direct `0.19.12` *and* vite's transitive `0.21.5` — and the
advisory range (`<=0.24.2`) covers both. #1 closes only once Phase 4 lands
vite 7 (which carries esbuild 0.25.x). Expect the alert to stay open here;
that is not a failed bump.

**Steps**
1. **Capture the baseline artifact first:**
   `npm run compile && cp -r dist /tmp/dist-esbuild-baseline`
2. `npm install --save-dev esbuild@^0.25`
3. `npm run compile`
4. Standard gate.
5. **Extra — output drift check (the point of this phase):**
   - Compare bundle sizes: `dist/media/chat.js` and `dist/media/dev.js`
     against the baseline. A few % is normal codegen churn; a large swing or
     a *smaller* bundle wants explanation (dropped module? changed
     tree-shaking?).
   - **`npm run test:e2e:harness` is the real verifier here** — 82 specs run
     against the *built* webview bundle in a real Chromium, so it exercises
     the actual artifact rather than source. This tier is why esbuild is
     safer to bump than it looks.
   - Sanity-check the production path too, since `minify`/`pure` only apply
     there: `NODE_ENV=production npm run package`, then confirm
     `dist/media/chat.js` is minified and contains no `console.debug`.

**Risk:** low-moderate — the API we use is stable, but the artifact is what
users run. **Rollback:** revert; `npm run compile` restores the old bundle.

---

## Phase 3 — `happy-dom ^15.11.7 → 20.8.9` (S–M) — ✅ DONE 2026-08-12

Closes **#2** (critical), **#19**, **#22**. Test only.

**Outcome: shipped at 20.11.2. Zero test changes — the riskiest-looking bump
in the plan was the least eventful.** `test:actors` (the concentrated blast
radius) came back **36 files / 1055 tests, exact baseline, first try**. Five
majors of DOM-engine change and not one assertion moved.

The risk table below turned out to overestimate: constructable stylesheets,
`adoptedStyleSheets`, `attachShadow`, and the observer APIs all behave
compatibly between 15.11.7 and 20.11.2 for how we use them. `new
CSSStyleSheet()` in [EventStateManager.ts:154](../../media/state/EventStateManager.ts#L154)
works unchanged. **Nothing in the "if failures appear" triage was needed.**

Also confirmed the plan's peer read: happy-dom 20 **deduped under vitest
2.1.9** with no peer warning, which is the practical proof that the optional
`'*'` peer imposes no ordering. Doing this before vitest was safe.

**Two flakes fired during the gate; both exonerated by isolated runs**, using
the ≥5-run rule Phase 2 established:

| Test | Isolated at happy-dom 20 | Verdict |
| --- | --- | --- |
| `fixtureServer` → *refresh command revives a server* | **5/5 pass** | pre-existing; baseline arm failed 2/5 earlier today |
| `hydration-perf` → *50 turns × 200 events under 2s* | **5/5 pass** | wall-clock assertion; **0** DOM references in the file, so happy-dom cannot reach it; also failed pre-bump this morning |

Note the `fixtureServer` failure hit a *different* test in the same
restart-policy block than Phase 2's did — which supports the
shared-resource-state theory in the Active Bug over a specific-assertion
regression. Both failures appeared only under full-suite load, never in
isolation, matching the documented signature. The gate then went green twice
consecutively at exact baseline.

**Established — no ordering constraint exists.** vitest declares
`happy-dom: '*'` as an *optional* peer in **both** 2.1.9 and 3.2.6, so nothing
forces vitest to move first. (An earlier note in CLAUDE.md claimed otherwise;
corrected in `8c2b6f3`.) Doing happy-dom **before** vitest is deliberate: it
isolates five majors of DOM-engine change against a *known-good* runner, so
any failure is attributable to happy-dom alone.

**The risk surface, measured:**

| API | Uses | Where |
| --- | --- | --- |
| `innerHTML` | 144 | everywhere |
| `adoptedStyleSheets` | 40 | 6 files in `media/`, 14 in `tests/` |
| `CSSStyleSheet` | 20 | **constructed in production** — [EventStateManager.ts:154](../../media/state/EventStateManager.ts#L154) |
| `ShadowRoot` / `attachShadow` | 18 | the Shadow-DOM actor architecture |
| `MutationObserver` / `ResizeObserver` / `rAF` | 31 | actor lifecycle |
| `getComputedStyle` | 6 | historically the weakest happy-dom area |

Constructable stylesheets are the load-bearing dependency: `media/` calls
`new CSSStyleSheet()` directly, and 36 actor-test files run against it. If
happy-dom 20 changed those semantics, this phase is where it shows.

**Good news, verified:** the shadow-DOM assertions **fail loudly** rather than
silently. The common pattern is
`expect(element.shadowRoot?.adoptedStyleSheets?.length).toBeGreaterThan(0)` —
optional chaining yields `undefined`, and `expect(undefined).toBeGreaterThan(0)`
throws in vitest. No silent-pass path here.

**Steps**
1. `npm install --save-dev happy-dom@^20`
2. `npm run test:actors` **first** (36 files, the concentrated blast radius) —
   fast signal before committing to a full run.
3. Standard gate.
4. **Extra:** diff test counts against the baseline table. `test:actors` must
   report exactly **1055 / 36 files**.
5. If failures appear, triage by category before touching any test:
   constructable-stylesheet semantics, `getComputedStyle` completeness, or
   observer timing. Record the finding in this doc, then decide — a genuine
   happy-dom behavior change may justify a test edit; an unexplained one does
   not.

**Risk:** moderate — five majors of change under 36 test files.
**Rollback:** revert.

---

## Phase 4 — `vitest ^2.1.9 → 3.2.6` + `@vitest/ui` + `@vitest/coverage-v8` (M — the big one)

> **⛔ ATTEMPTED 2026-08-12 — REVERTED, NOT SHIPPED.** The bump is structurally
> sound; it degrades **suite reliability**. Blocked on the test-hardening
> prerequisite below (user call, 2026-08-12). Do not re-attempt until that
> lands — the same wall-clock tests will detonate again.

### What the attempt established

**Everything structural passed, and the plan's headline risks were all
false alarms:**

- **Collection is identical** — not just 3605 tests but the *same set of test
  names*, set-diff **0 lines** across all four suites. The silent-drift risk
  this whole plan was designed around is cleanly answered. (Method worth
  reusing: `npx vitest list --run tests/<suite>` per suite, sorted, diffed —
  it catches a changed *set* at identical count, which a count check can't.)
- **`cssRawPlugin` survived vite 5 → 7.** The single item rated most likely to
  break loaded and worked unchanged across two plugin-API majors.
- `typecheck` clean (the `Plugin` type still resolves), `compile` clean, no
  peer conflicts. Resolved chain: vitest 3.2.7, vite 7.3.6, nested
  esbuild 0.28.2 — which is what would have closed **#1**.

### Why it was reverted

Every failure was **wall-clock, never semantic** — `Test timed out in 5000ms`,
or `expected 88134 to be less than 10000` at
[WebviewTracer.test.ts:357](../../tests/unit/tracing/WebviewTracer.test.ts#L357)
(88 *seconds* of relative time). **Never the same test twice**, zero assertion
mismatches of the kind a real behavior change produces.

Controlled A/B, same protocol, back-to-back, 5× `test:unit` each:

| Arm | failed runs | load at end |
| --- | --- | --- |
| vitest 3.2.7 | **2 / 5** | 6.41 |
| vitest 2.1.9 | **0 / 5** | 7.26 |

Across the whole session: v3 failed **~6 of 14** runs (~43%), v2 **~1 of 8**
(~12%). **Honest statistics:** 2/5 vs 0/5 alone is *not* significant; the
persuasive part is the aggregate plus v2 staying clean at *higher* load.
`--maxWorkers=4` did **not** help (still 1/3), so it isn't raw worker count.

### The actual conclusion — this is a test problem, not a vitest problem

**vitest 3 is not broken. It is a more demanding runner that exposes tests
which were already marginal.** The casualties are exactly the population
CLAUDE.md already tracks as flaky, plus their neighbours — wall-clock
assertions with 5s/10s budgets. vitest 2 left enough headroom that they
usually passed; vitest 3 does not.

That reframes the blocker: *any* future change to runner performance will keep
detonating these. Fixing them is worth doing on its own merits, independent of
this bump.

### Prerequisite — the marginal-test inventory (harden these first)

Everything observed failing under load during this attempt. All are
timing/wall-clock shaped; none failed for a semantic reason:

| Test | Shape |
| --- | --- |
| [WebviewTracer.test.ts:357](../../tests/unit/tracing/WebviewTracer.test.ts#L357) | `webviewRelativeTime` < 10000ms — **explicit wall-clock bound** |
| `hydration-perf` → *50 turns × 200 events under 2s* | explicit wall-clock bound |
| `lspTimeout` → *LspTimeoutError carries the configured timeout* | real `setTimeout`, 5s test budget |
| `lspAvailability` → *coalesces concurrent calls into a single in-flight discovery* | concurrency timing |
| `McpServerManagerTransport` → *honours the injected call timeout on a hanging tool* | real timers |
| `McpServerManagerLifecycle` → *does NOT restart a server that never handshaked* | real timers |
| `requestOrchestrator` → *marks status=interrupted on abort path* | async teardown race |
| `requestOrchestrator` → *fade backstop re-pins after N unchanged iterations* | async |
| `ConversationManager` → *forks at user_message boundary* | async/DB |
| `dbRecovery` → *opens an existing valid database with the correct key* | real SQLCipher I/O |
| `TraceCollector` → *time-based eviction* | known flake (CLAUDE.md) |
| `fixtureServer` → *restart policy* block | known flake (CLAUDE.md) |

**Direction, not prescription:** prefer fake timers or wait-for-state over
wait-for-time; replace absolute wall-clock bounds with either a generous
ceiling or a non-timing assertion of the same property. The two CLAUDE.md
flakes are the same class and should be folded into this work rather than
chased separately — that is now the third independent session they've cost.

**Explicitly rejected:** raising the global `testTimeout` to absorb it. That
masks a real performance regression and violates this plan's own rule about
absorbing dependency behavior changes.

### When re-attempted

Steps below are still correct. Re-run the collection set-diff (it was the
highest-value check), and require the standard gate on a **quiet machine** —
this attempt was badly confounded by hours of back-to-back suite runs pushing
load average to 7+ on 8 cores, and no reliability judgment is trustworthy
under that.

**Established:** vitest 3.2.6 declares `vite: ^5.0.0 || ^6.0.0 || ^7.0.0-0`, so
a fresh install resolves **vite 7** — past the 6.4.3 patch line, closing all
three vite alerts. `@vitest/ui` is peer-pinned to the *exact* vitest version
(`'3.2.6'`), so it **must** move in lockstep; `@vitest/coverage-v8` likewise.
All three are currently `^2.0.0`.

**Config surface at risk** ([vitest.config.ts](../../vitest.config.ts)):

- **`cssRawPlugin`** — a hand-written Vite `Plugin` with `enforce: 'pre'` and a
  `transform` hook. This crosses **vite 5 → 7**, two plugin-API majors. Most
  likely thing to break in the whole plan. It is what makes
  `import styles from './x.css?raw'` work for shadow-DOM style injection.
- **`pool: 'forks'` + `isolate: true`** — load-bearing against the historical
  worker OOM. The comment at [vitest.config.ts:77](../../vitest.config.ts#L77)
  explains why; **do not let a migration guide talk you out of these.**
- `globals: true`, `setupFiles`, `snapshotFormat.printBasicPrototype`,
  `resolve.alias` (including the `vscode` → mock alias that every extension
  test depends on), `esbuild.target`, and the whole `coverage` block.
- `include` / `exclude` globs — **the silent-drift vector.** If these stop
  matching, the suite goes green with fewer tests.

**Steps**
1. `npm install --save-dev vitest@^3.2.6 @vitest/ui@^3.2.6 @vitest/coverage-v8@^3`
2. `npx vitest list --run 2>/dev/null | wc -l` (or run each suite) **before
   trusting any green** — confirm collection still finds 94 / 36 / 3 / 4 files.
3. Standard gate.
4. **Extra — the count invariant, non-negotiable:** every suite must match the
   baseline table exactly (2392+27 / 1055 / 117 / 41). A green run with a
   different count is a **failure**, and the first thing to check is the
   `include`/`exclude` globs and the `vscode` alias.
5. **Extra — the alias check:** if `resolve.alias` silently stops applying,
   extension-side tests would try to import the real `vscode` module and fail
   loudly — but confirm by running one known-dependent file
   (`tests/unit/providers/`).
6. **Extra — coverage still works:** `npm run test:unit:coverage` (the v8
   provider moved across the major).
7. Confirm the vite alerts and #1 close on the next Dependabot rescan.

**Risk:** highest of the four — largest surface, two plugin-API majors, and the
OOM knobs are historically load-bearing. Budget a session, not a slot.
**Rollback:** revert; all three packages move together in the one commit.

---

## Status (2026-08-12)

**35 → 5 open alerts.** Phases 1–3 shipped clean; Phase 4 attempted and
reverted, blocked on test hardening.

| Phase | Package | Commit | Alerts closed |
| --- | --- | --- | --- |
| — | safe tier (`npm audit fix` + cargo) | `a5925d0` | 25 |
| 1 | copy-webpack-plugin 13→14 | `93f4930` | #12, #29 |
| 2 | esbuild 0.19.12→0.25.12 | `5020a3d` | none (as predicted) |
| 3 | happy-dom 15.11.7→20.11.2 | `4bedd2f` | #2, #19, #22 |
| 4 | vitest 2→3 chain | **reverted** | would close #1, #23, #30, #31, #32 |

The remaining 5 alerts are all dev-scope and **none is exploitable in our
usage** (see the tier table at the top) — which is precisely why waiting for a
proper test-hardening pass costs nothing.

## Done when

- `gh api .../dependabot/alerts --jq '[.[]|select(.state=="open")]|length'`
  returns **0**.
- Baseline counts unchanged across all four phases (or every deviation
  explained in writing here).
- `e2e:harness` 82/82 after the esbuild bump specifically.
- CLAUDE.md Planned Work item 4 replaced with a Recently Fixed entry
  recording what actually broke — the migration notes are the durable value,
  not the version numbers.
- Any test that had to change is named here with its justification.

## Explicitly out of scope

- **`npm audit fix --force`** — applies all four blind, in one shot, with no
  attribution. The `/dep-audit` skill forbids it.
- Bumping anything not on the alert list (`typescript`, `eslint`,
  `@playwright/test`, `webpack`) — unrelated churn muddies attribution.
- `@types/node ^18.x`. It's stale relative to CI's Node 20 and worth revisiting,
  but it is **not** a security alert and does not belong in this effort.
