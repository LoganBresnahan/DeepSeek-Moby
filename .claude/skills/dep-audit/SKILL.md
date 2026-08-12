---
name: dep-audit
description: Audit and remediate dependency security alerts for DeepSeek Moby — fetch Dependabot alerts from GitHub, classify them (runtime vs dev, direct vs transitive, semver-patch vs major), apply the semver-compatible fixes mechanically, gate with the test suites, and report the residuals that need real migration work. Run when Dependabot emails land, before releases, or on request.
---

# /dep-audit — dependency security pass

Four steps: **Fetch**, **Classify**, **Fix the safe tier**, **Gate & report**.
The deliverable is a green gate plus a named residual list — never a silent
`npm audit fix --force`.

Two rules that override everything below:

1. **Gate on our gates, not on audit-green.** A clean `npm audit` with a red
   test suite is a failure; a green suite with named residual majors is a
   success. Never use `npm audit fix --force` — it applies majors blind.
2. **Majors are proposed, not applied.** Anything requiring a package.json
   major-version change (or 0.x minor, which semver treats as breaking) goes
   in the residual list with its alert numbers and a size estimate. Applying
   one is its own effort with its own verification, possibly its own plan doc.

## 1. Fetch — GitHub is the source of truth, not npm

```bash
gh api repos/LoganBresnahan/DeepSeek-Moby/dependabot/alerts --paginate \
  --jq '.[] | select(.state=="open") | {num: .number, pkg: .dependency.package.name,
        scope: .dependency.scope, manifest: .dependency.manifest_path,
        severity: .security_advisory.severity,
        vulnerable: .security_vulnerability.vulnerable_version_range,
        patched: .security_vulnerability.first_patched_version.identifier}'
npm audit 2>&1 | tail -8   # cross-check only
```

They **disagree by design**: npm audit sees only `package-lock.json` against
npm's advisory DB; Dependabot also covers `packages/moby-wasm/Cargo.lock` and
uses GitHub's DB. An alert only one of them sees is normal — trust the union,
and close alerts against the GitHub list.

## 2. Classify — three tiers

For each alert, determine:

- **Ecosystem**: `package-lock.json` → npm; `Cargo.lock` → cargo (fix with
  `cargo update -p <pkg> --precise <ver>` in `packages/moby-wasm/`, then
  rebuild the wasm pkg).
- **Scope**: `runtime` vs `development`. Runtime deps can ship inside the
  VSIX (webpack bundles `dependencies` into the extension; esbuild bundles
  what `media/` imports into the webview) — these are the alerts that reach
  users. Dev deps never ship; their risk is the dev/CI machine.
  **markdown-it / linkify-it are special**: they render model-emitted text in
  the webview, so "attacker-controlled input" is the normal case, not an edge
  case. Treat any alert on them as top priority regardless of severity label.
- **Reachability**: is the patched version inside our declared semver range?
  `node -e "console.log(require('./package.json').dependencies)"` for direct
  deps; `npm ls <pkg>` for who pulls a transitive one. Patched-in-range →
  Tier safe. Needs a package.json major/0.x bump → Tier residual.

## 3. Fix the safe tier

```bash
npm audit fix          # never --force
git diff package.json  # expect: no changes, or in-range version notes only
```

`npm audit fix` only moves lockfile pins within declared ranges — that's why
it's safe. If an in-range alert survives it (npm's DB lag), pin the transitive
dep directly with `npm update <pkg>` or an explicit `npm install <pkg>@<ver>`
into the lockfile. Cargo alerts: `cargo update -p <pkg>` in
`packages/moby-wasm/`, then rebuild the wasm package so `pkg/` matches.

Verify each targeted alert is actually closed — installed version inside the
patched range:

```bash
npm ls markdown-it linkify-it fast-uri uuid   # adjust to this run's alert list
```

An alert whose package no longer appears in the tree at all is also closed
(dependency dropped) — say so rather than marking it fixed-by-bump.

## 4. Gate & report

The gate is `/shipshape`'s tests gate — dependency bumps can break anything,
so nothing narrower is credible:

```bash
npm run typecheck
npm run compile
npm run test:all     # green twice
npm run test:all
npm run test:e2e:harness
```

Known flakes (TraceCollector eviction, MCP fixture-server restart-budget) are
in CLAUDE.md Active Bugs — a single failure there gets a re-run before it
counts as red. If a dep bump breaks a test **deterministically**, that bump is
not safe: revert it to the residual list with the failing test named. Never
adjust a test to absorb a behavior change from a dependency without
understanding the change.

Report:

```
DEP-AUDIT REPORT
  alerts       <n> open → <n> closed this pass · <n> residual
  fixed        <pkg old→new (alert #s)> …
  residual     <pkg>: needs <major bump>, blocks alerts <#s>, size: <S/M/L> — <one-line why it's not mechanical>
  gate         ✓|✗  typecheck · compile · test:all ×2 · e2e:harness
```

Then:

- Commit as `chore(deps): security bumps — <summary>` (lockfile + any
  Cargo.lock changes together). Dependabot auto-closes alerts once the
  fixed lockfile reaches the default branch — no manual dismissal.
- If the residual list changed, record it in the CLAUDE.md tracker (Planned
  Work or Active Bugs, whichever fits) so the next session sees it.
- Residual majors that are release-relevant (runtime-scope, or critical
  severity) belong in the release checklist, not just here.
