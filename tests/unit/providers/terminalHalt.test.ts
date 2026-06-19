/**
 * Edit-safety Phase 3 — bounded autonomy + terminal halt (no mode switching).
 *
 * Pending spec scaffolding for ADR 0006. Each it.todo mirrors a row in the
 * test matrix at docs/architecture/integration/edit-safety.md and becomes a
 * real test when the repair loop's terminal halt + inconclusive handling land.
 *
 * Auto mode stays Auto: it reverts and retries autonomously, and on
 * repair-budget exhaustion HALTS the turn (files at last-good) — it never
 * demotes the user into per-edit Ask approval. See ADR 0006 Alternative G.
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 7)
 */

import { describe, it } from 'vitest';

describe('edit-safety / bounded autonomy + terminal halt (ADR 0006, Phase 3)', () => {
  it.todo('a confirmed regression triggers revert + autonomous retry (no Ask prompt is shown)');
  it.todo('retries are bounded by maxRepairAttempts');
  it.todo('on repair-budget exhaustion the turn halts: files left reverted at last-good');
  it.todo('the halt status clearly reports what failed and that the file was reverted');
  it.todo('inconclusive (no check command discovered) → commit + one-time note, no halt, no revert');
  it.todo('inconclusive (validation timeout) → commit + note, no halt, no revert (default onInconclusive=commit)');
  it.todo('onInconclusive="halt" → halt instead of commit on an inconclusive outcome');
  it.todo('Auto mode never injects an Ask diff-approval prompt (mode-integrity guard)');
});
