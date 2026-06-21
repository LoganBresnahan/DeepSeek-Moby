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

  it('a passing check is clean even on the first batch (a pass needs no baseline)', async () => {
    const { validator, runCommand } = makeValidator({ runCommand: vi.fn(async () => pass) });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('clean');
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('a passing check on a later batch is also clean', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);           // first batch — clean, sets baseline
    const r = await validator.validateBatch(ROOT); // baseline clean
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

  it('a regression result carries the NORMALIZED error set (what per-file repair tracking diffs on)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass) // baseline clean
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(3,5): error CS1002: ; expected' });
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('regression');
    expect(r.errors).toHaveLength(1);
    expect(r.errors?.[0]).toContain('CS1002');
    expect(r.errors?.[0]).not.toMatch(/\d+,\d+/); // coordinates stripped → line-shift invariant
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

  it('resetTurn clears the baseline so a failure can no longer be attributed', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)  // batch 1: clean, baseline now clean
      .mockResolvedValueOnce(fail)  // batch 2: regression (clean→broken)
      .mockResolvedValueOnce(fail); // batch 3 after reset: inconclusive (no baseline)
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('regression');

    validator.resetTurn();
    expect((await validator.validateBatch(ROOT)).verdict).toBe('inconclusive');
  });

  it('a ran-but-unattributable inconclusive carries a real note (not "no validation signal")', async () => {
    // No baseline measured, then a failing batch — can't attribute.
    const runCommand = vi.fn(async () => fail);
    const { validator } = makeValidator({ runCommand });
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('inconclusive');
    expect(r.note).toMatch(/no comparable clean baseline/);
  });
});

describe('EditValidator.ensureBaseline (ADR 0006, Phase 2 — pre-edit probe)', () => {
  let pass: RunOutcome;
  let fail: RunOutcome;

  beforeEach(() => {
    pass = { exitCode: 0, timedOut: false, output: 'Build succeeded' };
    fail = { exitCode: 1, timedOut: false, output: 'error CS1002: ; expected' };
  });

  it('a clean pristine probe lets the FIRST failing edit be caught as a regression', async () => {
    // The bug this fixes: a single-edit turn whose one edit breaks the build.
    const runCommand = vi.fn()
      .mockResolvedValueOnce(pass)  // ensureBaseline: pristine tree is clean
      .mockResolvedValueOnce(fail); // first (and only) batch: breaks the build
    const { validator } = makeValidator({ runCommand });

    expect(await validator.ensureBaseline(ROOT)).toBe('clean');
    const r = await validator.validateBatch(ROOT);

    expect(r.verdict).toBe('regression'); // would have been 'inconclusive' without the probe
    expect(r.output).toMatch(/CS1002/);
  });

  it('broken baseline + the SAME errors → held (kept, not reverted)', async () => {
    const err = { exitCode: 1, timedOut: false, output: 'a.cs(10,5): error CS1002: ; expected' };
    const runCommand = vi.fn()
      .mockResolvedValueOnce(err)   // ensureBaseline: tree was ALREADY broken
      .mockResolvedValueOnce(err);  // first batch fails with the same error — no worse
    const { validator } = makeValidator({ runCommand });

    expect(await validator.ensureBaseline(ROOT)).toBe('broken');
    expect((await validator.validateBatch(ROOT)).verdict).toBe('held');
  });

  it('broken baseline + a line-SHIFTED same error → held (normalization ignores line moves)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(10,5): error CS1002: ; expected' })
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(14,5): error CS1002: ; expected' });
    const { validator } = makeValidator({ runCommand });

    await validator.ensureBaseline(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('held'); // same error, moved down — not a regression
  });

  it('broken baseline + a NEW error → regression (the ratchet reverts it even from a broken start)', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(10,5): error CS1002: ; expected' })
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(10,5): error CS1002: ; expected\nb.cs(3,1): error CS0103: SomeMethodThatDoesNotExist' });
    const { validator } = makeValidator({ runCommand });

    await validator.ensureBaseline(ROOT);
    const r = await validator.validateBatch(ROOT);
    expect(r.verdict).toBe('regression');
    expect(r.output).toMatch(/CS0103/);
  });

  it('broken baseline + FEWER errors (progress) → held, and the baseline ratchets down', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(1,1): error CS1: x\na.cs(2,2): error CS2: y' }) // baseline: 2 errors
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(1,1): error CS1: x' })                          // fixed one → held
      .mockResolvedValueOnce({ exitCode: 1, timedOut: false, output: 'a.cs(1,1): error CS1: x\nc.cs(9,9): error CS9: z' }); // re-introduces a 2nd → regression vs the ratcheted baseline
    const { validator } = makeValidator({ runCommand });

    await validator.ensureBaseline(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('held');       // 2 → 1
    expect((await validator.validateBatch(ROOT)).verdict).toBe('regression'); // 1 → 2 (new error vs. the now-current baseline)
  });

  it('a clean pristine probe + a passing first edit is clean', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    await validator.ensureBaseline(ROOT);
    expect((await validator.validateBatch(ROOT)).verdict).toBe('clean');
  });

  it('probes at most once per turn (idempotent), reset by resetTurn', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    expect(await validator.ensureBaseline(ROOT)).toBe('clean');
    expect(await validator.ensureBaseline(ROOT)).toBe('skipped');
    expect(await validator.ensureBaseline(ROOT)).toBe('skipped');
    expect(runCommand).toHaveBeenCalledOnce();

    validator.resetTurn();
    await validator.ensureBaseline(ROOT);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('a validateBatch already establishes the baseline, so a later ensureBaseline is a no-op', async () => {
    const runCommand = vi.fn(async () => pass);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT); // first batch probes + sets baseline
    await validator.ensureBaseline(ROOT); // must not re-run the check
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('is a no-op when validation is off (no probe build)', async () => {
    const { validator, runCommand } = makeValidator({ getConfig: () => ({ validate: 'off', timeoutMs: 1000 }) });
    expect(await validator.ensureBaseline(ROOT)).toBe('unknown');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('leaves the baseline unknown when no command can be discovered (probe cannot run)', async () => {
    // No oracle → baseline stays unprobed → a first failing edit is inconclusive,
    // and a subsequent discoverable run is unaffected.
    const runCommand = vi.fn(async () => fail);
    const { validator } = makeValidator({ discover: async () => null, runCommand });
    await validator.ensureBaseline(ROOT);
    expect(runCommand).not.toHaveBeenCalled();
    expect((await validator.validateBatch(ROOT)).verdict).toBe('inconclusive');
  });

  it('does not establish a baseline from a probe that threw (stays unknown)', async () => {
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new Error('spawn ENOENT')) // probe throws
      .mockResolvedValueOnce(fail);                     // first batch fails
    const { validator } = makeValidator({ runCommand });
    await validator.ensureBaseline(ROOT);
    // Baseline never established → failure can't be attributed → inconclusive.
    expect((await validator.validateBatch(ROOT)).verdict).toBe('inconclusive');
  });
});

describe('EditValidator — last-verdict accessors (ADR 0011)', () => {
  const pass: RunOutcome = { exitCode: 0, timedOut: false, output: 'Build succeeded' };
  const fail: RunOutcome = { exitCode: 1, timedOut: false, output: 'a.cs(10,5): error CS1002: ; expected' };

  it('getLastVerdict is null before any batch, then the last verdict after validateBatch', async () => {
    const { validator } = makeValidator({ runCommand: vi.fn(async () => pass) });
    expect(validator.getLastVerdict()).toBeNull();
    await validator.validateBatch(ROOT);
    expect(validator.getLastVerdict()).toBe('clean');
  });

  it('tracks the verdict across batches (clean → regression)', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(pass).mockResolvedValueOnce(fail);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);                 // clean baseline
    expect(validator.getLastVerdict()).toBe('clean');
    await validator.validateBatch(ROOT);                 // regression
    expect(validator.getLastVerdict()).toBe('regression');
  });

  it('getLastBatch carries the captured build output on a regression', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(pass).mockResolvedValueOnce(fail);
    const { validator } = makeValidator({ runCommand });
    await validator.validateBatch(ROOT);
    await validator.validateBatch(ROOT);
    expect(validator.getLastBatch()?.verdict).toBe('regression');
    expect(validator.getLastBatch()?.output).toMatch(/CS1002/);
  });

  it('resetTurn clears the last verdict and batch back to null', async () => {
    const { validator } = makeValidator({ runCommand: vi.fn(async () => pass) });
    await validator.validateBatch(ROOT);
    expect(validator.getLastVerdict()).toBe('clean');
    validator.resetTurn();
    expect(validator.getLastVerdict()).toBeNull();
    expect(validator.getLastBatch()).toBeNull();
  });
});
