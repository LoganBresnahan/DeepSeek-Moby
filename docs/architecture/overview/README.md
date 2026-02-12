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
│  │          VirtualMessageGatewayActor (Boundary)              ││
│  │              Routes messages to VirtualListActor            ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐│
│  │                    VirtualListActor                          ││
│  │         Pool of MessageTurnActors + Turn Data                ││
│  │  ┌──────────────────────────────────────────────────────┐   ││
│  │  │ MessageTurnActor (all content types in one actor)    │   ││
│  │  │  - Text segments (with code blocks)                  │   ││
│  │  │  - Thinking iterations                               │   ││
│  │  │  - Tool call batches                                 │   ││
│  │  │  - Shell command output                              │   ││
│  │  │  - Pending file changes                              │   ││
│  │  └──────────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Documentation Structure

### Backend (Extension)

| File | Description |
|------|-------------|
| [backend-architecture.md](../backend/backend-architecture.md) | ChatProvider orchestrator, request lifecycle, design patterns |
| [event-sourcing.md](../backend/event-sourcing.md) | Event Sourcing architecture, ConversationManager, snapshots |
| [database-layer.md](../backend/database-layer.md) | SQLite persistence with @signalapp/sqlcipher, schema design |
| [tool-execution.md](../backend/tool-execution.md) | Tool loop, shell commands, file operations |
| [token-counting.md](../backend/token-counting.md) | WASM tokenizer, context budgeting, cross-validation |

### Frontend (Webview)

| File | Description |
|------|-------------|
| [actor-system.md](../frontend/actor-system.md) | EventStateManager, Unified Turn Architecture, actor lifecycle |
| [shadow-dom.md](../frontend/shadow-dom.md) | ShadowActor base class, style isolation |
| [message-gateway.md](../frontend/message-gateway.md) | VirtualMessageGatewayActor for VS Code communication |
| [actor-diagram.md](actor-diagram.md) | Visual diagram of actor relationships |

### Integration

| File | Description |
|------|-------------|
| [chat-streaming.md](../integration/chat-streaming.md) | Request → Stream → Tools → Response cycle |
| [message-bridge.md](../integration/message-bridge.md) | postMessage protocol between extension and webview |
| [diff-engine.md](../integration/diff-engine.md) | Edit modes (manual/ask/auto), diff lifecycle, pending changes |

### Reference

| File | Description |
|------|-------------|
| [state-keys.md](../reference/state-keys.md) | Reference of all pub/sub state keys |
| [logging-system.md](../reference/logging-system.md) | Logging infrastructure |
| [getter-pattern.md](../reference/getter-pattern.md) | State getter patterns |

### Guides

| File | Description |
|------|-------------|
| [e2e-testing.md](../../guides/testing/e2e-testing.md) | End-to-end testing strategies |

### Plans

| File | Description |
|------|-------------|
| [context-management.md](../../plans/context-management.md) | Wire ContextBuilder into request flow |
| [dead-code-cleanup.md](../../plans/dead-code-cleanup.md) | Cleanup status (complete) |
| [backend-refactor.md](../../plans/backend-refactor.md) | Event Sourcing implementation plan |
| [tokenizer.md](../../plans/tokenizer.md) | WASM tokenizer plan (complete) |

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

### Unified Turn Architecture (Frontend)

The webview uses the **Unified Turn Architecture**:

- **VirtualMessageGatewayActor**: Receives all VS Code messages, routes to VirtualListActor
- **VirtualListActor**: Manages pool of MessageTurnActors, stores turn data as source of truth
- **MessageTurnActor**: Renders all content types (text, thinking, tools, shell, pending) for a single turn

Benefits:
- **Virtual rendering** - Only visible turns have bound actors
- **Actor pooling** - Actors are recycled when turns scroll out of view
- **Unified coordination** - One actor per turn instead of 5+ separate actors

### Shadow DOM Isolation

Actors use Shadow DOM to:
- Encapsulate styles (no CSS leakage)
- Create independent UI trees
- Support multiple container types within a turn

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
  - Extension: [src/extension.ts](../../../src/extension.ts)
  - Webview: [media/chat.ts](../../../media/chat.ts)

- **Core Classes**:
  - [ConversationManager](../../../src/events/ConversationManager.ts) - Event sourcing orchestrator
  - [EventStore](../../../src/events/EventStore.ts) - Append-only event storage
  - [ChatProvider](../../../src/providers/chatProvider.ts) - Request orchestrator
  - [EventStateManager](../../../media/state/EventStateManager.ts) - Frontend pub/sub
  - [VirtualListActor](../../../media/actors/virtual-list/VirtualListActor.ts) - Pool management
  - [MessageTurnActor](../../../media/actors/turn/MessageTurnActor.ts) - Turn rendering

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
│         Stream Response ──postMessage──► VirtualListActor                   │
│                                              │                              │
│                                              ▼                              │
│                                      MessageTurnActor                       │
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
