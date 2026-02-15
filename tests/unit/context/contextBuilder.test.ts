import { describe, it, expect, vi } from 'vitest';
import { ContextBuilder, SnapshotSummary } from '../../../src/context/contextBuilder';
import { EstimationTokenCounter, TokenCounter } from '../../../src/services/tokenCounter';
import type { Message } from '../../../src/deepseekClient';

/** Helper: create a mock exact token counter with a fixed ratio */
function createExactCounter(ratio = 0.3): TokenCounter {
  return {
    isExact: true,
    count(text: string) { return Math.ceil(text.length * ratio); },
    countMessage(role: string, content: string) {
      const overhead = role === 'system' ? 8 : 4;
      return Math.ceil(content.length * ratio) + overhead;
    },
  };
}

function makeMessages(count: number, contentLength = 100): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'x'.repeat(contentLength),
  }));
}

describe('ContextBuilder', () => {
  it('should include all messages when within budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const result = await builder.build(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      'You are a helpful assistant.',
      'deepseek-chat'
    );

    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toHaveLength(2);
    expect(result.summaryInjected).toBe(false);
  });

  it('should drop oldest messages when over budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    // Each message: 5000 chars * 0.3 = 1500 tokens + 4 overhead = 1504
    // 100 messages = ~150,400 tokens, well over budget
    const messages = makeMessages(100, 5000);
    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(result.budget);
  });

  it('should preserve most recent messages when dropping', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    // Make messages with identifiable content
    const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'x'.repeat(5000)}`,
    }));

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    // The last message should always be included
    const lastContent = result.messages[result.messages.length - 1].content;
    expect(lastContent).toContain('Message 99');
  });

  it('should account for system prompt in budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const longSystemPrompt = 'x'.repeat(100000); // ~30,000 tokens
    const messages = makeMessages(10, 100);

    const result = await builder.build(messages, longSystemPrompt, 'deepseek-chat');

    // System prompt cost should be included in tokenCount
    expect(result.tokenCount).toBeGreaterThan(30000);
  });

  it('should inject snapshot summary when messages are dropped', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const messages = makeMessages(100, 5000);
    const snapshot: SnapshotSummary = {
      summary: 'The user asked about X, the assistant explained Y.',
      tokenCount: counter.countMessage('user', 'The user asked about X, the assistant explained Y.'),
      snapshotId: 'snap-1',
    };

    const result = await builder.build(messages, undefined, 'deepseek-chat', snapshot);

    expect(result.truncated).toBe(true);
    expect(result.summaryInjected).toBe(true);
    // First message should be the summary
    expect(result.messages[0].content).toContain('[Previous conversation context]');
    expect(result.messages[0].content).toContain(snapshot.summary);
    // Second message should be the assistant acknowledgment
    expect(result.messages[1].role).toBe('assistant');
  });

  it('should not inject summary when no messages are dropped', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const messages = makeMessages(2, 50);
    const snapshot: SnapshotSummary = {
      summary: 'Some summary',
      tokenCount: counter.countMessage('user', 'Some summary'),
      snapshotId: 'snap-2',
    };

    const result = await builder.build(messages, undefined, 'deepseek-chat', snapshot);

    expect(result.truncated).toBe(false);
    expect(result.summaryInjected).toBe(false);
  });

  it('should apply safety margin for estimation-based counter', async () => {
    const estimation = new EstimationTokenCounter();
    const exact = createExactCounter();

    const builderEstimation = new ContextBuilder(estimation);
    const builderExact = new ContextBuilder(exact);

    const messages = makeMessages(50, 5000);

    const resultEstimation = await builderEstimation.build(messages, undefined, 'deepseek-chat');
    const resultExact = await builderExact.build(messages, undefined, 'deepseek-chat');

    // Estimation should be more conservative (drop more messages)
    expect(resultEstimation.droppedCount).toBeGreaterThanOrEqual(resultExact.droppedCount);
  });

  it('should not apply safety margin for exact counter', async () => {
    const exact = createExactCounter();
    const builder = new ContextBuilder(exact);

    const messages = makeMessages(2, 50);
    const result = await builder.build(messages, undefined, 'deepseek-chat');

    // Budget should be the full budget without safety margin
    expect(result.budget).toBe(128_000 - 8_192);
  });

  it('should use correct budget for deepseek-reasoner', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const result = await builder.build(
      [{ role: 'user', content: 'test' }],
      undefined,
      'deepseek-reasoner'
    );

    // Reasoner reserves 16384 for output
    expect(result.budget).toBe(128_000 - 16_384);
  });

  it('should use default budget for unknown models', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const result = await builder.build(
      [{ role: 'user', content: 'test' }],
      undefined,
      'unknown-model-v99'
    );

    // Should fall back to default (same as deepseek-chat)
    expect(result.budget).toBe(128_000 - 8_192);
  });

  it('should handle multimodal content (array format)', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
        ],
      },
      { role: 'assistant', content: 'I see a cat.' },
    ];

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it('should handle empty message list', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    const result = await builder.build([], 'system prompt', 'deepseek-chat');

    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
  });

  it('should not split tool-call / tool-result pairs at cutoff boundary', async () => {
    // Use exact counter with known ratio so we can control budget precisely
    const counter = createExactCounter(0.3);
    const builder = new ContextBuilder(counter);

    // Build messages: old conversation + a tool pair + more conversation
    // We want the cutoff to land right in the middle of the tool pair
    const messages: Message[] = [
      // Old messages that will be dropped (large to force truncation)
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: 'x'.repeat(20000),
      })),
      // Tool pair that might get split
      {
        role: 'assistant' as const,
        content: 'I will read the file',
        tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"app.ts"}' } }],
      },
      {
        role: 'tool' as const,
        content: 'file contents here',
        tool_call_id: 'call-1',
      },
      // Recent messages that should always be kept
      { role: 'assistant' as const, content: 'Here is what I found.' },
      { role: 'user' as const, content: 'Thanks, now fix it.' },
    ];

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(true);

    // Verify no orphaned tool results exist
    for (const msg of result.messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        // There must be an assistant with matching tool_calls earlier in the array
        const hasParent = result.messages.some(
          m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === msg.tool_call_id)
        );
        expect(hasParent).toBe(true);
      }
    }

    // Verify no assistant with tool_calls has missing tool results
    for (const msg of result.messages) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          const hasResult = result.messages.some(
            m => m.role === 'tool' && m.tool_call_id === tc.id
          );
          expect(hasResult).toBe(true);
        }
      }
    }
  });

  it('should drop orphaned tool result at cutoff boundary', async () => {
    // Exact counter: chars * 0.3 + 4 overhead per message
    // Budget: (128000 - 8192) * 1.0 = 119808 tokens (no system prompt)
    const counter = createExactCounter(0.3);
    const builder = new ContextBuilder(counter);

    // Layout (indices):
    //   0: user (20000 chars = 6004 tokens)
    //   1: assistant (20000 chars = 6004 tokens)
    //   2: assistant w/tool_calls (40000 chars = 12004 tokens) — LARGE so it won't fit
    //   3: tool result (small = ~12 tokens)
    //   4-21: 18 recent messages (20000 chars = 6004 tokens each)
    //
    // Backward fill: 18 msgs (108072) + tool (12) = 108084. Remaining: 11724.
    // Index 2 costs 12004 > 11724, so cutoff = 3.
    // Index 3 (tool result) is kept initially but its parent (index 2) was dropped.
    const messages: Message[] = [
      { role: 'user' as const, content: 'x'.repeat(20000) },
      { role: 'assistant' as const, content: 'x'.repeat(20000) },
      {
        role: 'assistant' as const,
        content: 'x'.repeat(40000),
        tool_calls: [{ id: 'call-split', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }],
      },
      {
        role: 'tool' as const,
        content: 'file contents',
        tool_call_id: 'call-split',
      },
      ...Array.from({ length: 18 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: 'x'.repeat(20000),
      })),
    ];

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(true);

    // The orphaned tool result should NOT be in the included messages
    const hasOrphan = result.messages.some(
      m => m.role === 'tool' && m.tool_call_id === 'call-split'
    );
    expect(hasOrphan).toBe(false);
  });

  it('should keep complete tool pairs when both sides fit in budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    // Small messages — everything fits
    const messages: Message[] = [
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'tc-1' },
      { role: 'assistant', content: 'Done reading.' },
    ];

    const result = await builder.build(messages, undefined, 'deepseek-chat');

    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toHaveLength(4);
  });

  it('should skip summary injection if summary itself exceeds remaining budget', async () => {
    const counter = new EstimationTokenCounter();
    const builder = new ContextBuilder(counter);

    // Fill enough to overflow budget and trigger truncation
    // 100 messages * 5000 chars * 0.3 ratio = 150k tokens (over 107k budget)
    const messages = makeMessages(100, 5000);
    // Very long summary that won't fit in the remaining space
    const longSummary = 'x'.repeat(500000);
    const snapshot: SnapshotSummary = {
      summary: longSummary,
      tokenCount: counter.countMessage('user', longSummary),
      snapshotId: 'snap-huge',
    };

    const result = await builder.build(messages, undefined, 'deepseek-chat', snapshot);

    // Messages dropped but summary too large to inject
    expect(result.truncated).toBe(true);
    expect(result.summaryInjected).toBe(false);
  });

  // ── Token Cache Tests ──

  it('should use cached token counts for messages with eventId', async () => {
    const counter = createExactCounter(0.3);
    const countMessageSpy = vi.spyOn(counter, 'countMessage');
    const builder = new ContextBuilder(counter);

    const messages: Message[] = [
      { role: 'user', content: 'Hello world', eventId: 'evt-1' },
      { role: 'assistant', content: 'Hi there!', eventId: 'evt-2' },
    ];

    // First build: all messages should be tokenized
    await builder.build(messages, undefined, 'deepseek-chat');
    expect(countMessageSpy).toHaveBeenCalledTimes(2);

    countMessageSpy.mockClear();

    // Second build with same messages: should hit cache
    await builder.build(messages, undefined, 'deepseek-chat');
    expect(countMessageSpy).toHaveBeenCalledTimes(0);
  });

  it('should always recount messages without eventId', async () => {
    const counter = createExactCounter(0.3);
    const countMessageSpy = vi.spyOn(counter, 'countMessage');
    const builder = new ContextBuilder(counter);

    const messages: Message[] = [
      { role: 'user', content: 'No event ID here' },
      { role: 'assistant', content: 'Me neither' },
    ];

    await builder.build(messages, undefined, 'deepseek-chat');
    expect(countMessageSpy).toHaveBeenCalledTimes(2);

    countMessageSpy.mockClear();

    // Second build: no eventId means no cache, so recount
    await builder.build(messages, undefined, 'deepseek-chat');
    expect(countMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('should cache new messages and reuse cached ones on subsequent builds', async () => {
    const counter = createExactCounter(0.3);
    const countMessageSpy = vi.spyOn(counter, 'countMessage');
    const builder = new ContextBuilder(counter);

    const messages1: Message[] = [
      { role: 'user', content: 'First message', eventId: 'evt-1' },
      { role: 'assistant', content: 'First reply', eventId: 'evt-2' },
    ];

    await builder.build(messages1, undefined, 'deepseek-chat');
    expect(countMessageSpy).toHaveBeenCalledTimes(2);

    countMessageSpy.mockClear();

    // Add a new message to the conversation
    const messages2: Message[] = [
      ...messages1,
      { role: 'user', content: 'Second message', eventId: 'evt-3' },
    ];

    await builder.build(messages2, undefined, 'deepseek-chat');
    // Only the new message (evt-3) should be tokenized
    expect(countMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('should produce identical results with and without cache', async () => {
    const counter = createExactCounter(0.3);
    const builder = new ContextBuilder(counter);

    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'y'.repeat(500)}`,
      eventId: `evt-${i}`,
    }));

    const result1 = await builder.build(messages, 'system prompt', 'deepseek-chat');
    const result2 = await builder.build(messages, 'system prompt', 'deepseek-chat');

    expect(result1.tokenCount).toBe(result2.tokenCount);
    expect(result1.droppedCount).toBe(result2.droppedCount);
    expect(result1.messages).toHaveLength(result2.messages.length);
  });

  it('should use pre-computed snapshot token count instead of re-tokenizing', async () => {
    const counter = createExactCounter(0.3);
    const countMessageSpy = vi.spyOn(counter, 'countMessage');
    const builder = new ContextBuilder(counter);

    // Force truncation so snapshot gets injected
    const messages = makeMessages(100, 5000);
    const snapshot: SnapshotSummary = {
      summary: 'Previous context summary here.',
      tokenCount: 42, // Pre-computed — ContextBuilder should use this, not re-tokenize
      snapshotId: 'snap-cached',
    };

    const result = await builder.build(messages, undefined, 'deepseek-chat', snapshot);
    expect(result.summaryInjected).toBe(true);

    // countMessage should NOT have been called for the snapshot summary
    // (only for the 100 conversation messages)
    const summaryCallCount = countMessageSpy.mock.calls
      .filter(([role, content]) => role === 'user' && content === snapshot.summary)
      .length;
    expect(summaryCallCount).toBe(0);
  });
});
