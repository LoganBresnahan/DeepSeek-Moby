/**
 * Edit-safety validation service (ADR 0006 layer 5 — orchestration side).
 *
 * Owns the per-turn state and the run-the-check decision for one auto-apply
 * batch, composing the pure pieces in editValidation.ts. Dependencies (config,
 * approval check, command runner, discovery) are injected so this unit tests
 * without vscode, a real shell, or the orchestrator.
 *
 * Per-batch model (the chosen validation mode): the project's own check command
 * runs once per editing batch. The baseline is the tree's pre-edit state —
 * `ensureBaseline` probes it on the PRISTINE tree before the turn's first edit
 * applies, so even a single-edit turn that breaks the build is attributed to
 * that batch (clean baseline + failing check → regression). A turn that starts
 * from an already-broken tree keeps a non-clean baseline, so a failing check is
 * inconclusive (the model is never blamed for pre-existing breakage). After the
 * first batch the baseline is carried forward across the turn.
 *
 * IMPORTANT coupling: `validateBatch` updates its baseline assuming the caller
 * REVERTS the batch on a `regression` verdict (so the tree returns to the clean
 * pre-batch state). The orchestrator settle point honours that contract.
 *
 * See docs/architecture/integration/edit-safety.md.
 */

import * as vscode from 'vscode';
import {
  discoverCheckCommand,
  classifyCheckOutcome,
  CheckCommand,
  CheckResult,
  CheckVerdict,
} from './editValidation';

export interface ValidatorConfig {
  /** "off" | "auto" | an explicit command string. */
  validate: string;
  timeoutMs: number;
}

export type ApprovalState = 'allowed' | 'ask' | 'blocked';

export interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  /** Combined stdout/stderr, for feeding compiler errors back to the model. */
  output: string;
}

export interface EditValidatorDeps {
  getConfig(): ValidatorConfig;
  /** Approval state for a command — only an already-`allowed` command runs. */
  checkApproval(command: string): ApprovalState;
  runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutcome>;
  /** Injectable for tests; defaults to the real marker-based discovery. */
  discover?(root: vscode.Uri): Promise<CheckCommand | null>;
}

export interface BatchValidation {
  /** `skipped` = validation disabled; otherwise the delta-scoped verdict. */
  verdict: CheckVerdict | 'skipped';
  command?: string;
  /** Check output on a regression — fed back to the model. */
  output?: string;
  /** Human/log explanation for skipped / inconclusive outcomes. */
  note?: string;
}

/** Outcome of resolving + approving + running the check once. */
type CheckAttempt =
  | { kind: 'skipped'; note: string }
  | { kind: 'no-command'; note: string }
  | { kind: 'not-approved'; command: string; note: string }
  | { kind: 'threw'; command: string; note: string }
  | { kind: 'ran'; command: string; outcome: RunOutcome };

export class EditValidator {
  private _baselineClean = false;
  /** True once the baseline has been measured this turn (pristine probe or a batch). */
  private _baselineProbed = false;
  // undefined = not resolved yet this turn; null = resolved to "no command".
  private _command: CheckCommand | null | undefined = undefined;

  constructor(private readonly deps: EditValidatorDeps) {}

  /** Reset per-turn state. Call at the start of each user turn. */
  resetTurn(): void {
    this._baselineClean = false;
    this._baselineProbed = false;
    this._command = undefined;
  }

  /**
   * Establish the pre-edit baseline by running the check on the CURRENT tree,
   * BEFORE the turn's first edit is applied. Idempotent per turn. A definitive
   * pass/fail records whether the tree was clean going in; if the check can't
   * run (disabled, no command, not approved, threw, timed out) the baseline
   * stays unknown and a first-edit failure remains inconclusive — never a false
   * revert. Cheap to call before every edit: only the first one actually probes.
   *
   * Returns the probe status for logging: `clean`/`broken` when it ran,
   * `unknown` when it couldn't, `skipped` when the baseline was already set.
   */
  async ensureBaseline(root: vscode.Uri, signal?: AbortSignal): Promise<'clean' | 'broken' | 'unknown' | 'skipped'> {
    if (this._baselineProbed) return 'skipped';
    const attempt = await this.runCheck(root, signal);
    if (attempt.kind !== 'ran') return 'unknown';
    this._baselineClean = attempt.outcome.exitCode === 0 && !attempt.outcome.timedOut;
    this._baselineProbed = true;
    return this._baselineClean ? 'clean' : 'broken';
  }

  /**
   * Validate one editing batch against the baseline. Only a `regression`
   * authorises a revert; `inconclusive`/`skipped` mean commit (the caller may
   * halt on inconclusive per `onInconclusive`).
   */
  async validateBatch(root: vscode.Uri, signal?: AbortSignal): Promise<BatchValidation> {
    const attempt = await this.runCheck(root, signal);
    switch (attempt.kind) {
      case 'skipped':
        return { verdict: 'skipped', note: attempt.note };
      case 'no-command':
        return { verdict: 'inconclusive', note: attempt.note };
      case 'not-approved':
      case 'threw':
        return { verdict: 'inconclusive', command: attempt.command, note: attempt.note };
    }

    // The check ran to completion (pass or fail).
    const run = attempt.outcome;
    const after: CheckResult = { ran: true, timedOut: run.timedOut, exitCode: run.exitCode };
    const verdict = classifyCheckOutcome({ baselineClean: this._baselineClean, after });

    // Carry the baseline forward. clean → tree is clean; regression → caller
    // reverts, so the tree is restored to its (clean) pre-batch state; otherwise
    // the baseline is whatever the committed tree actually is.
    const afterClean = !run.timedOut && run.exitCode === 0;
    this._baselineClean = verdict === 'clean' || verdict === 'regression' ? true : afterClean;
    this._baselineProbed = true;

    // Give the "ran but couldn't act on it" inconclusive cases an accurate note
    // so the log never reads as "no validation signal" when the check DID run.
    let note: string | undefined;
    if (verdict === 'inconclusive') {
      note = run.timedOut
        ? `check "${attempt.command}" timed out`
        : `check "${attempt.command}" is failing, but the tree was already failing before this edit — not attributed to this batch`;
    }

    return { verdict, command: attempt.command, output: run.output, note };
  }

  /**
   * Resolve the check command (once per turn), confirm it's approved, and run
   * it. Pure orchestration of the injected deps; shared by `ensureBaseline` and
   * `validateBatch` so a pristine probe and a post-edit check are identical.
   */
  private async runCheck(root: vscode.Uri, signal?: AbortSignal): Promise<CheckAttempt> {
    const cfg = this.deps.getConfig();
    if (cfg.validate === 'off') {
      return { kind: 'skipped', note: 'validation disabled (moby.editSafety.validate = off)' };
    }

    // Resolve the check command once per turn.
    if (this._command === undefined) {
      this._command = cfg.validate === 'auto'
        ? await (this.deps.discover ?? discoverCheckCommand)(root)
        : { command: cfg.validate, cwd: root.fsPath, source: 'config' };
    }
    const cmd = this._command;
    if (!cmd) {
      return { kind: 'no-command', note: 'no project check command could be discovered' };
    }

    // Only run an already-approved command — never pop an approval prompt from
    // an automatic step, never bypass the approval system.
    const approval = this.deps.checkApproval(cmd.command);
    if (approval !== 'allowed') {
      return { kind: 'not-approved', command: cmd.command, note: `check command is not approved (${approval}); run it once to allow it` };
    }

    try {
      const outcome = await this.deps.runCommand(cmd.command, cmd.cwd, cfg.timeoutMs, signal);
      return { kind: 'ran', command: cmd.command, outcome };
    } catch (e: any) {
      return { kind: 'threw', command: cmd.command, note: `check command failed to run: ${e?.message ?? e}` };
    }
  }
}
