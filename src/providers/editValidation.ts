/**
 * Edit-safety validation engine (ADR 0006 layer 5).
 *
 * Two pure pieces used by the orchestrator's post-apply validation gate:
 *
 *  - `discoverCheckCommand` maps a workspace's marker files to the project's
 *    OWN check command (dotnet build / npm run / make / cargo check / go build).
 *    Moby ships the MAPPING; the project ships the CHECKER — no bundled
 *    language parsers. A project with no recognised marker yields `null`
 *    (the gate becomes a no-op).
 *
 *  - `normalizeErrors` extracts a line-shift-invariant SET of error signatures
 *    from a tool's stdout/stderr (language-agnostic for toolchains that label
 *    errors with the word "error": dotnet / tsc / cargo / clang / javac).
 *
 *  - `classifyCheckOutcome` turns a before/after check result into a verdict.
 *    It is *differential*: a regression is "this edit made the tree measurably
 *    worse than it started" — a clean→broken exit transition, OR a NEW error
 *    signature that wasn't in the baseline. A tree that was already broken and
 *    gained no new errors is `held` (kept, not reverted); one that gained new
 *    errors is a `regression` even from a broken start (the ratchet). The gate
 *    never blames the model for pre-existing breakage, and works from any
 *    starting state — it never assumes the tree was clean to begin with.
 *
 * Execution (running the command, approval, timeout) and the
 * commit/revert/halt policy live in the orchestrator; these functions stay
 * pure and unit-testable.
 *
 * See docs/architecture/integration/edit-safety.md.
 */

import * as vscode from 'vscode';

/** A discovered project check command and the directory to run it in. */
export interface CheckCommand {
  command: string;
  cwd: string;
  /** Which marker produced this command (diagnostics / logging). */
  source: string;
}

/** npm scripts we will run as a check, in preference order. */
const NPM_SCRIPT_PRIORITY = ['build', 'typecheck', 'test'] as const;
/** Makefile targets we will run as a check, in preference order. */
const MAKE_TARGET_PRIORITY = ['check', 'build'] as const;

/**
 * Discover the project's check command from marker files at the workspace root.
 * Probes a single directory listing + at most one file read, in priority order.
 * Returns `null` when no recognised project type is found — the caller treats
 * that as "no oracle" (the gate is a no-op).
 */
export async function discoverCheckCommand(root: vscode.Uri): Promise<CheckCommand | null> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return null;
  }

  const cwd = root.fsPath;
  const fileNames = entries
    .filter(([, type]) => (type & vscode.FileType.File) !== 0)
    .map(([name]) => name);
  const has = (name: string) => fileNames.includes(name);

  // .NET — a project or solution file anywhere at the root.
  if (fileNames.some(n => n.endsWith('.csproj') || n.endsWith('.sln'))) {
    return { command: 'dotnet build', cwd, source: 'csproj/sln' };
  }

  // Node — only if package.json declares a script we can run as a check.
  if (has('package.json')) {
    const script = await pickNpmScript(root);
    if (script) {
      return { command: `npm run ${script}`, cwd, source: `package.json:${script}` };
    }
  }

  // Make — only if it declares a check/build target.
  if (has('Makefile')) {
    const target = await pickMakeTarget(root);
    if (target) {
      return { command: `make ${target}`, cwd, source: `Makefile:${target}` };
    }
  }

  // Rust.
  if (has('Cargo.toml')) {
    return { command: 'cargo check', cwd, source: 'Cargo.toml' };
  }

  // Go.
  if (has('go.mod')) {
    return { command: 'go build ./...', cwd, source: 'go.mod' };
  }

  return null;
}

/** Read package.json and return the first present script in priority order, or null. */
async function pickNpmScript(root: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'package.json'));
    const pkg = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== 'object') return null;
    return NPM_SCRIPT_PRIORITY.find(s => typeof scripts[s] === 'string') ?? null;
  } catch {
    return null;
  }
}

/** Read the Makefile and return the first present target in priority order, or null. */
async function pickMakeTarget(root: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'Makefile'));
    const text = Buffer.from(bytes).toString('utf8');
    return MAKE_TARGET_PRIORITY.find(t => new RegExp(`^${t}:`, 'm').test(text)) ?? null;
  } catch {
    return null;
  }
}

/** Result of running (or attempting to run) the check command after a batch. */
export interface CheckResult {
  /** False when no command was run (no oracle, not approved, etc.). */
  ran: boolean;
  /** True when the command exceeded its timeout. */
  timedOut?: boolean;
  /** Process exit code when `ran` and not `timedOut` (0 = success). */
  exitCode?: number;
  /**
   * Normalized error signatures parsed from the output (see `normalizeErrors`).
   * Present when `ran`; used to diff a broken baseline against a broken after.
   */
  errors?: string[];
}

/**
 * `clean`   — the tree builds (exit 0).
 * `regression` — this edit made it measurably worse (clean→broken, or a new
 *                error vs. the baseline). The only verdict that authorises a revert.
 * `held`    — still broken, but this edit added no new errors; kept, not reverted.
 * `inconclusive` — couldn't measure or couldn't attribute (no revert, commit).
 */
export type CheckVerdict = 'clean' | 'regression' | 'held' | 'inconclusive';

/**
 * Extract a line-shift-invariant SET of error signatures from check output.
 * Strips volatile source coordinates (line/column) so the SAME logical error
 * compares equal after an edit shifts it down the file, and drops count/summary
 * lines ("5 Error(s)", "Found 3 errors") so a changing count is not mistaken for
 * a changing error. Keeps the file, error code, and message.
 *
 * Language-agnostic for toolchains that print "error" on each diagnostic line
 * (dotnet, tsc, cargo, clang/gcc, javac). Returns `[]` when no error lines are
 * recognised — the caller treats an uncharacterisable failure as inconclusive
 * rather than guessing (e.g. `go build`, which omits the word "error").
 */
export function normalizeErrors(output: string): string[] {
  if (!output) return [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Drop count/summary lines — their numbers change without the errors changing.
    if (/error\(s\)/i.test(line)) continue;            // dotnet "5 Error(s)"
    if (/\b\d+\s+errors?\b/i.test(line)) continue;     // "Found 3 errors", "3 errors generated"
    if (/could not compile/i.test(line)) continue;     // cargo "due to N previous errors"
    // Keep only lines that look like an individual error.
    if (!/\berror\b/i.test(line)) continue;
    const normalized = line
      .replace(/\((\d+),(\d+)\)/g, '')   // (line,col)
      .replace(/\((\d+)\)/g, '')         // (line)
      .replace(/:\d+:\d+:?/g, ':')       // :line:col:
      .replace(/:\d+:/g, ':')            // :line:
      .replace(/\s+/g, ' ')              // collapse whitespace
      .trim();
    if (normalized) seen.add(normalized.slice(0, 500));
    if (seen.size >= 200) break;         // bound pathological output
  }
  return [...seen];
}

/**
 * Classify a batch's validation result against the pre-edit baseline. A
 * `regression` (and only a regression) authorises a revert.
 *
 *  - After didn't run / timed out                  → inconclusive (no evidence).
 *  - After passed (exit 0)                          → clean (builds now, any start).
 *  - After failed, no usable baseline               → inconclusive (can't attribute).
 *  - After failed, baseline was clean               → regression (this edit broke it).
 *  - After failed, baseline broken, a NEW error     → regression (made it worse).
 *  - After failed, baseline broken, no new error    → held (no worse; kept).
 *  - After failed but its errors can't be parsed,
 *    or the baseline's can't                        → inconclusive (don't guess).
 */
export function classifyCheckOutcome(opts: { baseline: CheckResult | null; after: CheckResult }): CheckVerdict {
  const { baseline, after } = opts;

  // No usable AFTER measurement → no evidence.
  if (!after.ran || after.timedOut) return 'inconclusive';
  // The tree builds now → clean, regardless of where it started.
  if (after.exitCode === 0) return 'clean';

  // After failed. Need a usable baseline to attribute the failure.
  if (!baseline || !baseline.ran || baseline.timedOut) return 'inconclusive';
  // Baseline was clean → this edit broke it (exit-code floor, no parsing needed).
  if (baseline.exitCode === 0) return 'regression';

  // Both baseline and after failed → differential on the error SETS.
  const before = baseline.errors ?? [];
  const now = after.errors ?? [];
  // Can't characterise one side → don't guess; abstain (commit, no revert).
  if (before.length === 0 || now.length === 0) return 'inconclusive';
  const beforeSet = new Set(before);
  const introducedNewError = now.some(e => !beforeSet.has(e));
  return introducedNewError ? 'regression' : 'held';
}

/** Order-independent equality of two normalized error sets. */
export function errorSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(e => set.has(e));
}

/** Per-file repair state: the last regression's error set + its consecutive same-error streak. */
export interface FileRepairState {
  lastErrors: string[];
  streak: number;
}

/**
 * Record a regression against the per-file repair tracker and report which
 * files are now STUCK — failed with the SAME error set `limit` times in a row.
 *
 * Keyed PER FILE so the halt signal is "this *file* isn't converging," never
 * "the turn failed N times": three different files each failing once must not
 * halt the turn. A file whose error set CHANGED since its last regression resets
 * to a streak of 1 — progress earns a fresh budget — so a file working through
 * a sequence of *different* bugs is never halted, while one reproducing the
 * *same* failure is. (Because `normalizeErrors` keeps the file path in each
 * signature, different files inherently produce different sets.) Mutates `tracker`.
 */
export function recordRepairRegression(
  tracker: Map<string, FileRepairState>,
  files: string[],
  errors: string[],
  limit: number,
): { stuck: string[]; streaks: Record<string, number> } {
  const stuck: string[] = [];
  const streaks: Record<string, number> = {};
  for (const file of files) {
    const prev = tracker.get(file);
    const streak = prev && errorSetsEqual(prev.lastErrors, errors) ? prev.streak + 1 : 1;
    tracker.set(file, { lastErrors: errors, streak });
    streaks[file] = streak;
    if (streak >= limit) stuck.push(file);
  }
  return { stuck, streaks };
}
