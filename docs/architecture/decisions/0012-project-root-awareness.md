# 0012. Project-root awareness (workspace root ≠ project root)

**Status:** Accepted — implemented as specified.
**Date:** 2026-06-21

## Context

A traced session (the 3:04pm run) built a .NET app with `dotnet new`, which created the project **one level below the workspace root** (`<workspace>/worldCupWebApp/worldCupWebApp.csproj`). That single structural fact — the workspace root is not the project root — broke three independent systems that had each quietly assumed `workspace == project`:

1. **Build artifacts flooded the file-change pipeline.** `shouldIgnoreWatcherPath` checked build-output directory names (`obj`, `bin`, `Debug`, `Release`, `dist`, …) only against `segments[0]` of the workspace-relative path — deliberately, so a legitimate deep `src/bin/` isn't false-ignored. For a root-level project, `obj/Debug/x.cache` → `segments[0] === 'obj'` → ignored. For a **nested** project, `worldCupWebApp/obj/Debug/x.cache` → `segments[0] === 'worldCupWebApp'` → **leaked**. Every `dotnet build` then pushed dozens of `obj/`/`bin/` files into `DiffManager` as applied changes, which produced: ~40 webview `updatePendingStatus: file not found` warnings, bloated history, **and** false positives in the ADR [0011](0011-verification-gated-turn-completion.md) verification gate — empty MSBuild `.cache` files were treated as "empty deliverables" and the turn was held open three times before giving up.

2. **Edit-safety (ADR [0006](0006-edit-safety-checkpoint-and-validation.md)) went dormant.** `discoverCheckCommand` did a single, non-recursive `readDirectory(workspaceRoot)`. With the `.csproj` one level down, no marker was found at the root → `null` → the gate was a no-op for the whole session, even though the agent ran `dotnet build` (and hit a real build break) repeatedly. The 0006/0011 guarantees were silently **not in force**.

3. **File-context attachment failed.** `FileContextManager.sendFileContent` joined the path to `workspaceFolders[0]` only, so attaching a path that's relative to the nested project root resolved to a non-existent file at the workspace root.

These are not three bugs; they are one assumption, broken in three places.

## Decision

Introduce **project-root awareness** as a shared concern (`src/utils/workspacePaths.ts`) and teach the three consumers to use it. Stop assuming the workspace root is the project root.

1. **Resolve project roots.** `findProjectRoots(workspaceRoot, { maxDepth })` is a bounded breadth-first search that returns the directories holding a recognised marker (`.csproj`/`.sln`/`package.json`/`Cargo.toml`/`go.mod`/`Makefile`/`pom.xml`/`build.gradle`/…), nearest-first. It does **not** descend into a found root (its subtree belongs to it) nor into ignored directories, and stops at `maxDepth` (default 3). **Fast path:** a marker at the workspace root returns immediately — zero behavioural change and zero extra I/O for conventionally-structured repos.

2. **Make the ignore nesting-aware, with a structural floor for .NET.** `shouldIgnoreWatcherPath(path, projectRoots?)`:
   - The unambiguous .NET artifacts are caught **structurally at any depth** — an `obj/` segment anywhere, or a `bin/` segment immediately followed by a build-config segment (`Debug`/`Release`/`net*`/RID). This fixes the observed leak **independent of project-root resolution**, so it works even before the root is discovered (e.g. a project created mid-turn).
   - The broader root-only dirs (`dist`, `build`, `out`, `target`, `vendor`, …) are anchored at the workspace root **and** at each discovered project root: strip a project-root prefix, then apply the existing `segments[0]` rule to the remainder. This preserves the original safety (a deep `src/build/` that isn't at a project root is not ignored) while catching `app/dist/` under a nested project.
   The orchestrator threads `this._projectRoots` (refreshed each turn) into the six watcher-filter call sites.

3. **Filter the verification gate by build output.** `verifyTurnCompletion` (ADR 0011) drops generated build files from the deliverable set before the present-but-empty check (a deliverable is *source*, not an MSBuild cache file). We chose the **artifact-ignore** approach over tagging each change as model- vs shell-authored, because a shell *can* produce a real deliverable (`curl -o data.json`) and we don't want to stop verifying those.

4. **Discover the check command at the project root.** `discoverCheckCommand` probes the given root first, then — only if nothing is found — the nearest project root(s) via `findProjectRoots`, running the check with `cwd` set to that directory. Root-level repos are unchanged; a nested `.csproj` now yields `dotnet build` run in the project directory.

5. **Resolve file-context paths against project roots.** `resolveWorkspacePath(filePath)` tries the workspace root, then each project root, returning the first that exists. `sendFileContent` uses it (falling back to the old workspace-root join), so attaching a project-root-relative path resolves.

## Alternatives considered

### A. Blanket-ignore `obj`/`bin` everywhere (no project-root resolution)

Add `obj` and `bin` to the any-depth ignore set unconditionally.

Partially adopted, partially rejected. `obj/` *is* ignored at any depth (it is essentially never source). But a bare `bin/` at any depth is **not** — a `bin/` scripts directory is common, and false-ignoring it would silently drop real edits. So `bin/` is ignored only when followed by a build-config segment. The general dirs (`dist`/`build`/`out`/`target`) stay root-anchored for the same reason, which is what motivates resolving project roots at all.

### B. Recursive, unbounded marker scan

Walk the entire tree to find every project.

Rejected on cost. An unbounded walk of a large monorepo (or a `node_modules` that slipped the filter) is a latency and I/O hazard on the hot path. The bounded BFS (depth 3, skip ignored dirs, stop at the first marker per branch) finds the realistic "project a level or two down" case cheaply and degrades to "no project root" rather than hanging.

### C. Require the user to configure the project root

A `moby.projectRoot` setting.

Rejected as friction that defeats the point — the failure happens precisely because the agent *created* the project layout mid-session; a human-authored setting wouldn't exist yet. Auto-discovery handles the layout the agent produced.

### D. Tag file-changes model- vs shell-authored, verify only model files

Have the verification gate ignore everything a shell touched.

Rejected (for now). It would fix the artifact case, but a shell can write a genuine deliverable (`curl -o data.json`, a codegen step), and we'd stop verifying those. The artifact-ignore is more precise: it targets *build output*, not *shell provenance*.

## Consequences

**Positive:**
- The verification gate (0011) only ever fires on real deliverables; the `obj/.cache` false positive — three wasted repair iterations per turn — is closed. The Modified Files panel and history stop showing dozens of `obj/`/`bin/` files, and the ~40 webview `file not found` warnings vanish.
- Edit-safety (0006) is no longer silently dormant on a project that lives in a subdirectory — the gate's guarantees actually apply.
- Attaching a path relative to a nested project root resolves instead of failing.
- One shared concept (`workspacePaths`) replaced three independently-broken assumptions; future consumers import one resolver.

**Negative / accepted costs:**
- A bounded directory BFS per turn (and inside `resolveWorkspacePath`). Cheap — it stops at the first marker per branch and skips ignored dirs — but non-zero. The fast path (marker at root) costs nothing.
- Mid-turn project creation is only partially covered for *non-.NET* build dirs: project roots are refreshed at turn start, so a JS project created mid-turn won't have its `dist/` anchored until the next turn. The .NET artifacts (the observed case) are caught structurally regardless, so this is a narrow, self-correcting gap.
- Multi-project monorepos resolve to the nearest single root for the check command; per-changed-file root selection is a follow-up.

**Follow-ups:**
- Per-changed-file project-root selection for monorepos (run the check in the project that owns the edited file).
- Optionally refresh project roots after a shell batch that created a marker, to cover mid-turn creation for all languages.

## Test plan

Framework is **vitest**.

- **`tests/unit/utils/workspacePaths.test.ts` (new):** `shouldIgnoreWatcherPath` — nested `obj/`/`bin/<config>` ignored, `src/bin/deploy.sh` preserved, root-only dirs anchored at a nested project root (and **not** ignored without one), source files preserved; `findProjectRoots` — root fast-path, one- and two-level nesting, ignore-dir skipping, `maxDepth` bound, no-marker → `[]`; `resolveWorkspacePath` — workspace root, nested project root, absolute, missing → null.
- **`editValidation.test.ts`:** a project in a subdirectory discovers `dotnet build` with `cwd` set to the project dir (the dormant-gate fix); root-level cases unchanged.
- **`requestOrchestrator.test.ts`:** the verify gate treats empty nested `obj/.cache` files as **non-deliverables** (the exact 3:04pm false positive) and accepts the stop; a real empty source file beside an ignored artifact is still flagged.

## Documentation plan

- This ADR.
- **CHANGELOG.md** — entry under `[Unreleased]`.
- **Update [edit-safety.md](../integration/edit-safety.md)** — note that check-command discovery is project-root-aware (works for a project in a subdirectory).
- Reference from the 0011 entry/doc that the deliverable set now excludes build output.
