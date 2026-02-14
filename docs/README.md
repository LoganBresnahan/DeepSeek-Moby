# DeepSeek Moby Documentation

## Architecture

- [Overview](architecture/overview/README.md) - High-level architecture overview and diagrams
- [Actor Diagram](architecture/overview/actor-diagram.md) - Visual map of all actors

### Frontend (Webview)

- [Actor System](architecture/frontend/actor-system.md) - EventStateManager, Unified Turn Architecture
- [Shadow DOM](architecture/frontend/shadow-dom.md) - ShadowActor patterns, style isolation
- [Message Gateway](architecture/frontend/message-gateway.md) - VirtualMessageGatewayActor

### Backend (Extension)

- [Backend Architecture](architecture/backend/backend-architecture.md) - Event-driven coordinator, extracted managers
- [Event Sourcing](architecture/backend/event-sourcing.md) - ConversationManager, events, snapshots
- [Database Layer](architecture/backend/database-layer.md) - SQLite with @signalapp/sqlcipher
- [Tool Execution](architecture/backend/tool-execution.md) - Tool loop, shell commands
- [Token Counting](architecture/backend/token-counting.md) - WASM tokenizer, context budgeting, cross-validation

### Integration

- [Chat Streaming](architecture/integration/chat-streaming.md) - Full streaming flow
- [Message Bridge](architecture/integration/message-bridge.md) - postMessage protocol
- [Diff Engine](architecture/integration/diff-engine.md) - Edit modes, diff lifecycle

### Reference

- [State Keys](architecture/reference/state-keys.md) - All pub/sub keys
- [Logging System](architecture/reference/logging-system.md) - Logger configuration
- [Getter Pattern](architecture/reference/getter-pattern.md) - When to use getters vs publications

## Guides

### Testing

- [E2E Testing](guides/testing/e2e-testing.md) - Testing strategies for LLM applications

## Plans

- [ChatProvider Refactor](plans/chatprovider-refactor.md) - Event emitter extraction (6 phases, complete)
- [Context Management](plans/context-management.md) - Wire ContextBuilder into request flow (complete)
- [Dead Code Cleanup](plans/dead-code-cleanup.md) - Cleanup status (complete)
- [Backend Refactor](plans/backend-refactor.md) - Event Sourcing implementation plan
- [WASM Tokenizer](plans/tokenizer.md) - Tokenizer implementation plan (complete)
