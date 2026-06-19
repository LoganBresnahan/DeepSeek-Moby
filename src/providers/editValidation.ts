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
 *  - `classifyCheckOutcome` turns a before/after check result into a verdict.
 *    It is delta-scoped: a project that was already broken before the batch
 *    (`baselineClean === false`) is `inconclusive`, never a `regression`, so the
 *    gate never blames the model for pre-existing breakage.
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
}

export type CheckVerdict = 'clean' | 'regression' | 'inconclusive';

/**
 * Classify a batch's validation result. A `regression` (and only a regression)
 * authorises a revert. The baseline is only consulted to *attribute a failure*
 * — a passing post-edit check is proof the edit is fine and needs no baseline:
 *
 *  - The check didn't run or timed out      → inconclusive (no evidence).
 *  - After-check passed                      → clean (the tree builds now).
 *  - After-check failed, baseline was clean  → regression (this batch broke it).
 *  - After-check failed, baseline not clean  → inconclusive (can't attribute;
 *    the project was already broken, so reverting this batch wouldn't fix it).
 */
export function classifyCheckOutcome(opts: { baselineClean: boolean; after: CheckResult }): CheckVerdict {
  const { baselineClean, after } = opts;
  if (!after.ran || after.timedOut) return 'inconclusive';
  if (after.exitCode === 0) return 'clean';
  return baselineClean ? 'regression' : 'inconclusive';
}
