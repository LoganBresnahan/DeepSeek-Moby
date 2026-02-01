/**
 * Tool Calls Flow Integration Tests
 *
 * Tests the tool calls lifecycle from toolCallsStart through
 * toolCallUpdate to toolCallsEnd.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  simulateToolCalls,
  type TestActorSystem
} from './helpers';

describe('Tool Calls Flow Integration', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('basic tool calls flow', () => {
    it('starts tool batch with initial tools', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [
          { name: 'read_file', detail: 'package.json' },
          { name: 'write_file', detail: 'output.txt' }
        ]
      });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls.length).toBe(2);
      expect(calls[0].name).toBe('read_file');
      expect(calls[0].detail).toBe('package.json');
      expect(calls[1].name).toBe('write_file');
    });

    it('updates individual tool status', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [
          { name: 'tool1', detail: 'd1' },
          { name: 'tool2', detail: 'd2' }
        ]
      });
      await waitForPubSub();

      // After startBatch, all tools are 'running' by default
      expect(system.toolCalls.getCalls()[0].status).toBe('running');
      expect(system.toolCalls.getCalls()[1].status).toBe('running');

      // Update first tool to 'done'
      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'done'
      });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls[0].status).toBe('done');
      expect(calls[1].status).toBe('running'); // Still running
    });

    it('completes tool calls batch', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'tool', detail: 'd' }]
      });
      await waitForPubSub();

      const completeSpy = vi.spyOn(system.toolCalls, 'complete');

      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      expect(completeSpy).toHaveBeenCalled();
    });
  });

  describe('full tool lifecycle', () => {
    it('progresses tool through all statuses', async () => {
      // Start
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'process', detail: 'data' }]
      });
      await waitForPubSub();

      // Pending → Running
      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'running'
      });
      await waitForPubSub();
      expect(system.toolCalls.getCalls()[0].status).toBe('running');

      // Running → Done
      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'done'
      });
      await waitForPubSub();
      expect(system.toolCalls.getCalls()[0].status).toBe('done');

      // Complete batch
      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();
    });

    it('handles tool error status', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'failing_tool', detail: 'will fail' }]
      });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'error'
      });
      await waitForPubSub();

      expect(system.toolCalls.getCalls()[0].status).toBe('error');
    });
  });

  describe('multiple tools', () => {
    it('updates multiple tools independently', async () => {
      await simulateToolCalls(
        system,
        [
          { name: 'tool1', detail: 'd1' },
          { name: 'tool2', detail: 'd2' },
          { name: 'tool3', detail: 'd3' }
        ],
        ['done', 'error', 'done']
      );

      // After toolCallsEnd, the batch is complete and moved to getBatches()
      // getCalls() returns empty since there's no active batch
      const batches = system.toolCalls.getBatches();
      expect(batches.length).toBe(1);
      const calls = batches[0].calls;
      expect(calls[0].status).toBe('done');
      expect(calls[1].status).toBe('error');
      expect(calls[2].status).toBe('done');
    });

    it('preserves tool order', async () => {
      const tools = [
        { name: 'alpha', detail: 'a' },
        { name: 'beta', detail: 'b' },
        { name: 'gamma', detail: 'c' }
      ];

      system.dispatchMessage({ type: 'toolCallsStart', tools });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls[0].name).toBe('alpha');
      expect(calls[1].name).toBe('beta');
      expect(calls[2].name).toBe('gamma');
    });
  });

  describe('batch update message', () => {
    it('updates all tools at once', async () => {
      // First start a batch
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [
          { name: 'tool1', detail: 'd1' },
          { name: 'tool2', detail: 'd2' },
          { name: 'tool3', detail: 'd3' }
        ]
      });
      await waitForPubSub();

      // Then update the batch with statuses
      system.dispatchMessage({
        type: 'toolCallsUpdate',
        tools: [
          { name: 'tool1', detail: 'd1', status: 'done' },
          { name: 'tool2', detail: 'd2', status: 'running' },
          { name: 'tool3', detail: 'd3', status: 'error' }
        ]
      });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls.length).toBe(3);
      expect(calls[0].status).toBe('done');
      expect(calls[1].status).toBe('running');
      expect(calls[2].status).toBe('error');
    });

    it('replaces existing tools', async () => {
      // Start with initial tools
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'old', detail: 'old' }]
      });
      await waitForPubSub();

      // Batch update replaces
      system.dispatchMessage({
        type: 'toolCallsUpdate',
        tools: [
          { name: 'new1', detail: 'new1', status: 'done' },
          { name: 'new2', detail: 'new2' }
        ]
      });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls.length).toBe(2);
      expect(calls[0].name).toBe('new1');
    });
  });

  describe('edge cases', () => {
    it('handles update for invalid index gracefully', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'tool', detail: 'd' }]
      });
      await waitForPubSub();

      // After startBatch, status is 'running'
      expect(system.toolCalls.getCalls()[0].status).toBe('running');

      // Try to update index that doesn't exist
      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 99,
        status: 'done'
      });
      await waitForPubSub();

      // Original tool should be unchanged (still 'running')
      const calls = system.toolCalls.getCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].status).toBe('running');
    });

    it('handles update without prior start', async () => {
      const updateSpy = vi.spyOn(system.toolCalls, 'updateBatch');

      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'running'
      });
      await waitForPubSub();

      // Should not crash, but updateBatch won't be called
      // because getCalls() returns empty array
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('handles empty tools array', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: []
      });
      await waitForPubSub();

      expect(system.toolCalls.getCalls().length).toBe(0);
    });

    it('handles missing tools field', async () => {
      const startSpy = vi.spyOn(system.toolCalls, 'startBatch');

      system.dispatchMessage({ type: 'toolCallsStart' });
      await waitForPubSub();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe('state management', () => {
    it('tracks active count', async () => {
      // Initially no active tools
      expect(system.toolCalls.getState().activeCount).toBe(0);

      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'tool', detail: 'd' }]
      });
      await waitForPubSub();

      // After start, tools are 'running' so activeCount > 0
      expect(system.toolCalls.getState().activeCount).toBe(1);

      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      // After complete, all tools are 'done' so activeCount = 0
      expect(system.toolCalls.getState().activeCount).toBe(0);
    });

    it('clears tools on new batch', async () => {
      // First batch
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'first', detail: 'd' }]
      });
      await waitForPubSub();
      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      // Second batch
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'second', detail: 'd' }]
      });
      await waitForPubSub();

      const calls = system.toolCalls.getCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].name).toBe('second');
    });
  });

  describe('DOM rendering', () => {
    it('renders tool calls dropdown in chat messages', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'test.txt' }]
      });
      await waitForPubSub();

      // ToolCallsActor renders with class 'tools-container'
      const toolsElement = system.elements.chatMessages.querySelector(
        '.tools-container'
      );
      expect(toolsElement).toBeTruthy();
    });

    it('shows tool name in DOM', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'execute_command', detail: 'npm test' }]
      });
      await waitForPubSub();

      const text = system.elements.chatMessages.textContent;
      expect(text).toContain('execute_command');
    });

    it('shows tool detail in DOM', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'tool', detail: 'specific detail text' }]
      });
      await waitForPubSub();

      const text = system.elements.chatMessages.textContent;
      expect(text).toContain('specific detail text');
    });
  });

  describe('integration with streaming', () => {
    it('tool calls work during streaming', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Tool calls during stream
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'mid_stream_tool', detail: 'd' }]
      });
      await waitForPubSub();

      expect(system.toolCalls.getCalls().length).toBe(1);
      expect(system.streaming.isActive).toBe(true);
    });
  });
});
