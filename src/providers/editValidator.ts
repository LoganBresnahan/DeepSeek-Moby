/**
 * Edit-safety validation service (ADR 0006 layer 5 — orchestration side).
 *
 * Owns the per-turn state and the run-the-check decision for one auto-apply
 * batch, composing the pure pieces in editValidation.ts. Dependencies (config,
 * approval check, command runner, discovery) are injected so this unit tests
 * without vscode, a real shell, or the orchestrator.
 *
 * Per-batch model (the chosen validation mode): the project's own check command
 * runs once per editing batch. The baseline is carried forward across the turn
 * — the first batch has no baseline (→ inconclusive), and from the second batch
 * on a clean→broken transition is attributed to that batch (→ regression).
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

export class EditValidator {
  private _baselineClean = false;
  // undefined = not resolved yet this turn; null = resolved to "no command".
  private _command: CheckCommand | null | undefined = undefined;

  constructor(private readonly deps: EditValidatorDeps) {}

  /** Reset per-turn state. Call at the start of each user turn. */
  resetTurn(): void {
    this._baselineClean = false;
    this._command = undefined;
  }

  /**
   * Validate one editing batch against the carried-forward baseline. Only a
   * `regression` authorises a revert; `inconclusive`/`skipped` mean commit
   * (the caller may halt on inconclusive per `onInconclusive`).
   */
  async validateBatch(root: vscode.Uri, signal?: AbortSignal): Promise<BatchValidation> {
    const cfg = this.deps.getConfig();
    if (cfg.validate === 'off') {
      return { verdict: 'skipped', note: 'validation disabled (moby.editSafety.validate = off)' };
    }

    // Resolve the check command once per turn.
    if (this._command === undefined) {
      this._command = cfg.validate === 'auto'
        ? await (this.deps.discover ?? discoverCheckCommand)(root)
        : { command: cfg.validate, cwd: root.fsPath, source: 'config' };
    }
    const cmd = this._command;
    if (!cmd) {
      return { verdict: 'inconclusive', note: 'no project check command could be discovered' };
    }

    // Only run an already-approved command — never pop an approval prompt from
    // an automatic step, never bypass the approval system.
    const approval = this.deps.checkApproval(cmd.command);
    if (approval !== 'allowed') {
      return { verdict: 'inconclusive', command: cmd.command, note: `check command is not approved (${approval}); run it once to allow it` };
    }

    let run: RunOutcome;
    try {
      run = await this.deps.runCommand(cmd.command, cmd.cwd, cfg.timeoutMs, signal);
    } catch (e: any) {
      return { verdict: 'inconclusive', command: cmd.command, note: `check command failed to run: ${e?.message ?? e}` };
    }

    const after: CheckResult = { ran: true, timedOut: run.timedOut, exitCode: run.exitCode };
    const verdict = classifyCheckOutcome({ baselineClean: this._baselineClean, after });

    // Carry the baseline forward. clean → tree is clean; regression → caller
    // reverts, so the tree is restored to its (clean) pre-batch state; otherwise
    // the baseline is whatever the committed tree actually is.
    const afterClean = !run.timedOut && run.exitCode === 0;
    this._baselineClean = verdict === 'clean' || verdict === 'regression' ? true : afterClean;

    return { verdict, command: cmd.command, output: run.output };
  }
}
