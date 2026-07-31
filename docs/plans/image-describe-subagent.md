# `image-describe` subagent — vision via digest routing

**Status:** Not started — implementation plan (ready to build).
**Date:** 2026-07-04
**Parent:** [subagents.md § Phase 2](subagents.md) — this doc is the concrete, decision-locked implementation plan for that phase. Where the two disagree, this doc wins (it reflects verified code state + explicit product decisions made 2026-07-04).

## TL;DR

DeepSeek's first-party API is text-only (verified 2026-07 — see [memory / research]; the website's image upload is app-side OCR, not an API capability). We close the vision gap the same way we closed verbose-tool-output: **route the image through a subagent, inject a text digest into the main model's context.** The main DeepSeek model never receives image bytes, so it never 400s on an `image_url` block, and its system prompt / tool list are untouched (pure tool-routing pattern).

The headline: **most of the machinery already exists.** The transport is already multimodal, the role slot is already reserved, and the generic router already does role→model resolution, isolated per-model clients, capability gating, and swallow-all-errors fallback. This is closer to *wiring pre-built parts* than building from scratch.

## Decisions locked (2026-07-04)

1. **Trigger: auto-digest on attach.** When the user attaches an image, route it to the vision subagent immediately and inject the digest into that user turn — mirroring web-search's proactive `searchForMessage()` path. *Not* a `describe_image` tool: with `web_search` the model generates the query argument, but with an attached image the **user** supplies the binary, so there's nothing natural for the model to put in a tool call. (A model-initiated `read_file`-on-an-image-in-the-repo path is a sensible fast-follow — deferred, see [Deferred](#deferred--follow-ups).)
2. **Backend: agnostic, no bundled default.** We ship the plumbing with **no** built-in vision model. The user configures any OpenAI-compatible vision model via `moby.customModels` (endpoint + key) and points `moby.subagents.image-describe` at it. Docs carry a worked example (SiliconFlow `deepseek-ai/deepseek-vl2` — the one OpenAI-compatible DeepSeek-branded VLM), but nothing is hardcoded. Consequence: the custom-model config path must be made first-class (schema + capability filter), see [§4](#4-config-surface).
3. **Persistence: downscaled thumbnail + digest.** Under ADR 0003 the events table is the sole source of truth, so the `UserMessageEvent` attachment persists a ~256px downscaled thumbnail **plus** the text digest. Full-res bytes are **not** persisted (avoids MB-scale DB/hydration bloat). On reload you see a preview + the digest the model saw.

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
attachment-injection point  [requestOrchestrator.ts:1050-1065]   (where text files already fold in)
  │  split attachments: text files → existing "--- Attached Files ---" path
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
- **Client-side downscale** (canvas, cap longest edge ~1024px for the sub call) + hard byte cap with a user-facing reject message before encoding.
- Extend the webview `Attachment` interface (~:22) with `type:'file'|'image'` + `mimeType`; align to `EventTypes.Attachment` ([EventTypes.ts:31-37](../../src/events/EventTypes.ts#L31)).
- Live thumbnail chip in `renderAttachments` (~:347-367) from the data URL instead of the 📄 icon.
- Defer `paste`/`drop` handlers (none in `setupEventHandlers` today) — [Deferred](#deferred--follow-ups).

**(d) Thread `type`/`mimeType` across the boundary** (currently dropped — the param is `Array<{content,name,size}>`): `media/chat.ts` postMessage envelope, `chatProvider._pendingMessages` type + `case 'sendMessage'`, and `requestOrchestrator.handleMessage` signature ([:809](../../src/providers/requestOrchestrator.ts#L809)). Add `type?: 'file'|'image'; mimeType?: string`.

**(e) Orchestrator image-branch injection** at [requestOrchestrator.ts:1050-1065](../../src/providers/requestOrchestrator.ts#L1050):
- Split `attachments` into text vs image. Text keeps the `--- Attached Files ---` path.
- For each image, `await subagentRouter.route(imageRole, {dataUrl, name, mimeType}, {recentUserPrompt: message})`; append the digest block (§ flow) to the last user message string. Route multiple images with `Promise.all`.
- **Blocking by design** (runs before the turn). Emit an "Analyzing image…" status — mirror the `webSearching`/`webSearchComplete` postMessages ([chatProvider.ts:136-142](../../src/providers/chatProvider.ts#L136)).
- On `routed:false`, append an explicit placeholder — **never silently drop** ([subagents.md:179](subagents.md)): `[Image "<name>" could not be processed (<reason>). Configure a vision model via moby.subagents.image-describe.]`.

**(f) Persistence (data only for Phase 1)** — persist the ~256px thumbnail + digest on the `UserMessageEvent.attachment` (`type:'image'` already modeled, [EventTypes.ts:31-50](../../src/events/EventTypes.ts#L31)). Live composer thumbnail covers the compose-time view. **Transcript render-on-reload** of the thumbnail is the one piece needing a render path (see [§6](#6-persistence-under-adr-0003)); if it proves heavy it slips to the first follow-up while the persisted data lands now.

## 4. Config surface

Backend-agnostic ⇒ the custom-model path is first-class:

- **`moby.customModels` schema fix (required).** Add `subagentRoles` (array; enum of role names) and `acceptsImages` (boolean) to the items `properties` ([package.json:191-296](../../package.json#L191)); the block is `additionalProperties:false` ([:298](../../package.json#L298)) so without this a vision entry shows an editor squiggle even though the runtime validator already accepts `subagentRoles` ([registry.ts:407](../../src/models/registry.ts#L407)). Extend `validateCustomModelEntry` to also accept/validate `acceptsImages`.
- **`moby.subagents.image-describe` explicit property** ([package.json:500-506](../../package.json#L500)) — mirror `web-search-digest` for discoverability (works via `additionalProperties` today, but undiscoverable).
- **`acceptsImages` capability filter.** The settings-UI `image-describe` dropdown filters to models with `acceptsImages: true` ([subagents.md:198-200](subagents.md)). Routing works without it, but the filter prevents users pointing the role at a text-only model.
- **Docs example** (not a default): a `moby.customModels` entry `{id:"deepseek-vl2", apiEndpoint:"https://api.siliconflow.cn/v1", requestFormat:"openai", subagentRoles:["image-describe"], acceptsImages:true}` + `moby.subagents.image-describe:"deepseek-vl2"` + key via `Moby: Set Custom Model API Key`.

## 6. Persistence under ADR 0003

- **Store:** downscaled thumbnail (~256px, separate from the ~1024px sent to the sub) + the digest string, on the user turn's `UserMessageEvent` attachment. No full-res bytes.
- **Render caveat:** user attachments today are folded into message *text* (`--- Attached Files ---`), so there's no existing transcript chip for them, and the assistant-`drawing` `renderSegment` case is a **no-op** ([VirtualMessageGatewayActor.ts:395-397](../../media/actors/message-gateway/VirtualMessageGatewayActor.ts#L395)) — drawings restore via a separate path. Rendering a persisted image thumbnail in a restored user turn therefore needs a real render path: model a thumbnail segment on `createDrawingSegment` ([MessageTurnActor.ts:2095-2131](../../media/actors/turn/MessageTurnActor.ts#L2095)) and actually **implement** the projector/render case (fixing the no-op) so it round-trips. Scope: this is the largest single sub-task; land persisted data in Phase 1, render-on-reload here or as the immediate follow-up.

## Deferred / follow-ups

- **Paste / drag-drop** image capture (Phase 1 is file-dialog only).
- **Model-initiated hybrid (parent plan path 2):** `read_file` on an image-extension path ([workspaceTools.ts:407](../../src/tools/workspaceTools.ts#L407)) routes through the same role and returns the digest as the tool-role result — mirror the `web_search` branch in `dispatchToolCall` ([requestOrchestrator.ts:2934-2946](../../src/providers/requestOrchestrator.ts#L2934)), gated by a `isImageDescribeConfigured()` conditional spread like `includeWebSearch` ([:3845](../../src/providers/requestOrchestrator.ts#L3845)). Genuinely different surface (model wants to look at a mockup PNG it found).
- **Result caching** keyed on `hash(dataUrl)+focus` with a TTL — mirror the web-search cache ([webSearchManager.ts:93](../../src/providers/webSearchManager.ts#L93)) — skip re-describing a re-attached image.
- **`ImageDescribeManager` extraction** — keep injection inline (like today's attachment handling); refactor only if a second image surface lands.

## Risks & edge cases

- **Main model 400s on image blocks (known).** Mitigated structurally — only string digests reach the main loop; add the no-array-content assertion (§ flow).
- **History poisoning / trust.** Digest is model-authored; the `[Image processed by vision subagent: <model-id>]` prefix marks it second-hand.
- **Cost / latency.** Auto-digest blocks the turn — show the "Analyzing image…" indicator; parallelize multiple images; caching (deferred) removes duplicate re-describes.
- **Large images / base64 bloat.** Downscale + hard cap client-side before both the postMessage and (if persisted) the events table.
- **No vision backend configured.** `moby.subagents.image-describe` unset → `{routed:false,'off'}` → explicit placeholder naming the setting; attach still allowed, nothing crashes.
- **jsonMode on the VL backend.** Router forces `jsonMode:true` ([router.ts:67](../../src/subagents/router.ts#L67)); a VL model may ignore `response_format` → `parse` fails → placeholder. Mitigate with the lenient parse (§b) + a strict JSON instruction in the system prompt. **Verify empirically at build time** against the chosen VL backend; if unreliable, add a per-role `readonly jsonMode?: boolean` opt-out the router honors + a plain-text `formatForMain` fallback.
- **Token accounting for the sub call.** `contextBuilder.extractText` counts an image part as literal `'[image]'` (~1 token, [contextBuilder.ts:43](../../src/utils/contextBuilder.ts#L43)); confirm the sub client's budget guard isn't tripped by underestimating. Low risk — only the sub call carries the image.

## Testing

- Unit: `tests/unit/subagents/roles/imageDescribe.test.ts` — `shouldRoute` always true, `buildUserContent` emits the `image_url` part, lenient `parse` (clean JSON, fenced JSON, garbage → null), `formatForMain` prefix.
- Unit: extend `tests/unit/subagents/router.test.ts` — `buildUserContent` hook used when present; string fallback unchanged for text roles; `inputBytes` trace guard on array content.
- Unit: orchestrator image-branch — routed → digest appended as string; `routed:false` → placeholder appended (not dropped); text attachments unaffected.
- Manual-test backlog (add entries): attach image with a vision model configured → digest reaches main model; no backend configured → clear placeholder; oversized image → reject message; multiple images in one turn; reload session → thumbnail + digest restore.

## Build plan (design-plan workflow, 2026-07-31)

13 slices, all assessed `todo` against source. Dominant model: opus (12 slices); one fable slice. Critical path: `router-build-user-content-hook` → `image-describe-role-module` → `orchestrator-image-injection` → `thumbnail-digest-persistence` → `transcript-thumbnail-render` → `manual-test-backlog-entries`.

### Phases

- [ ] **1. Foundations** *(opus)* — all zero-dependency; land as one batch so everything later compiles against a stable substrate. `/shipshape` at boundary; quick `/verify` eyeball of the thumbnail chip.
  - [ ] `router-build-user-content-hook` (low/mechanical) — optional `buildUserContent?` on `SubagentRole`, nullish-coalescing dispatch in `route()`, string-vs-array guard at the four `inputBytes` trace sites. Transport already typed `MessageContent` — no widening needed.
  - [ ] `attachment-type-threading` (low/mechanical) — optional `type`/`mimeType` on the attachment shape at [chatProvider.ts:44](../../src/providers/chatProvider.ts#L44), [requestOrchestrator.ts:809](../../src/providers/requestOrchestrator.ts#L809), [media/chat.ts:340](../../media/chat.ts#L340).
  - [ ] `webview-image-capture` (medium/moderate) — accept-list + FileReader branch + img-chip in `InputAreaShadowActor`; async canvas downscale with hard byte cap (cap after re-encode, reject before attach).
  - [ ] `custom-models-schema-fix` (low/mechanical) — `subagentRoles` + `acceptsImages` in the package.json customModels schema; mirror the existing one-line optional-axis checks in `validateCustomModelEntry`; explicit `moby.subagents.image-describe` property.
- [ ] **2. Role module + settings filter** *(opus)* — `/shipshape` at boundary.
  - [ ] `image-describe-role-module` (medium/moderate) — clone `webSearchDigest.ts` shape; VL prompt contract + lenient parse (fence-strip, first-`{…}`, garbage → null).
  - [ ] `accepts-images-capability-filter` (low/mechanical) — filter the image-describe dropdown to `acceptsImages` models, extension-side from the registry.
- [ ] **3. Orchestrator branch + guard rails + tests** *(opus)* — `/shipshape`, then dev-host `/verify`: attach → "Analyzing image…" → digest in chat; no backend → placeholder.
  - [ ] `orchestrator-image-injection` (medium/moderate, risk: medium) — partition attachments by type at [requestOrchestrator.ts:1050](../../src/providers/requestOrchestrator.ts#L1050), `Promise.all` the `route()` calls, append digest or named placeholder; never let an image ride the text `--- Attached Files ---` path, never silently drop on `routed:false`.
  - [ ] `no-array-content-assertion` (low/mechanical) — **same commit** as the injection slice; assert main-model message content is never an array at the finalization choke point(s) covering both loops.
  - [ ] `analyzing-image-status-indicator` (low/mechanical) — mirror webSearching/webSearchComplete postMessages; emit complete in a `finally`.
  - [ ] `unit-tests` (medium/moderate) — role tests, router-hook tests, orchestrator branch (digest-append / placeholder / trace-guard contracts).
- [ ] **4. Thumbnail + digest persistence** *(opus)* — own phase because its failure mode (full-res base64 in the events table) is **silent**. Gate: persisted-attachment-size unit test + `Moby: Export Turn as JSON` during `/verify`.
  - [ ] `thumbnail-digest-persistence` (medium/moderate, risk: medium) — thread the webview-made ~256px thumbnail + digest into `UserMessageEvent.attachments` (shape already exists in [EventTypes.ts:31](../../src/events/EventTypes.ts#L31)); full-res bytes never reach the table.
- [ ] **5. Transcript thumbnail render on reload** *(fable + adversarial verify — the only slice that warrants it)* — ADR 0003 hydration-invariant work: restore-path render must not double what the live path drew; a plausible-but-wrong version passes live testing and breaks only on reload/fork. `/verify` must exercise reload, session switch, and fork explicitly, then `/shipshape`.
  - [ ] `transcript-thumbnail-render` (high/hard-reasoning) — thumbnail segment type in the webview's local event model; project persisted attachment → renderable segment on hydration; live/restore consistency.
- [ ] **6. Manual-test backlog + discharge** *(opus)* — also the trigger for the jsonMode-on-VL-backend empirical check. Final `/verify` session discharges the entries.
  - [ ] `manual-test-backlog-entries` (low/mechanical) — the five scenarios from [Testing](#testing), per the backlog template.

### Sequencing risks

1. **Phase 1→3 window:** once the accept-list admits images, an image must never ride the text path — land phases 1–3 before any release/tag (or placeholder unknown-type attachments in the orchestrator from day one).
2. **jsonMode on VL backends** is only testable empirically in phase 6; if it fails, the per-role jsonMode opt-out contingency touches the phase-2 role module — keep it in mind when writing `imageDescribe.ts`.
3. **Phase 5 may slip** — phases 1–4 + 6 (minus the reload scenario) are a shippable increment without it.

### Verification roster

| Gate | When | What |
| --- | --- | --- |
| `/shipshape` | every phase boundary | compile + suites green twice + docs/conventions |
| `/verify` | after 3 | attach → indicator → digest; no-backend placeholder |
| `/verify` | after 4 | Export Turn as JSON — no full-res bytes persisted (the one silent risk outside phase 5) |
| `/verify` + adversarial verify | after 5 | reload, session switch, fork render — no double-draw |
| `/verify` | phase 6 | discharge the backlog entries (shipshape green does not) |

## Related

- [subagents.md](subagents.md) — parent design; router/role/capability conventions this follows.
- [ADR 0003](../architecture/decisions/0003-events-table-sole-source-of-truth.md) — persistence contract driving decision #3.
- DeepSeek API vision research (2026-07-04): first-party API text-only; website upload is app-side OCR; DeepSeek VL/Janus are open-weight only; SiliconFlow `deepseek-ai/deepseek-vl2` is the OpenAI-compatible drop-in.
