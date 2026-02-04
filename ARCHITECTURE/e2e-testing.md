# E2E Testing for LLM Chat Applications

This document outlines the strategy for end-to-end testing of the DeepSeek Moby chat system.

## What is E2E Testing for LLMs?

End-to-end testing for LLM applications validates the **entire flow** from user input to final response, including:
- Message handling
- API calls to the LLM
- Tool execution (shell, file operations)
- Streaming/rendering
- State management

### The Key Challenge

**LLMs are non-deterministic.** Even with `temperature=0`, outputs can vary due to floating-point precision and hardware differences. This requires different testing strategies than traditional software.

---

## Testing Approaches

### 1. Mock/Stub API Testing (Deterministic)

Replace the LLM API with predictable responses:

```typescript
// Mock DeepSeek client that returns canned responses
const mockDeepSeekClient = {
  chat: async (messages) => {
    // Pattern matching on user input
    if (messages.some(m => m.content.includes('hello'))) {
      return { content: 'Hi! How can I help?' };
    }
    if (messages.some(m => m.content.includes('write a function'))) {
      return {
        content: 'Here\'s a function:\n```javascript\nfunction add(a, b) { return a + b; }\n```',
        tool_calls: []
      };
    }
    // Trigger tool use flow
    if (messages.some(m => m.content.includes('list files'))) {
      return {
        content: '',
        tool_calls: [{ name: 'shell_execute', arguments: { command: 'ls' }}]
      };
    }
  }
};
```

**Best for:**
- Testing the complete message flow (user → provider → webview → render)
- Validating tool execution chains (tool call → execution → result → continuation)
- Verifying UI state transitions (streaming → thinking → pending changes)

### 2. Trajectory/Workflow Testing

Define expected sequences and validate the flow:

```typescript
describe('Chat flow', () => {
  it('handles tool loop correctly', async () => {
    const trajectory = [
      { type: 'user_message', content: 'Create a test file' },
      { type: 'tool_call', name: 'write_file' },
      { type: 'tool_result', success: true },
      { type: 'assistant_message', contains: 'created' }
    ];

    await validateTrajectory(trajectory);
  });
});
```

### 3. Golden Output Testing (Regression)

Record actual LLM responses and replay them:

```typescript
// Record mode: save real API responses
const recording = await recordLLMSession('test-scenario-1');

// Playback mode: replay recorded responses
const result = await replayLLMSession(recording);
expect(result.finalState).toMatchSnapshot();
```

---

## Existing Logger Infrastructure

We have **two loggers** that see different parts of the system:

| Logger | Location | What It Sees |
|--------|----------|--------------|
| `src/utils/logger.ts` | Extension side | API calls, tool execution, shell results, sessions |
| `media/state/EventStateLogger.ts` | Webview side | State changes, actor communication, pub/sub flow |

### Extension Logger Events

```typescript
// Session events
logger.sessionStart(sessionId, title)
logger.sessionSwitch(sessionId)
logger.sessionClear()

// API events
logger.apiRequest(model, messageCount, hasImages)
logger.apiResponse(tokenCount, durationMs)
logger.apiError(error, details)
logger.apiAborted()

// Tool events
logger.toolCall(toolName)
logger.toolResult(toolName, success)

// Shell events (R1 reasoner)
logger.shellExecuting(command)
logger.shellResult(command, success, output)

// Code actions
logger.codeApplied(success, file)
logger.diffShown(file)

// Web search
logger.webSearchRequest(query, searchDepth)
logger.webSearchResult(resultCount, durationMs)
```

### EventState Logger Events

```typescript
// Actor lifecycle
logger.actorRegister(actorId, publicationKeys, subscriptionKeys)
logger.actorUnregister(actorId, remainingActors)

// State flow
logger.stateChangeFlow(source, changedKeys, chainDepth)
logger.broadcastToActor(actorId, keys)

// Errors
logger.circularDependency(chain)
logger.subscriptionError(actorId, key, error)
logger.publicationError(actorId, key, error)
```

---

## Using Loggers for Testing

### Trace Recording

```typescript
// Capture all events during a test run
const trace: LogEvent[] = [];
logger.on('event', (e) => trace.push(e));

await runChatScenario('hello world');

expect(trace).toMatchObject([
  { type: 'apiRequest', model: 'deepseek-chat' },
  { type: 'apiResponse', tokenCount: expect.any(Number) },
]);
```

### State Snapshots

```typescript
// Capture EventStateManager state at key points
const states = [];
manager.on('stateChange', (s) => states.push(s));

// Verify state flow
expect(states.map(s => s.changedKeys)).toEqual([
  ['streaming.active'],
  ['streaming.content'],
  ['message.added'],
  ['streaming.active']
]);
```

---

## Recommended Test Types

| Test Type | Purpose | Deterministic? | Uses Real LLM? |
|-----------|---------|----------------|----------------|
| Unit tests | Individual actors/components | Yes | No |
| Integration tests | Message flow, tool chains | Yes | No (mocked) |
| Snapshot tests | DOM rendering | Yes | No |
| **E2E with mocks** | Full flow with canned responses | Yes | No |
| **E2E with recordings** | Regression against recorded sessions | Yes | Recorded |
| E2E with real API | Behavioral validation | No | Yes |

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Test Layer                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Mock Client  │  │ Recording    │  │ Scenario Runner      │  │
│  │              │  │ Playback     │  │                      │  │
│  │ Canned       │  │              │  │ - Load scenario      │  │
│  │ responses    │  │ - Record     │  │ - Execute steps      │  │
│  │ based on     │  │   real LLM   │  │ - Validate state     │  │
│  │ input        │  │ - Replay     │  │ - Check trajectory   │  │
│  │ patterns     │  │   for tests  │  │                      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │               │
│         └─────────────────┼──────────────────────┘               │
│                           ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    ChatProvider                              ││
│  │                    (with injected client)                    ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐│
│  │                    Trace Collector                           ││
│  │  - Logger events                                             ││
│  │  - State changes                                             ││
│  │  - Message bridge traffic                                    ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Mock Client Infrastructure

1. **Create MockDeepSeekClient** (`tests/mocks/MockDeepSeekClient.ts`)
   - Pattern-based response matching
   - Configurable tool call triggers
   - Streaming simulation support

2. **Create MockTavilyClient** (`tests/mocks/MockTavilyClient.ts`)
   - Canned search results
   - Error simulation

### Phase 2: Scenario Framework

1. **Define scenario format** (`tests/e2e/scenarios/*.json`)
   ```json
   {
     "name": "basic-greeting",
     "steps": [
       { "action": "user_message", "content": "Hello" },
       { "expect": "assistant_message", "contains": "help" }
     ]
   }
   ```

2. **Create ScenarioRunner** (`tests/e2e/ScenarioRunner.ts`)
   - Load scenarios
   - Execute steps
   - Validate expectations

### Phase 3: Trace Recording

1. **Add trace hooks to logger** (`src/utils/logger.ts`)
   - Event emission for all log calls
   - Structured trace format

2. **Create TraceCollector** (`tests/e2e/TraceCollector.ts`)
   - Aggregate events from both loggers
   - Timeline reconstruction

### Phase 4: Recording/Playback

1. **Create SessionRecorder** (`tests/e2e/SessionRecorder.ts`)
   - Capture real API responses
   - Store as test fixtures

2. **Create SessionPlayer** (`tests/e2e/SessionPlayer.ts`)
   - Load recorded sessions
   - Replay for regression tests

---

## Test Scenarios to Implement

### Basic Flows
- [ ] Simple greeting exchange
- [ ] Multi-turn conversation
- [ ] Code generation request
- [ ] Error handling (API failure)

### Tool Execution
- [ ] Single tool call (read file)
- [ ] Tool chain (search → read → write)
- [ ] Shell command execution
- [ ] Tool call failure handling

### Streaming
- [ ] Content streaming display
- [ ] Thinking/reasoning display (R1 model)
- [ ] Stream interruption (user cancel)

### Edit Modes
- [ ] Manual mode diff flow
- [ ] Ask mode prompt flow
- [ ] Auto mode application

### State Management
- [ ] Session persistence
- [ ] History loading
- [ ] Settings changes during chat

---

## Key Metrics to Track

| Metric | Description |
|--------|-------------|
| Response time | Time from user send to first token |
| Token throughput | Tokens per second during streaming |
| Tool execution time | Time for each tool call |
| State transition count | Number of pub/sub events per request |
| Error rate | Failed requests / total requests |

---

## References

- [LLM Testing in 2025: The Ultimate Guide](https://orq.ai/blog/llm-testing)
- [Testing for LLM Applications - Langfuse](https://langfuse.com/blog/2025-10-21-testing-llm-applications)
- [LLM Chatbot Evaluation - Confident AI](https://www.confident-ai.com/blog/llm-chatbot-evaluation-explained-top-chatbot-evaluation-metrics-and-testing-techniques)
- [MockLLM: Simulated LLM API](https://dev.to/lukehinds/mockllm-a-simulated-large-language-model-api-for-development-and-testing-2d53)
- [Mocking LLM Responses - MLOps Community](https://home.mlops.community/public/blogs/effective-practices-for-mocking-llm-responses-during-the-software-development-lifecycle)
- [LangChain Testing Docs](https://docs.langchain.com/oss/python/langchain/test)
- [LLM Observability - Langfuse](https://langfuse.com/docs/observability/overview)
- [End-to-End LLM Evaluation - DeepEval](https://deepeval.com/docs/evaluation-end-to-end-llm-evals)
