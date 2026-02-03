# DeepSeek Moby Architecture

This folder contains documentation for the internal architecture of the DeepSeek Moby VS Code extension.

## Overview

DeepSeek Moby is a VS Code extension that provides AI-powered chat and code assistance. The architecture consists of:

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code Extension                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ DeepSeek    │  │ Tavily      │  │ ChatHistoryManager      │  │
│  │ Client      │  │ Client      │  │ (Sessions, Storage)     │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                     │                 │
│         └────────────────┼─────────────────────┘                 │
│                          │                                       │
│                   ┌──────▼──────┐                                │
│                   │ ChatProvider │ ◄─── Tool Loop, Streaming     │
│                   └──────┬──────┘                                │
└──────────────────────────┼───────────────────────────────────────┘
                           │ postMessage
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Webview (chat.ts)                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    EventStateManager                         ││
│  │              (Central Pub/Sub Coordinator)                   ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │                                    │
│  ┌──────────┬───────────┬───┴───┬───────────┬──────────┐        │
│  ▼          ▼           ▼       ▼           ▼          ▼        │
│ Message  Thinking    Shell   ToolCalls  Pending   InputArea     │
│ Shadow   Shadow      Shadow  Shadow     Shadow    Shadow        │
│ Actor    Actor       Actor   Actor      Actor     Actor         │
│  │          │           │       │           │          │        │
│  └──────────┴───────────┴───────┴───────────┴──────────┘        │
│              ▼                                                   │
│     ┌─────────────────┐                                         │
│     │  #chatMessages  │  ◄─── Interleaved DOM siblings          │
│     │  (Container)    │                                         │
│     └─────────────────┘                                         │
└─────────────────────────────────────────────────────────────────┘
```

## Documentation Files

| File | Description |
|------|-------------|
| [actor-system.md](actor-system.md) | EventStateManager, pub/sub patterns, actor lifecycle |
| [shadow-dom.md](shadow-dom.md) | ShadowActor base class, style isolation, DOM interleaving |
| [chat-streaming.md](chat-streaming.md) | Request → Stream → Tools → Response cycle |
| [message-bridge.md](message-bridge.md) | postMessage protocol between extension and webview |
| [tool-execution.md](tool-execution.md) | Tool loop, shell commands, file operations |
| [diff-engine.md](diff-engine.md) | Edit modes (manual/ask/auto), diff lifecycle, pending changes |
| [state-keys.md](state-keys.md) | Reference of all pub/sub state keys |

## Key Concepts

### Actor Model
Each UI component is an **Actor** that:
- Owns its DOM (via Shadow DOM for isolation)
- Publishes state changes to keys it owns
- Subscribes to state changes it cares about
- Never directly manipulates other actors' DOM

### Shadow DOM Isolation
Actors use Shadow DOM to:
- Encapsulate styles (no CSS leakage)
- Create independent UI trees
- Support interleaved rendering (thinking ↔ text ↔ tools)

### Event-Driven State
All communication flows through `EventStateManager`:
- Actors register with publication/subscription keys
- State changes broadcast to relevant subscribers
- Circular dependency detection prevents infinite loops

### Message Bridge
Extension ↔ Webview communication via `postMessage`:
- Extension sends: streaming tokens, tool results, settings
- Webview sends: user input, file requests, commands

## Quick Links

- **Entry Points**:
  - Extension: [src/extension.ts](../src/extension.ts)
  - Webview: [media/chat.ts](../media/chat.ts)

- **Core Classes**:
  - [EventStateManager](../media/state/EventStateManager.ts)
  - [ChatProvider](../src/providers/chatProvider.ts)
  - [ShadowActor](../media/actors/ShadowActor.ts)

## Diagram Legend

Throughout these docs, you'll see Mermaid diagrams. Key conventions:

```
┌─────────┐     Component/Class
│         │
└─────────┘

    ──▶        Data flow direction

    ─ ─ ▶      Optional/conditional flow

   ║    ║
   ║    ║      Parallel processes
   ▼    ▼
```
