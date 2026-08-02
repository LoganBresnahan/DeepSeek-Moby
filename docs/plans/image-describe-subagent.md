# `image-describe` subagent — vision via digest routing

**Status:** Phases 0, 1, 1b, 2, 3 shipped 2026-08-02. Remaining: 4 (archive thumbnail + lazy blob fetch), 5 (transcript render), 6 (backlog discharge).
**Date:** 2026-07-04 · **Revised:** 2026-08-02 (decisions 4–6: thumbnail sizing, blob storage, attachment replay — adds Phase 0; then §8 drag-and-drop — adds Phase 1b)
**Parent:** [subagents.md § Phase 2](subagents.md) — this doc is the concrete, decision-locked implementation plan for that phase. Where the two disagree, this doc wins (it reflects verified code state + explicit product decisions made 2026-07-04).

## TL;DR

DeepSeek's first-party API is text-only (verified 2026-07 — see [memory / research]; the website's image upload is app-side OCR, not an API capability). We close the vision gap the same way we closed verbose-tool-output: **route the image through a subagent, inject a text digest into the main model's context.** The main DeepSeek model never receives image bytes, so it never 400s on an `image_url` block, and its system prompt / tool list are untouched (pure tool-routing pattern).

The headline: **most of the machinery already exists.** The transport is already multimodal, the role slot is already reserved, and the generic router already does role→model resolution, isolated per-model clients, capability gating, and swallow-all-errors fallback. This is closer to *wiring pre-built parts* than building from scratch.

## Decisions locked (2026-07-04)

1. **Trigger: auto-digest on attach.** When the user attaches an image, route it to the vision subagent immediately and inject the digest into that user turn — mirroring web-search's proactive `searchForMessage()` path. *Not* a `describe_image` tool: with `web_search` the model generates the query argument, but with an attached image the **user** supplies the binary, so there's nothing natural for the model to put in a tool call. (A model-initiated `read_file`-on-an-image-in-the-repo path is a sensible fast-follow — deferred, see [Deferred](#deferred--follow-ups).)
2. **Backend: agnostic, no bundled default.** We ship the plumbing with **no** built-in vision model. The user configures any OpenAI-compatible vision model via `moby.customModels` (endpoint + key) and points `moby.subagents.image-describe` at it. Docs carry a worked example (SiliconFlow `deepseek-ai/deepseek-vl2` — the one OpenAI-compatible DeepSeek-branded VLM), but nothing is hardcoded. Consequence: the custom-model config path must be made first-class (schema + capability filter), see [§4](#4-config-surface).
3. **Persistence: downscaled thumbnail + digest.** Under ADR 0003 the events table is the sole source of truth, so the `UserMessageEvent` attachment persists a downscaled thumbnail **plus** the text digest. Full-res bytes are **not** persisted (avoids MB-scale DB/hydration bloat). On reload you see a preview + the digest the model saw. *Sizing and storage medium revised 2026-08-02 — see decisions 4–6.*

## Decisions locked (2026-08-02)

Three revisions from a pre-build design review. The first two supersede parts of decision 3; the third is a **correctness prerequisite** that turned out to be a live bug affecting text attachments today, independent of images.

4. **Archive thumbnail: 512px longest edge, aspect preserved, WebP.** Not 256px, and not square. Two independent arguments land on the same number:
   - *Human legibility.* 256px is a postage stamp on a HiDPI display — too small to recognize a screenshot by, and screenshots are the dominant case. Square-cropping a 16:9 screenshot destroys the thing you stored it for.
   - *Re-describability.* Most VLM encoders downsample to 336–448px tiles, so for photos, diagrams, and UI layout a 512px archive copy is near-lossless *from a model's point of view*. If a vision-capable main model lands later, or the vision backend is swapped and digests want regenerating, the archive is usable input — without ever having kept the original. **Honest limit:** for text-dense screenshots (the OCR-ish case), re-digesting from 512px is lossy versus the ~1024px copy the sub saw at attach time — the attach-time digest is the primary record; archive re-digest is best-effort.

   WebP q0.8 at 512px is ~25–40KB. Chromium canvas in the webview always supports it. The ~1024px copy sent to the sub stays ephemeral.

5. **Blobs live in the DB, in their own content-addressed table — not inline in `events.data`.**

   *Why in the DB at all, rather than sidecar files + a path reference:* forking is zero-copy — [event_sessions](../../src/events/migrations.ts) links one event row to N sessions — so a filesystem reference makes deletion a refcounting problem whose failure mode is silent (broken thumbnails in old transcripts, discovered months later). Sidecar files would also drop out of SQLCipher's encryption envelope: a user pastes a screenshot of a credentials page and it lands plaintext on disk, a real regression against the DB's threat model.

   *Why not inline base64 in `events.data`:* the cost is not disk, it's **hydration**. `loadHistory` eagerly loads and `JSON.parse`s every event, then `postMessage`s the lot across the webview boundary; [VirtualListActor](../../media/actors/virtual-list/VirtualListActor.ts) recycles turns, so most of that payload is never drawn. Twenty images is ~1MB of base64 structure-cloned on every session load, restore, and fork, to render maybe three thumbnails.

   So: `events.data` carries only `{blobId, mime, w, h, bytes}`; the render path fetches a blob when a turn actually becomes visible. That request/response shape is a slice of the parked Phase 3b lazy-load ([ADR 0003 follow-ups](../../CLAUDE.md)) — built early rather than invented twice. Content-addressing (`blobId = sha256(bytes)`) dedupes a re-attached image for free and makes fork trivially correct, since blobs are shared by hash rather than copied.

6. **Attachments must replay.** Persist attachments on the `user_message` event and re-materialize their context block on read, so a reloaded session rebuilds byte-identical model context. Applies to **text attachments and images alike** — see [§7](#7-attachment-replay-the-correctness-prerequisite). This is sequenced *first* (new [Phase 0](#build-plan-design-plan-workflow-2026-07-31)): it is independently valuable for text attachments, and it creates the seam images then plug into.

## What's already built (verified against source, 2026-07-04)

| Capability | Where | Status |
|---|---|---|
| Multimodal transport | `MessageContent = string \| Array<{type:'text'} \| {type:'image_url',image_url:{url}}>` — [deepseekClient.ts:10-16](../../src/deepseekClient.ts#L10); serialized verbatim into the request body | **Ready.** Nothing constructs image content today, but the wire needs no change. |
| Cross-provider endpoint | `apiEndpoint` is a required `ModelCapabilities` field ([registry.ts:57](../../src/models/registry.ts#L57)); `getHttpClient()` resolves the URL from it ([deepseekClient.ts:169](../../src/deepseekClient.ts#L169)); shipped custom-model examples point at Ollama/OpenAI/Groq/Moonshot ([package.json:77-170](../../package.json#L77)) | **Ready.** Supersedes the parent plan's "apiEndpoint plumbing prerequisite" — it's done. |
| Reserved role name | `'image-describe'` already in the `SubagentRoleName` union — [types.ts:15](../../src/subagents/types.ts#L15) | **Ready.** |
| Generic router | `SubagentRouter.route()` — role→model resolution, capability gate `caps.subagentRoles?.includes(role.name)`, lazy per-modelId isolated `DeepSeekClient`, forced `jsonMode`/`thinkingMode:'disabled'`, every failure path returns `{routed:false, reason}` — [router.ts:28-141](../../src/subagents/router.ts#L28) | **Reusable unchanged** except the content-shape hook below. |
| Capability axis | `subagentRoles?: string[]` on `ModelCapabilities` ([registry.ts:140](../../src/models/registry.ts#L140)); `validateCustomModelEntry` already accepts `subagentRoles` at runtime ([registry.ts:407](../../src/models/registry.ts#L407)) | Runtime ready; JSON schema gap (below). |
| Setting resolution | `moby.subagents.<role>` → model id or `"off"`; router bails `{routed:false,'off'}` when unset — [router.ts:145-151](../../src/subagents/router.ts#L145). `image-describe` already accepted via `additionalProperties` ([package.json:507](../../package.json#L507)). | Ready; explicit property is discoverability polish. |
| Key storage | Per-model key via `moby.customModels[].apiKey` inline ([package.json:272](../../package.json#L272)) or the `Moby: Set Custom Model API Key` secret path; `getApiKey()` precedence at [deepseekClient.ts:185](../../src/deepseekClient.ts#L185) | **Ready.** No new key storage. |
| Attachment model | `EventTypes.Attachment` already carries `type:'image'` — [EventTypes.ts:31-50](../../src/events/EventTypes.ts#L31) | **Ready** for persistence. |

## Corrections to subagents.md § Phase 2 (now stale)

- **`apiEndpoint` is done** — not a prerequisite. Cross-provider is reachable today.
- **Only the OpenAI `image_url` encoder is needed**, not the three-provider (Anthropic/OpenAI/Ollama) encoder matrix the parent plan describes. Custom models are `requestFormat:'openai'` only ([package.json:286-295](../../package.json#L286)), and the OpenAI-compatible shape is already the `MessageContent` type. No per-provider encoder module.
- **Default-model recommendation superseded.** Parent plan leaned toward auto-suggesting Claude Haiku on first attachment; decision #2 is backend-agnostic with no default and no auto-suggest.
- **The one real router edit** the parent plan didn't call out: `route()` hardcodes `content: userMessage` as a **string** ([router.ts:61](../../src/subagents/router.ts#L61)) and `buildUserMessage` returns `string` ([types.ts:59](../../src/subagents/types.ts#L59)). Images need the array form → add an optional `buildUserContent` hook (below).

## The flow (end to end)

```
composer: user attaches image
  │  InputAreaShadowActor.handleFileSelect — readAsDataURL (today: readAsText, text-only)
  │  Attachment { type:'image', mimeType, content: dataUrl }   ← client-side downscale + size cap
  ▼
postMessage 'sendMessage' envelope  (media/chat.ts)
  ▼
chatProvider  case 'sendMessage'  →  requestOrchestrator.handleMessage(..., attachments)
  │  setRecentUserPrompt(message)  (task context for the sub)
  ▼
attachment processing  (post-Phase 0: text blocks materialize from the persisted
  │                     event in getSessionMessagesCompat — the old live injection
  │                     at requestOrchestrator.ts:1050-1065 is deleted, see §7)
  │  image attachments → subagentRouter.route('image-describe', {dataUrl, name, mimeType, focus}, {recentUserPrompt})
  ▼
SubagentRouter.route  →  isolated DeepSeekClient(vision modelId)  →  OpenAI image_url part  →  digest JSON
  ▼
append to last user message (STRING):  "\n--- Image: <name> ---\n[Image processed by vision subagent: <model-id>]\n<digest>\n--- End Image ---\n"
  ▼
main DeepSeek model sees TEXT ONLY — image bytes never enter its message array
```

**Structural invariant (the safety property):** image `image_url` content is constructed *only* inside the role's `buildUserContent` and sent *only* to the isolated sub client. Everything appended to the main loop's messages is a plain string. Add an assertion that no main-loop message `content` is an array, so a future refactor can't regress into a main-model 400.

## Work — Phase 1 (smallest shippable slice)

Goal: file-dialog image attach → auto-digest → text injection into main context, end to end, backend-agnostic. Lowest blast radius; proves the whole mirrored pattern.

**(a) Router content-widening hook** — the one load-bearing subagent-layer change.
- Add optional `buildUserContent?(input: TIn): MessageContent` to `SubagentRole` ([types.ts:45-68](../../src/subagents/types.ts#L45)). Router uses it when present, else falls back to `role.buildUserMessage(input)` as today ([router.ts:55,61](../../src/subagents/router.ts#L55)). **Non-breaking** for the four text roles.
- Guard the trace `inputBytes: userMessage.length` fields ([router.ts:79,99,117,133](../../src/subagents/router.ts#L79)) — compute `inputBytes = typeof content === 'string' ? content.length : JSON.stringify(content).length`, else array content throws.

**(b) New role module** `src/subagents/roles/imageDescribe.ts` — clone the [webSearchDigest.ts](../../src/subagents/roles/webSearchDigest.ts) shape:
- `name: 'image-describe'`, `shouldRoute: () => true` (capability bridge, not a size threshold).
- `buildSystemPrompt(ctx)` — "describe this image for a text-only coding model," honor `recentUserPrompt` + optional `focus`.
- `buildUserContent(input)` → `[{type:'text', text: <focus/task>}, {type:'image_url', image_url:{url: input.dataUrl}}]`.
- `parse(json)` — hand-rolled validator (match the shipped convention, **not** zod), **lenient**: tolerate fenced/prefixed JSON (strip ```` ```json ```` fences, extract first `{…}`) in case the VL backend ignores `response_format`.
- `formatForMain(out)` — prefix `[Image processed by vision subagent: <model-id>]` so the main model treats the description as second-hand ([subagents.md:177](subagents.md), [subagents.md:499](subagents.md)).
- Output shape per parent plan: `{description, detectedKind, textContent?, uiElements?, notableColors?}`.

**(c) Webview image capture** — [InputAreaShadowActor.ts](../../media/actors/input-area/InputAreaShadowActor.ts):
- Add image MIME/exts to the `accept` list (~:99).
- Branch `handleFileSelect` (~:159-176): `reader.readAsDataURL(file)` for images, keep `readAsText` for text.
- **Client-side downscale** (canvas) producing **two** copies: ~1024px longest edge for the sub call (ephemeral) and the 512px WebP archive copy (decision 4, persisted). Aspect preserved on both — never square-crop. Hard byte cap with a user-facing reject message, applied *after* re-encode and *before* attach.
- Extend the webview `Attachment` interface (~:22) with `type:'file'|'image'` + `mimeType`; align to `EventTypes.Attachment` ([EventTypes.ts:31-37](../../src/events/EventTypes.ts#L31)).
- Live thumbnail chip in `renderAttachments` (~:347-367) from the data URL instead of the 📄 icon.
- Defer `paste`/`drop` handlers (none in `setupEventHandlers` today) — [Deferred](#deferred--follow-ups).

**(d) Thread `type`/`mimeType` across the boundary** (currently dropped — the param is `Array<{content,name,size}>`): `media/chat.ts` postMessage envelope, `chatProvider._pendingMessages` type + `case 'sendMessage'`, and `requestOrchestrator.handleMessage` signature ([:809](../../src/providers/requestOrchestrator.ts#L809)). Add `type?: 'file'|'image'; mimeType?: string`.

**(e) Orchestrator image-branch injection** at [requestOrchestrator.ts:1050-1065](../../src/providers/requestOrchestrator.ts#L1050):
- Split `attachments` into text vs image. Text keeps the `--- Attached Files ---` path.
- For each image, `await subagentRouter.route(imageRole, {dataUrl, name, mimeType}, {recentUserPrompt: message})`; append the digest block (§ flow) to the last user message string. Route multiple images with `Promise.all`.
- **Blocking by design** (runs before the turn). Emit an "Analyzing image…" status — mirror the `webSearching`/`webSearchComplete` postMessages ([chatProvider.ts:136-142](../../src/providers/chatProvider.ts#L136)).
- On `routed:false`, append an explicit placeholder — **never silently drop** ([subagents.md:179](subagents.md)): `[Image "<name>" could not be processed (<reason>). Configure a vision model via moby.subagents.image-describe.]`.

**(f) Persistence (data only)** — moved to Phase 4, and now rides the blob path Phase 0 builds: store the 512px WebP in `attachment_blobs`, reference it plus the digest from `UserMessageEvent.attachments` (`type:'image'` already modeled, [EventTypes.ts:31-50](../../src/events/EventTypes.ts#L31)). Live composer thumbnail covers the compose-time view. **Transcript render-on-reload** is Phase 5 (see [§6](#6-persistence-under-adr-0003)).

## 4. Config surface

Backend-agnostic ⇒ the custom-model path is first-class:

- **`moby.customModels` schema fix (required).** Add `subagentRoles` (array; enum of role names) and `acceptsImages` (boolean) to the items `properties` ([package.json:191-296](../../package.json#L191)); the block is `additionalProperties:false` ([:298](../../package.json#L298)) so without this a vision entry shows an editor squiggle even though the runtime validator already accepts `subagentRoles` ([registry.ts:407](../../src/models/registry.ts#L407)). Extend `validateCustomModelEntry` to also accept/validate `acceptsImages`.
- **`moby.subagents.image-describe` explicit property** ([package.json:500-506](../../package.json#L500)) — mirror `web-search-digest` for discoverability (works via `additionalProperties` today, but undiscoverable).
- **`acceptsImages` capability filter.** The settings-UI `image-describe` dropdown filters to models with `acceptsImages: true` ([subagents.md:198-200](subagents.md)). Routing works without it, but the filter prevents users pointing the role at a text-only model.
- **Docs example** (not a default): a `moby.customModels` entry `{id:"deepseek-vl2", apiEndpoint:"https://api.siliconflow.cn/v1", requestFormat:"openai", subagentRoles:["image-describe"], acceptsImages:true}` + `moby.subagents.image-describe:"deepseek-vl2"` + key via `Moby: Set Custom Model API Key`.

## 6. Persistence under ADR 0003

- **Store:** the 512px WebP archive thumbnail (decision 4, separate from the ~1024px sent to the sub) + the digest string, referenced from the user turn's `UserMessageEvent` attachment. No full-res bytes.
- **Medium:** a content-addressed `attachment_blobs` table (decision 5), *not* inline base64. Schema:

  ```sql
  CREATE TABLE IF NOT EXISTS attachment_blobs (
    id         TEXT PRIMARY KEY,   -- sha256(bytes), content-addressed
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,      -- native BLOB, not base64 (+33% avoided)
    width      INTEGER,            -- images only
    height     INTEGER,
    byte_size  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Mirrors event_sessions: makes GC a query rather than a JSON scan.
  CREATE TABLE IF NOT EXISTS event_blobs (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    blob_id  TEXT NOT NULL REFERENCES attachment_blobs(id),
    UNIQUE(event_id, blob_id)
  );
  ```

  **GC** stays application-level like ADR 0003's orphan cleanup: `event_blobs` cascade-deletes with its event, so after `deleteSession()` prunes orphan events, `DELETE FROM attachment_blobs WHERE id NOT IN (SELECT blob_id FROM event_blobs)` reclaims. Base64 exists only at the webview boundary (data URL for `<img>`), never at rest.

- **This is the schema's first real migration.** [migrations.ts](../../src/events/migrations.ts) is `LATEST_VERSION = 1` and its header states "fresh start: no migration history, no version-gated upgrades." Adding these tables makes it version 2 and establishes the versioned-upgrade path the file currently disclaims. Additive-only (two new tables, no column changes to `events`), so downgrade is lossy-but-safe.
- **Warrants an ADR.** Decisions 4–6 change the persistence contract ADR 0003 established (events table sole source of truth → events + referenced blobs) and introduce schema versioning. That is ADR-shaped per [CLAUDE.md](../../CLAUDE.md) conventions — see the `adr-attachment-persistence` slice in Phase 0.
- **Render caveat:** user attachments today are folded into message *text* (`--- Attached Files ---`), so there's no existing transcript chip for them, and the assistant-`drawing` `renderSegment` case is a **no-op** ([VirtualMessageGatewayActor.ts:395-397](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L395)) — drawings restore via a separate path. Rendering a persisted image thumbnail in a restored user turn therefore needs a real render path: model a thumbnail segment on `createDrawingSegment` ([MessageTurnActor.ts:2095-2131](../../media/actors/turn/MessageTurnActor.ts#L2095)) and actually **implement** the projector/render case (fixing the no-op) so it round-trips. Scope: this is the largest single sub-task; land persisted data in Phase 4, render-on-reload in Phase 5.

## 7. Attachment replay (the correctness prerequisite)

**Attachments do not survive a reload today — at all, for any type.** Found 2026-08-02 while reasoning about what a snapshotted conversation replays into a text-only main model. Three facts, verified against source:

- [requestOrchestrator.ts:855](../../src/providers/requestOrchestrator.ts#L855) calls `recordUserMessage(sessionId, message)` — it never passes `attachments`, though [the parameter has existed all along](../../src/events/ConversationManager.ts#L466).
- The `--- Attached Files ---` block is built at [requestOrchestrator.ts:1051](../../src/providers/requestOrchestrator.ts#L1051) and appended to `historyMessages`, the **ephemeral per-request array**. It is never persisted.
- Consequently [ConversationManager.ts:805](../../src/events/ConversationManager.ts#L805) — which already maps `attachments` → `files` for UI restore — has been reading `undefined` since it was written. The restore path was designed for this data and starved of it.

For text attachments this is survivable-but-wrong: the file is still on disk, so a model can re-read it, but the reloaded conversation silently differs from the one that happened. **For an image digest it is fatal.** The image is gone (no full-res kept), the digest is the only record, and it would vanish from the model's view of history on reload — leaving a user turn referring to "this mockup" with nothing attached. Shipping images onto this foundation would bake an ADR 0003 hydration-invariant violation of exactly the kind Phase 5 is flagged for: passes live testing, breaks only on reload.

**The fix — one formatter, ONE call site** *(revised same day: the first draft said "two callers" — live path + replay path — which double-injects: `recordUserMessage` at [:855](../../src/providers/requestOrchestrator.ts#L855) runs* before *the compat read at [:1034](../../src/providers/requestOrchestrator.ts#L1034), so once compat materializes blocks, the current turn's message already carries its block when the live path at [:1051](../../src/providers/requestOrchestrator.ts#L1051) would append it again)*:

- Extract the block builder as a pure `formatAttachmentsForContext(attachments, attachedAt): string` and call it from exactly one place: [`getSessionMessagesCompat`](../../src/events/ConversationManager.ts#L705). **Delete the live injection at [:1051](../../src/providers/requestOrchestrator.ts#L1051).** With one builder reading only persisted data, live and replayed context are byte-identical *by construction* — and the model can never see attachment content that differs from what the DB holds (which is what makes the size cap in the next slice safe: cap before persist, and the capped form is automatically what gets injected).
- Pass `attachments` through at [:855](../../src/providers/requestOrchestrator.ts#L855). No signature change needed — the parameter already exists. Take the block's timestamp stamp from the persisted event's `timestamp`, never `Date.now()` at format time.
- **The compat seam is safe for this** because it has exactly one consumer ([requestOrchestrator.ts:1035](../../src/providers/requestOrchestrator.ts#L1035), the API context builder), so appending there can never leak a file dump into the transcript. The UI reads `getSessionRichHistory` instead, which gets attachment *names* — and starts working the moment attachments persist.
- `UserMessageEvent.content` keeps the **raw user text**. Do not persist the composed string: it would dump attachment bodies into the user's chat bubble.
- **Image-digest ordering (decide at the Phase 4 boundary).** The digest is computed *after* the user message is recorded (routing runs at the old :1051 point), and `EventStore` is append-only by convention — so "persist the digest on the attachment" cannot happen at record time. Either **(i)** move `recordUserMessage` below digest routing so the event is written complete — single path, simplest, at the cost of a few-second crash window during routing in which the typed message is lost (retypeable; acceptable); or **(ii)** keep record-first as the crash anchor and append a digest row keyed to the event, mirroring the two-row `in_progress`→final `assistant_message` convention for late-arriving data. Leaning (i); whichever is chosen, compat materializes *digest-if-present, explicit placeholder if routing failed* — never the image bytes, never silence.

**Consequences worth stating:**

- **Replay is as-of-attach-time, deliberately.** A replayed text attachment shows the file as it was when attached, not as it is now. That is correct for conversation fidelity — the exchange happened against that content — but it can mislead a model into acting on stale content. Stamp the block with the attach timestamp so the model can tell: `--- Attached Files (as attached <ISO date>) ---`.
- **Text attachments need a persisted-size cap too.** A 200KB source file attached is 200KB in the blob table. Cap it, truncate with an explicit marker, and route text bodies through the same `attachment_blobs` path as images — uniform storage, uniform GC, and `events.data` stays small for both.
- **Fork inherits this for free.** `skipRecord` on the fork path means the user message row is already in the store, so its attachments come along via `event_sessions` with no extra work.

## 8. Drag-and-drop attach

**Added 2026-08-02 at user request.** Phase 1 shipped file-dialog capture only. Drag-and-drop is the input surface people actually reach for with a screenshot, and it serves **text attachments equally** — so like Phase 0, it is independent of the vision pipeline and can land before, after, or without it.

Reference implementation: `DropZone.tsx` in the Carton-Fit codebase (`/home/oof/Carton-Fit/src/renderer/src/components/DropZone.tsx`) — a React dropzone with `onDragOver`/`onDragLeave`/`onDrop`, an extension allow-list, a `dragging` class for the affordance, and a hidden file input behind a click. The shape is right; three things differ for Moby and are where the actual work is.

### The three deltas from the Carton-Fit pattern

**a. Two drop sources, not one.** Carton-Fit is an Electron app where every drop is an OS file drop. A VS Code webview receives two distinct kinds:

| Source | What `dataTransfer` carries | Can the webview read the bytes? |
|---|---|---|
| OS file manager / desktop | `dataTransfer.files` — real `File` objects | **Yes** — same path `handleFileSelect` already uses |
| VS Code Explorer, editor tab | `text/uri-list` (no `File` objects) | **No** — the webview has no filesystem access |

The second case needs an extension round-trip: webview posts the URI, the extension reads the file, hands content back. A partial seam exists — `getFileContent` → `fileContent` ([chatProvider.ts:835](../../src/providers/chatProvider.ts#L835), [:162](../../src/providers/chatProvider.ts#L162)) — but it returns **text**, so an image dropped from the Explorer needs either a bytes/base64 variant or extension-side encoding. Any new message type must be registered with the [protocol drift detector](../../tests/integration/protocol-drift.test.ts) rather than landing as an orphan.

**b. Shadow DOM + webview default behavior.** The input area is a `ShadowActor`, so listeners bind inside the shadow root, not on `document` — and `dragenter`/`dragleave` fire on every child crossing, so the highlight needs a depth counter rather than a boolean, or it flickers as the pointer moves between chips and the textarea. Separately, an **unhandled** drop anywhere in the webview makes the frame navigate to the dropped file, blanking the chat. So the guard and the target are two different things: a document-level `dragover`/`drop` `preventDefault` guard covers the whole panel and *swallows* drops outside the target, while the input box is the only place a drop actually attaches.

**c. Reuse or the image path silently regresses.** `handleFileSelect` now branches: images go through `isImage` → downscale → WebP, text through `FileReader.readAsText`. A drop handler that calls `readAsText` itself would store a PNG as mojibake in a code fence — exactly the failure the accept-list is designed to prevent. Extract the shared ingest (`ingestFiles(files: File[])`) **first**, and have both entry points call it.

### Drop target and modifier keys

**The input box is the drop target** (decided 2026-08-02) — not the transcript, not the whole panel. It is where attachments already live, it puts the drop next to the chips that result from it, and it keeps the transcript inert so a mis-aimed drop cannot land content mid-conversation. The rest of the panel still needs the navigation guard above; it just swallows the drop rather than acting on it. Highlight the input box on drag-enter (border + subtle background shift, mirroring how `.dropzone.dragging` reads in Carton-Fit) so the target is discoverable without a permanent "drag files here" affordance eating vertical space.

**No modifier keys (scoped out 2026-08-02).** Plain drop attaches; that is the whole interaction. A Shift+drop variant that inserts the file path as text was considered and dropped — it depends on whether VS Code passes the modifier through to the webview at all, which we would have to observe in a dev host before we could even commit to building it, and it buys a convenience nobody asked for. Revisit only if the path-insert case comes up in real use.

### Decided: every drop becomes an attachment

**One rule — anything dropped on the input box becomes an attachment**, regardless of where it was dragged from or what type it is. Decided 2026-08-02.

The alternative considered and rejected was routing by drag origin: an OS drop becomes an attachment (there is no path to re-read, so a snapshot is the only option) while a VS Code Explorer drop of a workspace text file becomes a **selected context file** — path-based, re-read fresh each turn, via the machinery `FilesShadowActor` / `fileContextManager` already has. That is genuinely fresher for repo files and cheaper to build.

It loses on **an invisible mode**. The same `src/foo.ts` would behave one way dragged from the Explorer and another way dragged from a file manager, with nothing in the resulting chip to say which happened. A user cannot reliably tell which drag they performed, so they cannot predict whether the model is reading live content or a frozen copy. Note the asymmetry that made this confusing to reason about in the first place: **images were never subject to the rule** — `getSelectedFilesContext` builds a text block from a `Map<path, string>` ([fileContextManager.ts:211](../../src/providers/fileContextManager.ts#L211)), so an image physically cannot ride the context-file path and always attaches. A rule that applies to one file type and not another, keyed on something the user can't see, is the kind of thing that reads as a bug.

**Consequences accepted:**

- A dropped workspace text file is snapshotted as-of-drop-time rather than re-read each turn. This is not a new behavior — it is exactly what [§7](#7-attachment-replay-the-correctness-prerequisite) already signposts with the attach timestamp, and it applies to picker-attached files today.
- Bytes are duplicated for a file already on disk, bounded by the 256KB persist cap and deduped by content hash if the same file is dropped twice.
- Users who want live-tracked repo files keep using the existing "add file to context" surface, which is unchanged. Drop is for *"here, look at this"*; file-context is for *"follow this file"*.
- `drag-drop-editor-uris` keeps its round-trip: a `text/uri-list` drop must be read by the extension and returned as content, for text and images alike. Slightly more work than the origin-routing shortcut, in exchange for one rule.

### What is and is not testable

Carton-Fit's [ADR 0005](/home/oof/Carton-Fit/doc/adr/0005-testing-and-deploy.md) records the constraint plainly: *"OS-level drag-drop cannot be simulated, so the DropZone must always keep a file-picker fallback (also an accessibility win)."* The same holds here, with one refinement — Playwright **can** synthesize an HTML5 `DataTransfer` and dispatch `drop` in-page, which exercises our handler, the ingest branch, and the overlay. What it cannot cross is the **OS → webview** boundary, and for the VS Code-internal case it cannot reproduce what the Explorer actually puts on the drag payload. So:

- Unit / harness e2e: the handler, the branch, the overlay counter, and the guard.
- Dev-host only: that a real OS drag and a real Explorer drag deliver what we assume.
- **The file picker never goes away.** It is the automation seam and the keyboard-accessible path.

## Deferred / follow-ups

- **Paste** image capture (`paste` event → clipboard `File`) — a natural sibling of drag-drop that reuses the same `ingestFiles` seam once it exists.
- **Model-initiated hybrid (parent plan path 2):** `read_file` on an image-extension path ([workspaceTools.ts:407](../../src/tools/workspaceTools.ts#L407)) routes through the same role and returns the digest as the tool-role result — mirror the `web_search` branch in `dispatchToolCall` ([requestOrchestrator.ts:2934-2946](../../src/providers/requestOrchestrator.ts#L2934)), gated by a `isImageDescribeConfigured()` conditional spread like `includeWebSearch` ([:3845](../../src/providers/requestOrchestrator.ts#L3845)). Genuinely different surface (model wants to look at a mockup PNG it found).
- **Result caching** keyed on `hash(dataUrl)+focus` with a TTL — mirror the web-search cache ([webSearchManager.ts:93](../../src/providers/webSearchManager.ts#L93)) — skip re-describing a re-attached image.
- **`ImageDescribeManager` extraction** — keep injection inline (like today's attachment handling); refactor only if a second image surface lands.

## Risks & edge cases

- **Main model 400s on image blocks (known).** Mitigated structurally — only string digests reach the main loop; add the no-array-content assertion (§ flow).
- **History poisoning / trust.** Digest is model-authored; the `[Image processed by vision subagent: <model-id>]` prefix marks it second-hand.
- **Cost / latency.** Auto-digest blocks the turn — show the "Analyzing image…" indicator; parallelize multiple images; caching (deferred) removes duplicate re-describes.
- **Large images / base64 bloat.** Downscale + hard cap client-side before the postMessage; at rest, bytes live as a native BLOB in `attachment_blobs`, never base64 in `events.data` (decision 5).
- **Replay drift (the silent one).** Live-built and reload-built context diverging is invisible in a dev-host session and corrupts every subsequent turn. Mitigated by construction — one shared `formatAttachmentsForContext` — and pinned by `replay-equivalence-tests`. Treat any future attachment surface that formats its own block as a regression.
- **Stale replayed file content.** A replayed text attachment is as-of-attach-time, so a model may act on content that has since changed. Deliberate (conversation fidelity) but signposted with the attach timestamp — see [§7](#7-attachment-replay-the-correctness-prerequisite).
- **Blob GC correctness.** Zero-copy fork means a blob can be reachable from several sessions. GC must run off `event_blobs` after orphan-event cleanup, never off "was this session deleted" — the wrong order silently blanks thumbnails in a *surviving* forked session.
- **Unhandled drop navigates the webview away (drag-drop).** The default action for a file dropped on a frame is to open it, which blanks the chat and loses the in-progress turn. The document-level guard is not optional polish — it is the thing standing between a mis-aimed drop and a destroyed session. Pin it with a test that drops outside the input box.
- **Drag-drop assumptions we cannot test (drag-drop).** Playwright can synthesize a `DataTransfer`, so our handler is testable; what the OS and the VS Code Explorer actually put on a real drag is not. Anything asserted about `text/uri-list` contents or modifier keys is provisional until observed in a dev host — see [§8](#what-is-and-is-not-testable).
- **No vision backend configured.** `moby.subagents.image-describe` unset → `{routed:false,'off'}` → explicit placeholder naming the setting; attach still allowed, nothing crashes.
- **jsonMode on the VL backend.** Router forces `jsonMode:true` ([router.ts:67](../../src/subagents/router.ts#L67)); a VL model may ignore `response_format` → `parse` fails → placeholder. Mitigate with the lenient parse (§b) + a strict JSON instruction in the system prompt. **Verify empirically at build time** against the chosen VL backend; if unreliable, add a per-role `readonly jsonMode?: boolean` opt-out the router honors + a plain-text `formatForMain` fallback.
- **Token accounting for the sub call.** `contextBuilder.extractText` counts an image part as literal `'[image]'` (~1 token, [contextBuilder.ts:43](../../src/context/contextBuilder.ts#L43)); confirm the sub client's budget guard isn't tripped by underestimating. Low risk — only the sub call carries the image.

## Testing

- Unit: `tests/unit/subagents/roles/imageDescribe.test.ts` — `shouldRoute` always true, `buildUserContent` emits the `image_url` part, lenient `parse` (clean JSON, fenced JSON, garbage → null), `formatForMain` prefix.
- Unit: extend `tests/unit/subagents/router.test.ts` — `buildUserContent` hook used when present; string fallback unchanged for text roles; `inputBytes` trace guard on array content.
- Unit: orchestrator image-branch — routed → digest appended as string; `routed:false` → placeholder appended (not dropped); text attachments unaffected.
- Unit: **replay equivalence** (`replay-equivalence-tests`, Phase 0) — for a turn with text attachments, context built live and context built after a reload are byte-identical; the block survives a fork; `UserMessageEvent.content` holds raw user text only (no attachment bodies leaking to the transcript). Extended to digests + `routed:false` placeholders in Phase 4.
- Unit: **blob store** — content-addressing dedupes identical bytes; GC reclaims only blobs unreferenced by any surviving event; a blob shared by a forked session survives deletion of its origin session.
- Unit (`tests/actors/input-area/`): drag-drop over the input box — synthesized `DataTransfer` with an image file takes the downscale branch, with a text file takes the text branch, a mixed batch splits correctly; the highlight counter survives `dragleave` from child elements; an off-target drop is swallowed by the guard and attaches nothing.
- Manual-test backlog (add entries): attach image with a vision model configured → digest reaches main model; no backend configured → clear placeholder; oversized image → reject message; multiple images in one turn; reload session → thumbnail + digest restore; **attach a text file → reload → the file's content is still in the model's context**.

## Build plan (design-plan workflow, 2026-07-31)

13 slices in the original decomposition, all assessed `todo` against source. Dominant model: opus (12 slices); one fable slice. Critical path: `router-build-user-content-hook` → `image-describe-role-module` → `orchestrator-image-injection` → `thumbnail-digest-persistence` → `transcript-thumbnail-render` → `manual-test-backlog-entries`.

**Revised 2026-08-02:** +1 phase, +5 slices (18 total), then **+1 phase, +4 slices for drag-and-drop (22 total)** — see [§8](#8-drag-and-drop-attach). Phase 0 is new and now heads the critical path — `attachment-blob-store` → `attachment-replay` → (existing chain) → `thumbnail-digest-persistence`. Phase 0 ships standalone value (text attachments become replayable) and can land before any image work starts.

### Phases

- [x] **0. Attachment persistence + replay** *(opus)* — **SHIPPED 2026-08-02** ([ADR 0014](../architecture/decisions/0014-attachment-persistence-and-replay.md)); dev-host `/verify` (reload + fork) still outstanding. Fixes a live bug for text attachments ([§7](#7-attachment-replay-the-correctness-prerequisite)) and builds the storage + replay seam images plug into. Independently shippable: nothing here mentions images. `/shipshape` at boundary; `/verify` must exercise **reload and fork** — the whole point is a path that only breaks on restore.
  - [x] `attachment-blob-store` (medium/moderate) — `attachment_blobs` + `event_blobs` tables, `LATEST_VERSION` 1 → 2 (the schema's first versioned upgrade), content-addressed put/get by sha256, GC folded into `deleteSession()`'s existing orphan-cleanup transaction. **Build-time check:** [`StatementWrapper`](../../src/events/SqlJsWrapper.ts) has only ever carried strings/numbers — verify `Buffer`/`Uint8Array` BLOB params pass through `@signalapp/sqlcipher` intact (round-trip a blob in the first unit test).
  - [x] `attachment-replay` (medium/moderate, risk: **high** — silent failure mode) — extract `formatAttachmentsForContext`, called **only** from `getSessionMessagesCompat`; **delete** the live injection at [:1051](../../src/providers/requestOrchestrator.ts#L1051) (two callers double-inject the current turn — see [§7](#7-attachment-replay-the-correctness-prerequisite)); pass `attachments` at [:855](../../src/providers/requestOrchestrator.ts#L855). Timestamp stamp from the event's `timestamp`. `UserMessageEvent.content` stays raw user text.
  - [x] `text-attachment-size-cap` (low/mechanical) — cap persisted text bodies, truncate with an explicit marker, route through the blob store.
  - [x] `adr-attachment-persistence` (low/mechanical) — ADR 0014: blobs-beside-events amends ADR 0003's sole-source-of-truth contract; records the sidecar-files and inline-base64 alternatives and why both lose.
  - [x] `replay-equivalence-tests` (medium/moderate) — the gate for this phase: assert live-built context and reload-built context are **byte-identical** for a turn with text attachments, that the block appears **exactly once** (pins the deleted live injection — the double-injection regression is the likeliest future re-break), and that the block survives a fork. Deliberately written before images exist so it keeps holding once they do.
- [x] **1. Foundations** *(opus)* — **SHIPPED 2026-08-02.** All zero-dependency; landed as one batch. `/verify` eyeball of the image chip still owed.
  - [x] `router-build-user-content-hook` (low/mechanical) — optional `buildUserContent?` on `SubagentRole`, nullish-coalescing dispatch in `route()`, string-vs-array guard at the four `inputBytes` trace sites. Transport already typed `MessageContent` — no widening needed.
  - [x] `attachment-type-threading` (low/mechanical) — optional `type`/`mimeType` on the attachment shape at [chatProvider.ts:44](../../src/providers/chatProvider.ts#L44), [requestOrchestrator.ts:809](../../src/providers/requestOrchestrator.ts#L809), [media/chat.ts:340](../../media/chat.ts#L340).
  - [x] `webview-image-capture` (medium/moderate) — accept-list + FileReader branch + img-chip in `InputAreaShadowActor`; async canvas downscale with hard byte cap (cap after re-encode, reject before attach).
  - [x] `custom-models-schema-fix` (low/mechanical) — `subagentRoles` + `acceptsImages` in the package.json customModels schema; mirror the existing one-line optional-axis checks in `validateCustomModelEntry`; explicit `moby.subagents.image-describe` property.
- [x] **1b. Drag-and-drop attach** *(opus)* — **SHIPPED 2026-08-02** (shift-drop variant scoped out); dev-host `/verify` still owed. Added at user request ([§8](#8-drag-and-drop-attach)). Independent of the vision pipeline: it serves text attachments too, so it can land before or after phases 2–5, and slips without blocking them. Drop semantics are settled ([§8](#decided-every-drop-becomes-an-attachment)): every drop attaches. `/shipshape` at boundary, then `/verify` — this phase is unusually dev-host-dependent (see below).
  - [x] `ingest-files-extraction` (low/mechanical) — pull the image-vs-text branch out of `handleFileSelect` into `ingestFiles(files: File[])`; picker calls it. **Must land first** — a drop handler written against the old shape would re-implement the text path and store images as mojibake.
  - [x] `drag-drop-os-files` (medium/moderate) — shadow-root `dragenter`/`dragover`/`dragleave`/`drop` on the input box with a **depth counter** for the highlight; document-level `preventDefault` guard so a drop anywhere else in the panel cannot navigate the frame away; drop → `ingestFiles`. Keep the picker (automation seam + keyboard access).
  - [x] `drag-drop-editor-uris` (medium/moderate, risk: **medium** — behavior we cannot fully observe from a test) — `text/uri-list` branch for VS Code-internal drags. Per the §8 decision every drop attaches, so this reads the file extension-side and returns content for text and images alike — no origin branching. Any new postMessage type gets registered with the protocol drift detector in the same commit.
  - [x] `drag-drop-tests` (medium/moderate) — synthesized `DataTransfer` drop tests over the handler: image file → downscale branch, text file → text branch, mixed batch, highlight counter survives child crossings, guard swallows an off-target drop. Pins everything except the OS boundary.
- [x] **2. Role module + settings filter** *(opus)* — **SHIPPED 2026-08-02.** The `acceptsImages` gate landed in **two** places: enforcement in the router (a role declares `requiresImageSupport`; `route()` refuses a model without `acceptsImages`) *and* the settings-popup picker, which lists only vision-capable models. Enforcement was built first on the mistaken assumption that no picker was planned; the picker followed. Both are worth having — the picker stops a bad choice being made, enforcement catches a hand-edited `settings.json`.
  - [x] `image-describe-role-module` (medium/moderate) — clone `webSearchDigest.ts` shape; VL prompt contract + lenient parse (fence-strip, first-`{…}`, garbage → null).
  - [x] `accepts-images-capability-filter` (low/mechanical) — router enforcement (`requiresImageSupport` on the role + `acceptsImages` check in `route()`) **plus** the settings-popup picker: `acceptsImages` rides the existing `model.list` channel, the popup filters on it, and `setSubagentModel` writes the `moby.subagents.<role>` key (a nested object, so it cannot use the flat-setting path).
  - [x] `tolerant-json-parse` (low/mechanical) — **added during build.** The plan assigned lenient parsing (fence-strip, first-`{…}`) to the role's `parse`, but the router owns `JSON.parse`, so a fenced response fails there and never reaches the role. Implemented in the router instead; every role benefits.
- [x] **3. Orchestrator branch + guard rails + tests** *(opus)* — **SHIPPED 2026-08-02.** Resolved the §7 digest-ordering question in favour of **option (i)**: digests are routed *before* `recordUserMessage`, so they persist on the attachment and replay by construction. Injecting live would have reintroduced exactly the reload-drift ADR 0014 fixed. Dev-host `/verify` still owed.
  - [x] `orchestrator-image-injection` (medium/moderate, risk: medium) — route image attachments in the orchestrator (text attachments no longer have a live path after Phase 0 — they materialize from the persisted event): `Promise.all` the `route()` calls, digest or named placeholder; never let an image ride the text `--- Attached Files ---` formatter, never silently drop on `routed:false`.
  - [x] `no-array-content-assertion` (low/mechanical) — **same commit** as the injection slice; assert main-model message content is never an array at the finalization choke point(s) covering both loops.
  - [x] `analyzing-image-status-indicator` (low/mechanical) — mirror webSearching/webSearchComplete postMessages; emit complete in a `finally`.
  - [x] `unit-tests` (medium/moderate) — role tests, router-hook tests, orchestrator branch (digest-append / placeholder / trace-guard contracts).
- [ ] **4. Thumbnail + digest persistence** *(opus)* — own phase because its failure mode (full-res bytes reaching the table) is **silent**. Much thinner now that Phase 0 owns storage and replay. Gate: persisted-attachment-size unit test + `Moby: Export Turn as JSON` during `/verify`.
  - [ ] `thumbnail-digest-persistence` (low/mechanical after Phase 0, risk: medium) — put the webview-made 512px WebP into `attachment_blobs`, reference it + the digest from `UserMessageEvent.attachments` (shape already exists in [EventTypes.ts:31](../../src/events/EventTypes.ts#L31)); full-res bytes never reach the table. **Entry gate: resolve the digest-ordering decision in [§7](#7-attachment-replay-the-correctness-prerequisite)** — record-after-routing vs appended digest row — before writing this slice.
  - [ ] `digest-replay-coverage` (low/mechanical) — extend `replay-equivalence-tests` to an image turn: the digest block must rebuild identically on reload, and a `routed:false` placeholder must replay as the placeholder rather than silently vanishing.
- [ ] **5. Transcript thumbnail render on reload** *(fable + adversarial verify — the only slice that warrants it)* — ADR 0003 hydration-invariant work: restore-path render must not double what the live path drew; a plausible-but-wrong version passes live testing and breaks only on reload/fork. `/verify` must exercise reload, session switch, and fork explicitly, then `/shipshape`.
  - [ ] `transcript-thumbnail-render` (high/hard-reasoning) — thumbnail segment type in the webview's local event model; project persisted attachment → renderable segment on hydration; live/restore consistency.
  - [ ] `lazy-blob-fetch` (medium/moderate) — the render half of decision 5: hydration ships `{blobId, w, h}` only, and the webview requests bytes when a turn becomes visible (`requestAttachmentBlob` → `attachmentBlob`, mirroring the parked Phase 3b shape). Reserve dimensions from the metadata so a late-arriving blob doesn't reflow the list. Register both message types with the [protocol drift detector](../../tests/integration/protocol-drift.test.ts) rather than letting them land as orphans.
- [ ] **6. Manual-test backlog + discharge** *(opus)* — also the trigger for the jsonMode-on-VL-backend empirical check. Final `/verify` session discharges the entries.
  - [ ] `manual-test-backlog-entries` (low/mechanical) — the five scenarios from [Testing](#testing), per the backlog template.

### Sequencing risks

1. **Phase 0 before Phase 4, non-negotiable.** Persisting an image digest onto the pre-fix foundation bakes in the reload-only failure of [§7](#7-attachment-replay-the-correctness-prerequisite): green live, silently wrong on restore, and hard to attribute once images are also in flight.
2. **Phase 1→3 window:** once the accept-list admits images, an image must never ride the text path — land phases 1–3 before any release/tag (or placeholder unknown-type attachments in the orchestrator from day one).
3. **Migration is one-way.** `LATEST_VERSION` 1 → 2 lands in Phase 0. Additive-only, but a DB touched by the new build then opened by an older one loses blob rows. Fine for a pre-release extension; worth a line in the release notes.
4. **jsonMode on VL backends** is only testable empirically in phase 6; if it fails, the per-role jsonMode opt-out contingency touches the phase-2 role module — keep it in mind when writing `imageDescribe.ts`.
5. **Phase 1b is orthogonal.** Drag-and-drop touches only the webview input surface and the ingest seam; it neither blocks nor is blocked by phases 2–5. Sequence it by appetite. The one ordering constraint is internal: `ingest-files-extraction` before any drop handler.
6. **Phase 5 may slip** — phases 0–4 + 6 (minus the reload-render scenario) are a shippable increment without it. Note this is now a *weaker* statement than before: Phase 0's replay guarantee ships regardless, so a slipped Phase 5 costs the thumbnail picture, not context fidelity.

### Verification roster

| Gate | When | What |
| --- | --- | --- |
| `/shipshape` | every phase boundary | compile + suites green twice + docs/conventions |
| `/verify` | after 0 | attach a text file → reload the session → the `--- Attached Files ---` block is still in rebuilt context, timestamp-stamped; fork carries it too |
| `/verify` | after 1b | drop on the input box from the OS file manager AND from the VS Code Explorer — both attach (image → thumbnail chip, text → 📄 chip); drop outside the input box does nothing and **never navigates the frame away**; picker still works |
| `/verify` | after 3 | attach → indicator → digest; no-backend placeholder |
| `/verify` | after 4 | Export Turn as JSON — blob *references* only, no full-res bytes, no inline base64 (the one silent risk outside phase 5) |
| `/verify` + adversarial verify | after 5 | reload, session switch, fork render — no double-draw; blobs fetched lazily, no reflow on late arrival |
| `/verify` | phase 6 | discharge the backlog entries (shipshape green does not) |

## Related

- [subagents.md](subagents.md) — parent design; router/role/capability conventions this follows.
- [ADR 0003](../architecture/decisions/0003-events-table-sole-source-of-truth.md) — persistence contract driving decisions 3–6.
- ADR 0014 *(to be written in Phase 0)* — blobs beside events; amends ADR 0003's sole-source-of-truth contract and introduces schema versioning.
- DeepSeek API vision research (2026-07-04): first-party API text-only; website upload is app-side OCR; DeepSeek VL/Janus are open-weight only; SiliconFlow `deepseek-ai/deepseek-vl2` is the OpenAI-compatible drop-in.
