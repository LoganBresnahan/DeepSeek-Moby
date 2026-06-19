/**
 * Edit-safety validation service (ADR 0006 layer 5) — per-turn baseline +
 * run-the-check decision, with all deps injected (no vscode / shell needed).
 *
 * Spec: docs/architecture/integration/edit-safety.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditValidator, EditValidatorDeps, RunOutcome, ApprovalState } from '../../../src/providers/editValidator';

const ROOT = { fsPath: '/workspace' } as any;

function makeValidator(overrides: Partial<EditValidatorDeps> = {}) {
  // Resolve runCommand to the override (if any) so the returned spy is the one
  // the validator actually calls.
  const runCommand = overrides.runCommand
    ?? vi.fn(async (): Promise<RunOutcome> => ({ exitCode: 0, timedOut: false, output: '' }));
  const deps: EditValidatorDeps = {
    getConfig: () => ({ validate: 'auto', timeoutMs: 60000 }),
    checkApproval: (): ApprovalState => 'allowed',
    discover: async () => ({ command: 'dotnet build', cwd: '/workspace', source: 'csproj' }),
    ...overrides,
    runCommand, // after spread: deps.runCommand === the returned spy
  };
  return { validator: new EditValidator(deps), runCommand };
}

describe('EditValidator.validateBatch (ADR 0006, Phase 2)', () => {
  let pass: RunOutcome;
  let fail: RunOutcome;

  beforeEach(() => {
    pass = { exitCode: 0, timedOut: false, output: 'Build succeeded' };
    fail = { exitCode: 1, timedOut: false, output: 'error CS1002: ; expected' };
  });

  it('skips entirely when validate = off (no command run)', async () => {
    const { validator, runCommand } = makeValidator({ getConfig: () => ({ validate: 'off', timeoutMs: 1000 }) });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('skipped');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('is inconclusive when no command can be discovered', async () => {
    const { validator, runCommand } = makeValidator({ discover: async () => null });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('inconclusive');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('is inconclusive (and does not run) when the command is not approved', async () => {
    const { validator, runCommand } = makeValidator({ checkApproval: () => 'ask' });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('inconclusive');
    expect(r.note).toMatch(/not approved/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('uses an explicit command from config without discovery', async () => {
    const discover = vi.fn(async () => null);
    const { validator, runCommand } = makeValidator({
      getConfig: () => ({ validate: 'npm run check', timeoutMs: 1000 }),
      discover,
    });
    await validator.validateBatch(ROOT);
    expect(discover).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith('npm run check', '/workspace', 1000, undefined);
  });

  it('first batch has no baseline → inconclusive even when the check passes', async () => {
    const { validator, runCommand } = makeValidator({ runCommand: vi.fn(async () => pass) });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('inconclusive');
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('after a clean baseline, a passing check → clean', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);           // establishes baseline (inconclusive)
    const r = await validator.validateBatch(ROOT); // baseline now clean
    expect(r.verdict).toBe('clean');
  });

  it('after a clean baseline, a failing check → regression (carries the output)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)  // batch 1: establishes clean baseline
      .mockResolvedValueOnce(fail); // batch 2: regression
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('regression');
    expect(r.output).toMatch(/CS1002/);
  });

  it('a regression keeps the baseline clean (caller reverts to the clean tree)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)  // baseline clean
      .mockResolvedValueOnce(fail)  // regression (reverted by caller)
      .mockResolvedValueOnce(fail); // next batch is again delta-detected
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('regression');
    expect((await validator.validateBatch(ROOT)).verdict).toBe('regression');
  });

  it('a timeout is inconclusive, not a regression', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce({ exitCode: 1, timedOut: true, output: '' });
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('inconclusive');
  });

  it('runCommand throwing is inconclusive (never a false regression)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)
      .mockRejectedValueOnce(new Error('spawn ENOENT'));
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('inconclusive');
    expect(r.note).toMatch(/ENOENT/);
  });

  it('discovers the command once per turn (cached across batches), reset on resetTurn', async () => {
    const discover = vi.fn(async () => ({ command: 'dotnet build', cwd: '/workspace', source: 'csproj' }));
    const { validator } = makeValidator({ discover, runCommand: vi.fn(async () => pass) });
    await validator.validateBatch(ROOT);
    await validator.validateBatch(ROOT);
    expect(discover).toHaveBeenCalledOnce();

    validator.resetTurn();
    await validator.validateBatch(ROOT);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('resetTurn clears the baseline so the first batch of the next turn is inconclusive again', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('clean'); // baseline established

    validator.resetTurn();
    expect((await validator.validateBatch(ROOT)).verdict).toBe('inconclusive'); // baseline gone
  });
});
