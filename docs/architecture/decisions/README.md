# Architecture Decision Records (ADRs)

Short, dated records of significant architectural and behavioral decisions. Each ADR captures **what** was decided, **why**, what was rejected, and what the consequences are. ADRs are immutable — when a decision is changed, write a new ADR that supersedes the old one rather than editing.

## Format

`NNNN-short-slug.md` where `NNNN` is a zero-padded sequence number. Use the [template](_template.md) when adding new ADRs.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-stop-button-discards-partial.md) | Stop button discards partial assistant content | Accepted | 2026-04-17 |
| [0002](0002-strip-heredocs-before-long-running-check.md) | Strip heredocs before long-running command pattern matching | Accepted | 2026-04-17 |
| [0003](0003-events-table-sole-source-of-truth.md) | Events table is the sole source of truth for session history | Accepted | 2026-04-19 |
| [0004](0004-r1-path-semantics-guards.md) | R1 path-semantics guards and model-specific guard policy | Accepted | 2026-04-20 |
| [0005](0005-preserve-bundler-ts-module-resolution.md) | TypeScript module resolution: preserve + bundler | Accepted | 2026-04-26 |
| [0006](0006-edit-safety-checkpoint-and-validation.md) | Edit safety: checkpoint, atomic batch, and post-apply validation | Accepted | 2026-06-19 |
| [0007](0007-system-prompt-temporal-grounding.md) | System-prompt temporal grounding: standing date + staleness directive | Accepted | 2026-06-20 |
| [0008](0008-request-scoped-stream-lifecycle-and-interrupt-teardown.md) | Request-scoped stream lifecycle and interrupt teardown | Accepted | 2026-06-20 |
| [0009](0009-active-plan-recency-pinning.md) | Active-plan recency pinning (context salience) | Accepted | 2026-06-20 |
| [0010](0010-web-search-query-ledger-and-cache.md) | Web-search query ledger and near-duplicate cache | Accepted | 2026-06-20 |
| [0011](0011-verification-gated-turn-completion.md) | Verification-gated turn completion | Accepted | 2026-06-20 |
| [0012](0012-project-root-awareness.md) | Project-root awareness (workspace root ≠ project root) | Accepted | 2026-06-21 |
| [0013](0013-temporal-grounding-data-seeding.md) | Temporal grounding II: data-seeding classification clause | Accepted | 2026-06-21 |

## When to write an ADR

- Choosing between non-trivial alternatives where the tradeoffs matter
- Behavior changes that users could notice and might disagree with
- Architectural shifts (new patterns, new modules, removed abstractions)
- Decisions that future-you (or another developer) might want to revisit and would need context for

Don't write ADRs for trivial bug fixes, refactors that preserve behavior, or implementation details that are obvious from the code.
