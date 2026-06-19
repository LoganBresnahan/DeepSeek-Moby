/**
 * Edit-safety Phase 1 — atomic batch (commit/revert the whole tool-iteration).
 *
 * Pending spec scaffolding for ADR 0006. Each it.todo mirrors a row in the
 * test matrix at docs/architecture/integration/edit-safety.md and becomes a
 * real test when the batch transaction wraps the auto-apply path
 * (requestOrchestrator _onToolCallsStart … _onToolCallsEnd).
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 4)
 */

import { describe, it } from 'vitest';

describe('edit-safety / atomic batch (ADR 0006, Phase 1)', () => {
  it.todo('a batch of all-valid edits commits every file');
  it.todo('a batch where edit N fails reverts edits 1..N-1 (no partial state)');
  it.todo('a single-edit batch behaves identically to today (back-compat)');
  it.todo('batch boundary aligns with _onToolCallsEnd (one validate/commit per iteration)');
  it.todo('emitAutoAppliedChanges fires only after commit, never before revert');
  it.todo('ask-mode early batch-close does not corrupt transaction state');
});
