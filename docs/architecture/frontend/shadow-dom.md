# Shadow DOM Architecture

Shadow DOM provides style encapsulation and DOM isolation for actors. This document covers the ShadowActor pattern and the interleaved rendering system.

## Why Shadow DOM?

### Problems Solved

1. **Style Leakage**: Without isolation, CSS from one component affects others
2. **Naming Conflicts**: Class names can collide across components
3. **Global Pollution**: Components can accidentally modify each other's DOM
4. **Interleaving**: Need to render components as siblings while maintaining isolation

### Shadow DOM Benefits

```
Without Shadow DOM:                 With Shadow DOM:
┌─────────────────────┐            ┌─────────────────────┐
│ #chatMessages       │            │ #chatMessages       │
│  ├─ .message        │            │  ├─ [shadow-root]   │
│  │   └─ .content    │ ◄─ Styles  │  │   └─ .content    │ ◄─ Isolated!
│  ├─ .thinking       │    leak!   │  ├─ [shadow-root]   │
│  │   └─ .content    │            │  │   └─ .content    │ ◄─ Isolated!
│  └─ .message        │            │  └─ [shadow-root]   │
└─────────────────────┘            └─────────────────────┘
```

## ShadowActor Base Class

All Shadow DOM actors extend `ShadowActor` (which itself extends `EventStateActor`):

```typescript
interface ShadowActorConfig {
  manager: EventStateManager;
  element: HTMLElement;
  publications: PublicationMap;
  subscriptions: SubscriptionMap;
  styles: string;        // CSS scoped to this actor's shadow root
  template?: string;     // optional initial HTML for the content root
  shadowMode?: 'open' | 'closed';  // default 'open'
}

abstract class ShadowActor extends EventStateActor {
  protected readonly shadow: ShadowRoot;
  protected readonly contentRoot: HTMLElement; // <div class="shadow-content">
  protected readonly manager: EventStateManager;

  constructor(config: ShadowActorConfig);

  // Concrete helper (not abstract): replaces contentRoot.innerHTML
  protected render(html: string): void;
}
```

Publication and subscription keys are derived from the config's `publications`/`subscriptions`
maps by the `EventStateActor` base class (stored as frozen `private readonly` arrays); `actorId`
is a `protected readonly` derived from the host element's id. Styles come from `config.styles` —
there is no abstract `styles()` method.

**Location**: [media/state/ShadowActor.ts](../../../media/state/ShadowActor.ts)

### Lifecycle

```
┌────────────────────────────────────────────────────────────┐
│                    ShadowActor Lifecycle                    │
└────────────────────────────────────────────────────────────┘

   constructor(config)         Host element passed in via config
         │
         ▼
   ┌─────────────┐
   │attachShadow │  this.element.attachShadow({ mode })
   │ ('open')    │  ('open' by default for inspectability)
   └──────┬──────┘
         │
         ▼
   ┌──────────────┐
   │adoptedStyle  │  [baseSheet, actorSheet] — no <style>
   │ Sheets       │  element is injected
   └──────┬───────┘
         │
         ▼
   ┌─────────────┐
   │ contentRoot │  Create <div class="shadow-content">,
   │  + template │  apply config.template if provided
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │ register()  │  Scheduled via queueMicrotask() in the
   │             │  EventStateActor constructor
   └─────────────┘
```

## Interleaved Rendering

The key innovation: actors render as **siblings** in a shared container, but each has its own shadow root.

### The Problem

During streaming, content arrives interleaved:
1. Text chunk
2. Thinking content
3. More text
4. Tool calls
5. Shell commands
6. More text

We need these to appear **in order** visually.

### The Solution

Every interleaved container host carries `data-actor="turn"` (the actor's
`actorName`); the content type is conveyed by the host `id` prefix
(`message-…`, `thinking-…`, `shell-…`, etc.), not by differing `data-actor`
values. The containers belong to a single `MessageTurnActor` and are appended
to that turn's mount point inside `#chatMessages`.

```
DOM Structure:
┌─────────────────────────────────────────────────────────────┐
│ #chatMessages (light DOM container)                          │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div#message-1-… [data-actor="turn"]                   │  │
│  │   └── #shadow-root  (adoptedStyleSheets: [base,turn]) │  │
│  │         └── <div class="container">                   │  │
│  │               <div class="message user">Hello</div>   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div#message-2-… [data-actor="turn"]                   │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="message assistant">...</div>  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div#thinking-1-… [data-actor="turn"]                  │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="thinking">Deep thought...</   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div#message-3-… [data-actor="turn"]                   │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="message assistant">More...</  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div#shell-1-… [data-actor="turn"]                     │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="shell-commands">...</div>     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘

Visual Order (matches DOM order):
┌─────────────────────┐
│ User: Hello         │
├─────────────────────┤
│ Assistant: ...      │
├─────────────────────┤
│ 💭 Deep thought...  │  ◄─ Thinking block
├─────────────────────┤
│ Assistant: More...  │  ◄─ Continuation
├─────────────────────┤
│ $ git status        │  ◄─ Shell commands
└─────────────────────┘
```

### Creating Interleaved Segments

Interleaved rendering is handled by a single `MessageTurnActor` (one actor per
conversation turn) that extends `InterleavedShadowActor`. It creates each shadow
container through the inherited `createContainer(idPrefix, options)`, and text
segments specifically through `createTextSegment()`:

```typescript
// InterleavedShadowActor (base) creates shadow-encapsulated containers
class InterleavedShadowActor extends EventStateActor {
  protected containers: Map<string, ShadowContainer> = new Map();
  protected idCounter = 0;

  protected createContainer(idPrefix: string, options?): ShadowContainer {
    this.idCounter++;
    const id = `${idPrefix}-${this.idCounter}-${Date.now()}`;

    const host = document.createElement('div');
    host.id = id;
    host.setAttribute('data-actor', this.actorName); // 'turn' for MessageTurnActor
    host.setAttribute('data-container-id', id);

    const shadow = host.attachShadow({ mode: this.shadowMode });
    shadow.adoptedStyleSheets = this._adoptedSheets; // [base, actor] — cached

    const content = document.createElement('div');
    content.className = 'container';
    shadow.appendChild(content);

    this.element.appendChild(host); // append to the actor's mount point
    this.containers.set(id, { id, host, shadow, content, createdAt: Date.now() });
    return container;
  }
}

// MessageTurnActor (actorName 'turn') creates a text segment via createContainer('message', ...)
class MessageTurnActor extends InterleavedShadowActor {
  createTextSegment(content = '', options?): string { /* ... */ }
}
```

### Segment Boundaries

Text is the **sole** section delimiter. Interleaved thinking/tools/shell/pending
content does **not** split text segments — those groups coalesce into their own
shared containers. A new text segment is only started by `createTextSegment()`,
which closes the active coalesced thinking/tool/pending groups so the next ones
start fresh containers below the text:

```
            Text streaming...
                   │
                   ▼  (updateTextContent appends into the current
                   │   text container; lazily creates one if none exists)
        Thinking/Tool/Shell content appears
        (coalesced into its own shadow container,
         a sibling in DOM — text is NOT split)
                   │
                   ▼
        More text arrives...
                   │
                   ▼
        ┌─────────────────────────┐
        │ createTextSegment()     │
        │ • Clears active         │
        │   thinking/tool/pending │
        │   groups (delimiter)    │
        │ • Creates a new text    │
        │   container             │
        └─────────────────────────┘
```

## Style Injection

Each actor defines its styles in a separate file. The turn actor's CSS lives under
`media/actors/turn/styles/`; most other actors use a `shadowStyles.ts` file:

```
media/actors/
  ├── turn/
  │   ├── MessageTurnActor.ts
  │   └── styles/
  │       └── index.ts             ◄─ exports `turnActorStyles` (CSS string)
  └── input-area/
      ├── InputAreaShadowActor.ts
      └── shadowStyles.ts          ◄─ CSS as string
```

### shadowStyles.ts Pattern

```typescript
export const inputAreaShadowStyles = `
  :host {
    display: block;
  }

  .message {
    padding: 12px;
    margin: 8px 0;
  }

  .message.user {
    background: var(--vscode-input-background);
  }

  .message.assistant {
    background: var(--vscode-editor-background);
  }
`;
```

### Adopted StyleSheets (Performance)

Instead of injecting `<style>` elements into each shadow root, actors share pre-parsed `CSSStyleSheet` objects via `adoptedStyleSheets`:

```typescript
// EventStateManager caches parsed stylesheets.
// The actor-specific sheet is cached by class name (this.constructor.name).
const baseSheet  = manager.getShadowBaseSheet();                       // ShadowActor base
const actorSheet = manager.getStyleSheet(css, this.constructor.name);  // cached per actor type

this.shadow.adoptedStyleSheets = [baseSheet, actorSheet];
```

There are two base sheets: `ShadowActor` adopts `manager.getShadowBaseSheet()`, while
`InterleavedShadowActor` (the turn/segment actor most of this doc describes) adopts
`manager.getInterleavedBaseSheet()`. Both share actor-specific sheets via
`manager.getStyleSheet(css, cacheKey)`.

**Benefits:**
- One parsed CSSOM tree shared across N shadow roots
- Reduces memory: 100 actors × 3KB CSS = 3KB total (not 300KB)
- No duplicate style parsing on each shadow root creation

**Implementation details:** See [REMINDER.md Scalability section](../../../REMINDER.md#scalability--mitigations)

### VS Code Theme Variables

Actors use CSS custom properties from VS Code:

```css
/* Common variables */
--vscode-foreground
--vscode-background
--vscode-input-background
--vscode-input-border
--vscode-button-background
--vscode-button-foreground
--vscode-editor-font-family
--vscode-editor-font-size
```

## Actor Types

### Fixed Position Actors

Actors that render to a fixed container:

```
┌─────────────────────────────────────────────┐
│ InputAreaShadowActor                        │
│ StatusPanelShadowActor                      │
│ ToolbarShadowActor                          │
│                                             │
│ These have a dedicated container element:   │
│   <div id="inputAreaContainer"></div>       │
└─────────────────────────────────────────────┘
```

### Interleaved Actors

The interleaved layer is consolidated into a single `MessageTurnActor`
(one per conversation turn). It creates a separate shadow container per
content type internally:

```
┌─────────────────────────────────────────────┐
│ MessageTurnActor (one per turn)             │
│   ├─ text segments                          │
│   ├─ thinking iterations                    │
│   ├─ tool call batches                      │
│   ├─ shell command segments                 │
│   ├─ command approvals                      │
│   └─ pending file groups                    │
│                                             │
│ Managed by VirtualListActor over            │
│   <div id="chatMessages"></div>             │
└─────────────────────────────────────────────┘
```

`VirtualListActor` pools and mounts the turn actors into `#chatMessages`;
the per-type actors (ThinkingActor, ShellActor, ToolCallsActor,
PendingChangesActor) no longer exist as separate classes.

### Overlay Actors

Actors that render modal/overlay UI from a fixed host appended to `document.body`:

```
┌─────────────────────────────────────────────┐
│ HistoryShadowActor (extends ShadowActor)    │
│                                             │
│ Host: fixed 0×0 div appended to body;       │
│ renders a backdrop + modal into its         │
│ content root.                               │
└─────────────────────────────────────────────┘
```

`InspectorShadowActor` is a **dev-mode-only** tool (`media/dev/inspector/`) that
extends `EventStateActor` — not `ShadowActor` — and is loaded via injected
`<script>` only when `moby.devMode` is enabled. It is not part of the production
actor set and is not in `window.actors`.

## Debugging Shadow DOM

### Chrome DevTools

1. Open DevTools (F12)
2. Elements panel shows shadow roots
3. Click `#shadow-root (open)` to expand
4. Styles panel shows shadow-scoped CSS

### Programmatic Access

```javascript
// In browser console — all interleaved hosts use data-actor="turn";
// the content type is in the id prefix (message-/thinking-/shell-/…).
const host = document.querySelector('[data-actor="turn"][id^="message-"]');
const shadow = host.shadowRoot;
console.log(shadow.innerHTML);
```

### Actor Manager Debug

```javascript
// Exposed on window for debugging
window.actorManager.getAllState();   // actorManager is the EventStateManager

// window.actors holds the live actor instances. Keys include:
//   streaming, session, editMode, gateway, header, scroll, inputArea,
//   statusPanel, toolbar, history, files, commandRules, systemPromptModal,
//   commands, modelSelector, settings, drawingServer, planPopup,
//   webSearchPopup, virtualList
// (There is no per-message actor; turn actors are pooled inside virtualList.)
window.actorManager.getState('turn.textSegmentCount'); // per-turn text-segment count
```

## Common Patterns

### Conditional Rendering

`render(html)` is a concrete helper that replaces `contentRoot.innerHTML`:

```typescript
private update(): void {
  if (!this.isVisible) {
    this.render(''); // Empty content root
    return;
  }
  this.render(`<div class="content">${this.content}</div>`);
}
```

### DOM Updates

```typescript
// Get element from shadow root (query() is shadow-scoped)
const el = this.query<HTMLElement>('.content');
if (el) {
  el.textContent = newContent;
}
```

### Event Delegation

Use the `delegate()` helper, which sets up delegation on the content root:

```typescript
this.delegate('click', '.action-btn', (event, matched) => {
  this.handleAction(matched.dataset.action);
});
```

## Migration Guide

Converting a light DOM component to Shadow Actor:

1. Create `shadowStyles.ts` with component CSS
2. Extend `ShadowActor` base class
3. In the constructor, call `super()` with a `ShadowActorConfig`: `manager`,
   `element` (the host), `publications`, `subscriptions`, and `styles` (the CSS
   string). Publication/subscription keys are derived from those maps.
4. Render with `this.render(html)` (replaces the content root)
5. Wire event handlers via `this.delegate(eventType, selector, handler)` or
   `this.addShadowListener(...)`
6. Replace direct DOM queries with `this.query()` / `this.queryAll()`
