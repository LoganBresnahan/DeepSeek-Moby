/**
 * Edit-safety Phase 2 — validation gate (project toolchain, delta-scoped).
 *
 * Pending spec scaffolding for ADR 0006. Each it.todo mirrors a row in the
 * test matrix at docs/architecture/integration/edit-safety.md and becomes a
 * real test when ProjectCheck discovery + the delta-diagnostics gate land.
 * The gate runs the user's OWN build/test via executeShellCommand under
 * CommandApprovalManager — no bundled language parsers.
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 5)
 */

import { describe, it } from 'vitest';

describe('edit-safety / validation gate (ADR 0006, Phase 2)', () => {
  it.todo('discovers dotnet build from a .csproj; npm run build from package.json; make from a Makefile');
  it.todo('no marker matched → gate is a no-op (commit), per default config');
  it.todo('check command routed through CommandApproval; blocked → no-op + surfaced, no bypass');
  it.todo('timeout → inconclusive (not a false regression)');
  it.todo('delta: a pre-existing error does not count as a regression');
  it.todo('delta: a new error in a touched file counts as a regression');
  it.todo('delta: a new error only in an untouched file does not count');
  it.todo('clean build → commit');
  it.todo('validate: "off" → gate skipped entirely');
  it.todo('validation runs exactly once per batch, not per edit');
});
