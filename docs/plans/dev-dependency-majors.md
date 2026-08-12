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

## Phase 1 — `copy-webpack-plugin ^13.0.1 → 14` (XS)

Closes **#12** (high), **#29**. Build path.

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

## Phase 2 — `esbuild ^0.19.12 → 0.25` (S, but the one to verify hardest)

Contributes to **#1**. Build path — this bundles the entire webview.

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

## Phase 3 — `happy-dom ^15.11.7 → 20.8.9` (S–M)

Closes **#2** (critical), **#19**, **#22**. Test only.

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

Closes **#30** (critical), and **#23 / #31 / #32** (vite) as a side effect.
Completes **#1** (esbuild) via vite 7. Test only.

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
