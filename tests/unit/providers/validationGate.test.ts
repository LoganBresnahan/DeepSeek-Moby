/**
 * Edit-safety Phase 2 — validation gate WIRING (orchestrator side).
 *
 * The engine-level pieces — command discovery and delta-scoped outcome
 * classification — are real tests in editValidation.test.ts. The rows below are
 * the orchestration behaviours that land when the gate is wired into the
 * batch settle point: running the discovered command under CommandApproval,
 * once per batch, and mapping the verdict to commit / revert / inconclusive.
 *
 * The gate runs the user's OWN build/test via executeShellCommand under
 * CommandApprovalManager — no bundled language parsers.
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 5)
 */

import { describe, it } from 'vitest';

describe('edit-safety / validation gate wiring (ADR 0006, Phase 2)', () => {
  it.todo('runs the discovered check command via executeShellCommand under CommandApproval');
  it.todo('a blocked / unapproved check command → no-op + surfaced, never a silent bypass');
  it.todo('no command discovered → gate is a no-op (commit), per default onInconclusive');
  it.todo('a clean check → commits the batch and reports success');
  it.todo('validate: "off" → gate skipped entirely (no command run)');
  it.todo('validation runs exactly once per batch, not per edit');
  it.todo('a timeout is treated as inconclusive, not a regression (no revert)');
});
