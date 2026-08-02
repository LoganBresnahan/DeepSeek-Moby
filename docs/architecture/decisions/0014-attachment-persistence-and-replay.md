# 0014. Attachment persistence and replay (blobs beside the events table)

**Status:** Accepted — implemented.
**Date:** 2026-08-02

Amends ADR [0003](0003-events-table-sole-source-of-truth.md). 0003's contract — the events table is the sole source of truth for session history — was never actually met for attachments: they were injected into model context live and persisted nowhere. This ADR closes that hole and records where the bytes live.

## Context

Attachments were a live-only side channel. `recordUserMessage` was called without them, and the `--- Attached Files ---` block was appended to the *ephemeral* per-request message array. Nothing about an attachment reached the database.

The consequences compounded:

- **Context drift on reload.** A reloaded session rebuilt model context without the attachment block, so the model silently saw a different conversation than the one that happened. Survivable for text — the file is usually still on disk, and the model can re-read it — but the divergence is invisible: nothing in the UI or the logs says the context changed.
- **A permanently-dead UI mapping.** `ConversationManager` had been mapping `attachments → files` for restore against data that was always `undefined`.
- **A hard blocker for images.** For the planned `image-describe` subagent ([plan](../../plans/image-describe-subagent.md)), the digest *is* the only record — full-resolution bytes are deliberately not kept. Persisting an image digest onto this foundation would bake in a reload-only failure that is green when tested live.

So the fix is sequenced before any image work, and ships standalone value for text attachments.

## Decision

### 1. Attachments persist on the `user_message` event; context is materialized on read

`prepareAttachmentsForPersistence` converts incoming attachments to a stored shape at record time; `formatAttachmentsForContext` rebuilds the context block at read time. Both live in [attachmentContext.ts](../../../src/events/attachmentContext.ts).

The read side has **exactly one call site**: `getSessionMessagesCompat`. The live injection in [requestOrchestrator.ts](../../../src/providers/requestOrchestrator.ts) is **deleted**, not kept alongside it. This is the load-bearing part of the design and the likeliest thing to be re-broken later, so it is worth stating plainly: the user message is recorded *before* context is built, so replay already covers the current turn. Two callers would double-inject it. `replay-equivalence` tests pin that the block appears exactly once.

The event's `content` stays raw user text — the block is never baked into it. That keeps the stored fact ("user said X and attached Y") separate from the presentation choice of how attachments are rendered into a prompt, so the format can change without rewriting history.

### 2. Payloads live in the DB, content-addressed, in their own table

Migration version 1 → 2 (the schema's first versioned upgrade) adds `attachment_blobs` keyed by `sha256(bytes)` and an `event_blobs` link table. `events.data` carries only `{blobId, bytes, name, type}`.

*Why in the DB rather than sidecar files:* forking is zero-copy — `event_sessions` links one event row to N sessions — so a filesystem reference makes deletion a refcounting problem whose failure mode is silent, discovered months later as broken attachments in old transcripts. Sidecar files also fall outside SQLCipher's encryption envelope: a user attaches a file containing credentials and it lands plaintext on disk, a real regression against the DB's threat model.

*Why not inline in `events.data`:* the cost is hydration, not disk. `loadHistory` eagerly loads and `JSON.parse`s every event, then `postMessage`s the lot across the webview boundary, where `VirtualListActor` recycles most turns without drawing them. Inline bodies would be structure-cloned on every session load, restore, and fork.

*Why content-addressed:* re-attaching the same file stores nothing new, and forks share blobs by hash rather than copying — matching how `event_sessions` already treats events.

Lifetime follows events. Deleting a session cascades `event_blobs` links away; `collectGarbage()` then drops unreferenced blobs, inside `deleteSession`'s existing orphan-cleanup transaction so a crash between the two cannot strand rows.

### 3. Persisted bodies are capped

`MAX_PERSISTED_ATTACHMENT_BYTES` (256KB) bounds what is stored per attachment; larger bodies are truncated with an explicit marker naming the omitted byte count.

This is a deliberate behavior change: because replay is now the *only* path, the cap applies to the live turn too. A 5MB attachment previously reached the model in full and reached persistence not at all. Telling the model its input is partial is better than either silently clipping it or accepting unbounded rows that must be read back on every turn.

## Consequences

- Reload and fork rebuild byte-identical context. The `--- Attached Files ---` format is unchanged, so this is invisible to models and to existing prompts.
- `Attachment.content` becomes optional; persisted attachments carry `blobId` instead. A missing blob renders an explicit `[attachment content unavailable …]` marker rather than an empty code fence, which would read to the model as "the user attached a blank file."
- **The migration is one-way.** A database touched by this build and then opened by an older build loses blob rows. Additive-only and fine for a pre-release extension; worth a release-note line.
- Images are skipped by the text formatter by construction (`type !== 'image'`), so an image can never ride the `--- Attached Files ---` path once capture lands.

## Alternatives considered

**Keep the live injection and add persistence alongside it.** Smaller diff, and tempting because the live path demonstrably works. Rejected: with record-before-read, both paths fire on the current turn and the block doubles. The failure is also asymmetric in the worst way — live turns get two copies, reloaded turns get one — so the bug reproduces only in the case that is least often tested.

**Sidecar files + a path reference.** Cheapest to implement and keeps the DB small. Rejected on two counts: silent refcounting failures under zero-copy forking, and dropping attachment bytes out of SQLCipher's encryption envelope.

**Inline base64 in `events.data`.** No new tables, no GC. Rejected on hydration cost — see Decision 2.

**Store the formatted context block instead of the raw payload.** Would make replay a trivial string read. Rejected: it freezes the prompt format into history, so any later change to how attachments are presented would silently apply to new turns only, leaving a session's own history internally inconsistent.
