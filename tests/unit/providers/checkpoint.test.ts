/**
 * Edit-safety Phase 1 — checkpoint (the keystone).
 *
 * Pending spec scaffolding for ADR 0006. Each it.todo mirrors a row in the
 * test matrix at docs/architecture/integration/edit-safety.md and becomes a
 * real test when the EditTransaction / checkpoint layer lands in DiffManager.
 *
 * Harness to follow once implemented: vi.hoisted() WorkingEventEmitter +
 * vi.mock('vscode') + the DiffManager mock factories already used in
 * tests/unit/providers/diffManager.test.ts.
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 3)
 */

import { describe, it } from 'vitest';

describe('edit-safety / checkpoint (ADR 0006, Phase 1)', () => {
  it.todo('snapshots original content before the first write to a file');
  it.todo('snapshot is idempotent per file across multiple edits in one batch');
  it.todo('multiple files in one batch are each snapshotted independently');
  it.todo('revert restores exact original bytes for every checkpointed file');
  it.todo('revert is a no-op after a committed batch');
  it.todo('checkpoint is discarded after a successful commit (no cross-batch leak)');
  it.todo('snapshot survives the per-edit writes that happen within the batch');
});
