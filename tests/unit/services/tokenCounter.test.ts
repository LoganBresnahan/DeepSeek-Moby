import { describe, it, expect } from 'vitest';
import { EstimationTokenCounter, countRequestTokens } from '../../../src/services/tokenCounter';

describe('EstimationTokenCounter', () => {
  it('should implement TokenCounter interface', () => {
    const counter = new EstimationTokenCounter();
    expect(counter.isExact).toBe(false);
    expect(typeof counter.count).toBe('function');
    expect(typeof counter.countMessage).toBe('function');
  });

  it('should estimate tokens using default 0.3 ratio', () => {
    const counter = new EstimationTokenCounter();
    // 10 chars * 0.3 = 3 tokens
    expect(counter.count('0123456789')).toBe(3);
    // 1 char * 0.3 = 0.3 -> ceil = 1
    expect(counter.count('a')).toBe(1);
    // empty string = 0
    expect(counter.count('')).toBe(0);
  });

  it('should add message overhead for regular roles', () => {
    const counter = new EstimationTokenCounter();
    const contentTokens = counter.count('Hello world');
    const messageTokens = counter.countMessage('user', 'Hello world');
    // MESSAGE_OVERHEAD_TOKENS = 4
    expect(messageTokens).toBe(contentTokens + 4);
  });

  it('should add system overhead for system role', () => {
    const counter = new EstimationTokenCounter();
    const contentTokens = counter.count('You are helpful');
    const messageTokens = counter.countMessage('system', 'You are helpful');
    // SYSTEM_OVERHEAD_TOKENS = 8
    expect(messageTokens).toBe(contentTokens + 8);
  });

  it('should calibrate ratio from API usage data', () => {
    const counter = new EstimationTokenCounter();
    // Initial ratio is 0.3
    expect(counter.ratio).toBe(0.3);

    // If 100 chars produced 50 tokens, ratio = 0.5
    counter.calibrate(100, 50);
    expect(counter.ratio).toBe(0.5);
    expect(counter.sampleCount).toBe(1);

    // Add another sample: 200 chars, 40 tokens -> ratio = 0.2
    // Average of 0.5 and 0.2 = 0.35
    counter.calibrate(200, 40);
    expect(counter.ratio).toBeCloseTo(0.35);
    expect(counter.sampleCount).toBe(2);
  });

  it('should use rolling average for calibration', () => {
    const counter = new EstimationTokenCounter();

    // Fill with 20 samples of ratio 0.4
    for (let i = 0; i < 20; i++) {
      counter.calibrate(100, 40);
    }
    expect(counter.ratio).toBeCloseTo(0.4);
    expect(counter.sampleCount).toBe(20);

    // Add one more sample — oldest should be evicted (MAX_SAMPLES = 20)
    counter.calibrate(100, 40);
    expect(counter.sampleCount).toBe(20);
  });

  it('should ignore zero-length calibration inputs', () => {
    const counter = new EstimationTokenCounter();
    counter.calibrate(0, 50);
    expect(counter.sampleCount).toBe(0);
    expect(counter.ratio).toBe(0.3); // unchanged

    counter.calibrate(100, 0);
    expect(counter.sampleCount).toBe(0);
    expect(counter.ratio).toBe(0.3); // unchanged
  });

  it('should converge to accurate ratio after calibration', () => {
    const counter = new EstimationTokenCounter();

    // Simulate 10 API responses with consistent ratio of 0.28
    for (let i = 0; i < 10; i++) {
      counter.calibrate(1000, 280);
    }

    // count() should now use the calibrated ratio (~0.28)
    const tokens = counter.count('a'.repeat(1000));
    // ceil(1000 * 0.28) — allow for floating point
    expect(tokens).toBeGreaterThanOrEqual(280);
    expect(tokens).toBeLessThanOrEqual(281);
  });

  it('should adapt when ratio changes (model update)', () => {
    const counter = new EstimationTokenCounter();

    // Start with ratio 0.3 calibration
    for (let i = 0; i < 10; i++) {
      counter.calibrate(100, 30);
    }
    expect(counter.ratio).toBeCloseTo(0.3);

    // Simulate model change to ratio 0.25
    for (let i = 0; i < 20; i++) {
      counter.calibrate(100, 25);
    }
    // After 20 samples (MAX), old samples are fully evicted
    expect(counter.ratio).toBeCloseTo(0.25);
  });
});

describe('countRequestTokens', () => {
  it('should match countMessage sum for plain messages', () => {
    const counter = new EstimationTokenCounter();
    const messages = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there' },
    ];

    const total = countRequestTokens(counter, messages);
    const expected =
      counter.countMessage('user', 'Hello world') +
      counter.countMessage('assistant', 'Hi there');

    expect(total).toBe(expected);
  });

  it('should count system prompt tokens', () => {
    const counter = new EstimationTokenCounter();
    const messages = [{ role: 'user', content: 'Hello' }];

    const withSystem = countRequestTokens(counter, messages, 'You are helpful');
    const withoutSystem = countRequestTokens(counter, messages);

    expect(withSystem).toBeGreaterThan(withoutSystem);
    expect(withSystem - withoutSystem).toBe(counter.countMessage('system', 'You are helpful'));
  });

  it('should count tool_calls metadata on assistant messages', () => {
    const counter = new EstimationTokenCounter();
    const messagesWithTools = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_abc123',
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
        }],
      },
    ];
    const messagesWithout = [
      { role: 'assistant', content: '' },
    ];

    const withTools = countRequestTokens(counter, messagesWithTools);
    const withoutTools = countRequestTokens(counter, messagesWithout);

    // Should include tokens for function name, arguments, and overhead
    expect(withTools).toBeGreaterThan(withoutTools);
    const extra = withTools - withoutTools;
    expect(extra).toBeGreaterThanOrEqual(
      counter.count('read_file') + counter.count('{"path":"src/index.ts"}') + 8
    );
  });

  it('should count tool_call_id on tool result messages', () => {
    const counter = new EstimationTokenCounter();
    const messagesWithId = [
      { role: 'tool', content: 'file contents here', tool_call_id: 'call_abc123' },
    ];
    const messagesWithout = [
      { role: 'tool', content: 'file contents here' },
    ];

    const withId = countRequestTokens(counter, messagesWithId);
    const withoutId = countRequestTokens(counter, messagesWithout);

    expect(withId).toBeGreaterThan(withoutId);
    expect(withId - withoutId).toBe(counter.count('call_abc123'));
  });

  it('should count tool definitions', () => {
    const counter = new EstimationTokenCounter();
    const messages = [{ role: 'user', content: 'Read my file' }];
    const tools = [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'File path' } },
          required: ['path'],
        },
      },
    }];

    const withTools = countRequestTokens(counter, messages, undefined, tools);
    const withoutTools = countRequestTokens(counter, messages);

    expect(withTools).toBeGreaterThan(withoutTools);
    expect(withTools - withoutTools).toBe(counter.count(JSON.stringify(tools)));
  });

  it('should count everything together', () => {
    const counter = new EstimationTokenCounter();
    const messages = [
      { role: 'user', content: 'Read my code' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' },
        }],
      },
      { role: 'tool', content: 'export function main() {}', tool_call_id: 'call_1' },
    ];
    const tools = [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {}, required: [] as string[] },
      },
    }];

    const total = countRequestTokens(counter, messages, 'You are helpful', tools);

    // Should be greater than just summing content
    const contentOnly =
      counter.countMessage('system', 'You are helpful') +
      counter.countMessage('user', 'Read my code') +
      counter.countMessage('assistant', '') +
      counter.countMessage('tool', 'export function main() {}');

    expect(total).toBeGreaterThan(contentOnly);
  });

  it('should handle multipart content (image_url)', () => {
    const counter = new EstimationTokenCounter();
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url' },
      ],
    }];

    const total = countRequestTokens(counter, messages);
    // Should count the text part + [image] placeholder
    expect(total).toBe(counter.countMessage('user', 'What is this?[image]'));
  });
});
