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

All Shadow DOM actors extend `ShadowActor`:

```typescript
abstract class ShadowActor {
  protected shadow: ShadowRoot;
  protected container: HTMLElement;
  protected manager: EventStateManager;

  // Subclasses define these
  protected abstract actorId: string;
  protected abstract publicationKeys: string[];
  protected abstract subscriptionKeys: string[];
  protected abstract styles(): string;
  protected abstract render(): string;
}
```

**Location**: [media/actors/ShadowActor.ts](../media/actors/ShadowActor.ts)

### Lifecycle

```
┌────────────────────────────────────────────────────────────┐
│                    ShadowActor Lifecycle                    │
└────────────────────────────────────────────────────────────┘

   constructor(manager, container)
         │
         ▼
   ┌─────────────┐
   │ createHost()│  Create wrapper div with data-actor attr
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │attachShadow │  mode: 'open' for debugging
   │ ('open')    │
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │injectStyles │  Insert <style> into shadow root
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │  render()   │  Initial DOM render
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │ register()  │  Register with EventStateManager
   └──────┬──────┘
         │
         ▼
   ┌─────────────┐
   │bindEvents() │  Set up internal event handlers
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

```
DOM Structure:
┌─────────────────────────────────────────────────────────────┐
│ #chatMessages (light DOM container)                          │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div[data-actor="message"]                             │  │
│  │   └── #shadow-root                                    │  │
│  │         ├── <style>...</style>                        │  │
│  │         └── <div class="message user">Hello</div>     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div[data-actor="message"]                             │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="message assistant">...</div>  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div[data-actor="thinking"]                            │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="thinking">Deep thought...</   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div[data-actor="message"]                             │  │
│  │   └── #shadow-root                                    │  │
│  │         └── <div class="message assistant">More...</  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ div[data-actor="shell"]                               │  │
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

```typescript
// MessageShadowActor creates new segments on demand
class MessageShadowActor extends ShadowActor {
  private segments: Map<string, { host: HTMLElement; shadow: ShadowRoot }>;

  createSegment(): string {
    const id = `segment-${Date.now()}`;
    const host = document.createElement('div');
    host.setAttribute('data-actor', 'message');
    host.setAttribute('data-segment', id);

    const shadow = host.attachShadow({ mode: 'open' });
    this.injectStyles(shadow);

    // Append to shared container (chatMessages)
    this.container.appendChild(host);

    this.segments.set(id, { host, shadow });
    return id;
  }
}
```

### Segment Finalization

When text content is interrupted by tools/thinking:

```
            Text streaming...
                   │
                   ▼
        ┌─────────────────────┐
        │ finalizeSegment()   │
        │ • Mark complete     │
        │ • Set flag: needs   │
        │   new segment       │
        └─────────────────────┘
                   │
                   ▼
        Thinking/Tool content appears
        (as sibling in DOM)
                   │
                   ▼
        More text arrives...
                   │
                   ▼
        ┌─────────────────────┐
        │ resumeWithNewSeg()  │
        │ • Create new host   │
        │ • Continue text     │
        └─────────────────────┘
```

## Style Injection

Each actor defines its styles in a separate file:

```
media/actors/
  └── message/
      ├── MessageShadowActor.ts
      └── shadowStyles.ts         ◄─ CSS as string
```

### shadowStyles.ts Pattern

```typescript
export const messageShadowStyles = `
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

Actors that create siblings in chatMessages:

```
┌─────────────────────────────────────────────┐
│ MessageShadowActor                          │
│ ThinkingShadowActor                         │
│ ShellShadowActor                            │
│ ToolCallsShadowActor                        │
│ PendingChangesShadowActor                   │
│                                             │
│ All share: <div id="chatMessages"></div>    │
└─────────────────────────────────────────────┘
```

### Overlay Actors

Actors that float above everything:

```
┌─────────────────────────────────────────────┐
│ InspectorShadowActor                        │
│ HistoryShadowActor                          │
│                                             │
│ Position: fixed, z-index: high              │
│ Own host appended to document.body          │
└─────────────────────────────────────────────┘
```

## Debugging Shadow DOM

### Chrome DevTools

1. Open DevTools (F12)
2. Elements panel shows shadow roots
3. Click `#shadow-root (open)` to expand
4. Styles panel shows shadow-scoped CSS

### Programmatic Access

```javascript
// In browser console
const host = document.querySelector('[data-actor="message"]');
const shadow = host.shadowRoot;
console.log(shadow.innerHTML);
```

### Actor Manager Debug

```javascript
// Exposed on window for debugging
window.actorManager.getAllState();
window.actors.message.getSegmentCount();
```

## Common Patterns

### Conditional Rendering

```typescript
protected render(): string {
  if (!this.isVisible) {
    return ''; // Empty shadow root
  }
  return `<div class="content">${this.content}</div>`;
}
```

### DOM Updates

```typescript
// Get element from shadow root
const el = this.shadow.querySelector('.content');
if (el) {
  el.textContent = newContent;
}
```

### Event Delegation

```typescript
bindEvents(): void {
  this.shadow.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.matches('.action-btn')) {
      this.handleAction(target.dataset.action);
    }
  });
}
```

## Migration Guide

Converting a light DOM component to Shadow Actor:

1. Create `shadowStyles.ts` with component CSS
2. Extend `ShadowActor` base class
3. Define `actorId`, `publicationKeys`, `subscriptionKeys`
4. Implement `styles()` returning CSS string
5. Implement `render()` returning HTML string
6. Move event handlers to `bindEvents()`
7. Replace direct DOM queries with `this.shadow.querySelector()`
