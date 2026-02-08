# DeepSeek Moby Architecture

This folder contains documentation for the internal architecture of the DeepSeek Moby VS Code extension.

## Overview

DeepSeek Moby is a VS Code extension that provides AI-powered chat and code assistance. The architecture consists of:

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code Extension                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ DeepSeek    │  │ Tavily      │  │ ConversationManager     │  │
│  │ Client      │  │ Client      │  │ (Event Sourcing)        │  │
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

### Backend (Extension)

| File | Description |
|------|-------------|
| [backend-architecture.md](backend-architecture.md) | ChatProvider orchestrator, request lifecycle, design patterns |
| [event-sourcing.md](event-sourcing.md) | Event Sourcing architecture, ConversationManager, snapshots |
| [database-layer.md](database-layer.md) | SQLite persistence with sql.js, schema design |
| [chat-streaming.md](chat-streaming.md) | Request → Stream → Tools → Response cycle |
| [message-bridge.md](message-bridge.md) | postMessage protocol between extension and webview |
| [tool-execution.md](tool-execution.md) | Tool loop, shell commands, file operations |
| [diff-engine.md](diff-engine.md) | Edit modes (manual/ask/auto), diff lifecycle, pending changes |

### Frontend (Webview)

| File | Description |
|------|-------------|
| [actor-system.md](actor-system.md) | EventStateManager, pub/sub patterns, actor lifecycle |
| [shadow-dom.md](shadow-dom.md) | ShadowActor base class, style isolation, DOM interleaving |
| [state-keys.md](state-keys.md) | Reference of all pub/sub state keys |
| [actor-diagram.md](actor-diagram.md) | Visual diagram of actor relationships |
| [message-gateway.md](message-gateway.md) | MessageGatewayActor for VS Code communication |

### Testing & Development

| File | Description |
|------|-------------|
| [e2e-testing.md](e2e-testing.md) | End-to-end testing strategies |
| [logging-system.md](logging-system.md) | Logging infrastructure |
| [getter-pattern.md](getter-pattern.md) | State getter patterns |

## Key Concepts

### Event Sourcing (Backend)

The conversation state is managed through **Event Sourcing**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Event Sourcing Architecture                    │
│                                                                   │
│  Events (Append-Only Log)                                        │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                        │
│  │ E1  │→│ E2  │→│ E3  │→│ E4  │→│ E5  │→ ...                   │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘                        │
│     │                               │                            │
│     └───────────────┬───────────────┘                            │
│                     ▼                                            │
│              ┌─────────────┐                                     │
│              │  Snapshot   │ (Summary of E1-E5)                  │
│              └─────────────┘                                     │
│                     │                                            │
│                     ▼                                            │
│              ┌─────────────┐                                     │
│              │ LLM Context │ (Snapshot + Recent Events)          │
│              └─────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
```

Benefits:
- **Immutable history** - Events are never modified, only appended
- **Replay capability** - Reconstruct any past state by replaying events
- **Context compression** - Snapshots summarize old events for LLM context
- **Conversation forking** - Start new conversations from any point

### Actor Model (Frontend)

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
  - [ConversationManager](../src/events/ConversationManager.ts) - Event sourcing orchestrator
  - [EventStore](../src/events/EventStore.ts) - Append-only event storage
  - [ChatProvider](../src/providers/chatProvider.ts) - Request orchestrator
  - [EventStateManager](../media/state/EventStateManager.ts) - Frontend pub/sub
  - [ShadowActor](../media/actors/ShadowActor.ts) - UI component base

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Interaction                                │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Webview (Actors)                                │
│                                                                              │
│   InputAreaActor ──postMessage──► Extension                                  │
│                                        │                                     │
│                                        ▼                                     │
│                              ChatProvider.handleUserMessage()                │
│                                        │                                     │
│                    ┌───────────────────┼───────────────────┐                │
│                    ▼                   ▼                   ▼                │
│           ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐     │
│           │ DeepSeek    │    │ Conversation│    │ Tavily              │     │
│           │ Client      │    │ Manager     │    │ Client              │     │
│           └──────┬──────┘    └──────┬──────┘    └─────────────────────┘     │
│                  │                  │                                        │
│                  │                  ▼                                        │
│                  │         ┌────────────────────────────────────────┐       │
│                  │         │         Event Store (SQLite)           │       │
│                  │         │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │       │
│                  │         │  │Event1│ │Event2│ │Event3│ │ ...  │  │       │
│                  │         │  └──────┘ └──────┘ └──────┘ └──────┘  │       │
│                  │         └────────────────────────────────────────┘       │
│                  │                                                          │
│                  ▼                                                          │
│         Stream Response ──postMessage──► MessageShadowActor                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Diagram Legend

Throughout these docs, you'll see ASCII diagrams. Key conventions:

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
