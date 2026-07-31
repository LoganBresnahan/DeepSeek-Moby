---
name: shipshape
description: Verify DeepSeek Moby is shipshape — the build compiles, the test suites are green twice, docs (CLAUDE.md tracker / ADRs / plans / manual-test backlog) match the code, and the bundle-isolation / command-parity / model-scope conventions hold. Use after substantive changes, before commits, or when asked whether the project is in order.
---

# /shipshape — repo verification pass

Three gates: **Tests**, **Docs**, **Conventions**. Check all three even if one
fails early — the deliverable is the full report, not the first failure.
Propose fixes; do **not** apply them unless the user asks.

## 0. Scope the audit

```bash
git status --short && git diff HEAD --stat
```

Uncommitted work is the primary audit surface; spot-check the rest. If the
user asks for a full audit, the scope is the whole repo.

## 1. Tests gate

Build first — webpack (extension) and esbuild (webview) are separate bundles
and either can break alone:

```bash
npm run compile
```

Then the suites, green **twice in a row** (the flaky bar — timing- and
stream-sensitive tests must survive a loaded machine):

```bash
npm run test:all
npm run test:all
```

**`test:all`, not `npx vitest run`.** The split scripts
(`test:unit` / `test:actors` / `test:events` / `test:integration`) run in
separate vitest processes; the single-process full run hits the known
vitest-worker OOM and reads like a broken suite rather than an infra limit.

Also run `npm run test:e2e` (Playwright against the *built* webview bundle —
depends on the `npm run compile` above). Full-extension verification in a real
VS Code instance is `/verify`'s job (Handle 2), not this gate's; here the
headless webview harness suffices. Manual dev-host checks stay on the
manual-test backlog (Docs gate) — a green `/shipshape` does **not** discharge
them.

Coverage is judged by **behavior mapping**, not a percentage. For each changed
public behavior in scope, name the test that pins it — the usual surfaces:

- `src/providers/requestOrchestrator.ts`: streaming loop, tool-call
  iterations, abort/interrupt teardown (ADR 0008), stop markers (ADR 0001).
- `src/tools/reasonerShellExecutor.ts`: `<shell>` parsing, approval flow,
  heredoc stripping (ADR 0002), absolute-path ground truth (ADR 0004).
- `src/events/`: event append/hydration, join-table sequencing, fork
  semantics (ADR 0003).
- `media/actors/turn/MessageTurnActor.ts`: `formatContent` — markdown-it
  rendering, fence extraction, HTML escaping, R1 streaming fence guards.
- `media/actors/message-gateway/`: webview↔extension message contracts.

A new or changed public behavior with no test naming it = **gap**.

## 2. Docs gate

**ADRs** (`docs/architecture/decisions/NNNN-slug.md`, template at
`_template.md`). Any **decision** in scope — new dependency, changed algorithm
or contract, pattern adopted or rejected — needs an ADR, or an update marking
an existing one superseded. Implementation detail is not a decision. Check
revisit triggers on ADRs the change touches: a trigger the change fires must
be acted on or explicitly deferred.

**CLAUDE.md work tracker**: fixed bugs moved from Active Bugs to Recently
Fixed; Planned Work items in progress reflect reality; entries link their
plan/ADR. CLAUDE.md is auto-loaded every session — staleness there misleads
every future session at once.

**Manual-test backlog** (`docs/plans/manual-test-backlog.md`): every
user-visible change in scope is listed for dev-host verification, per the
CLAUDE.md convention ("manual test in VS Code dev host before claiming
done"). A UI change absent from the backlog and not yet dev-host-tested =
**gap**.

**Plans** (`docs/plans/`): a plan whose work has fully shipped moves to
`docs/plans/completed/`; a plan the change diverged from gets updated or
annotated, not silently contradicted.

Drift check, per doc that names code artifacts:

```bash
git log -1 --format='%ct %h' -- docs/<doc>.md          # when the doc last changed
git log -1 --format='%ct %h' -- <files it describes>
```

If a source is newer than the doc, read the diff since the doc's commit and
either confirm the doc still matches or name the exact stale claim. Also grep
that files/symbols named in docs (and CLAUDE.md's Key Files section) still
exist.

## 3. Conventions gate

Everything flagged is a violation unless listed as an allowed escape.

**Bundle isolation** — `src/` (Node) and `media/` (browser) are separate
bundles; shared types are defined locally in each, never imported across:

```bash
grep -rn "from ['\"].*\.\./src/" media/ --include='*.ts'
grep -rn "from ['\"].*media/" src/ --include='*.ts'
# expect: no hits. Path STRINGS in src/ pointing at dist/media assets
# (webview bundle loading) are fine — only `import`/`from` crossings violate.
```

**Command parity** — a command must exist in BOTH `package.json`
`contributes.commands` and a `registerCommand` site (the table in
`src/extension.ts` registers `moby.${name}` from `{ name: '...' }` entries):

```bash
node -e '
const cmds=require("./package.json").contributes.commands.map(c=>c.command.replace(/^moby\./,""));
const cp=require("child_process");
const missing=cmds.filter(n=>{try{cp.execSync(`grep -rqE "moby\\.${n}|name: .${n}." src/`);return false}catch{return true}});
console.log(missing.length?"UNREGISTERED: "+missing:"all "+cmds.length+" commands registered")'
```

**Model-scope annotations** (judgment, not grep) — behavior scoped to one
model (R1 vs Chat vs V4) carries a scope comment when the enclosing
file/function name isn't self-evidently model-specific; and **no model-scope
notes inside prompt template strings** — they leak to the model. Skim the
diff's prompt-string changes for editorial asides.

**Comment discipline** (judgment) — no multi-paragraph comments; one short
line max for non-obvious WHY.

## 4. Report

```
SHIPSHAPE REPORT
  tests        ✓|✗   compile clean · test:all <n>/<n> twice · e2e green · gaps: <behavior lacking a test, or none>
  docs         ✓|✗   ADRs current · tracker true · backlog covers UI changes · drift: <doc: stale claim, or none>
  conventions  ✓|✗   violations: <file:line, or none>
```

For every ✗, list the concrete fix (file:line, what to change). All green →
the ship is shipshape. 🐋
