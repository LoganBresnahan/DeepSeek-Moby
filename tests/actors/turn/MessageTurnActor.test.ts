/**
 * Tests for MessageTurnActor
 *
 * Tests the 1B architecture: one actor per turn with multiple shadow containers.
 * Validates pooling lifecycle, content rendering, and interleaving behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageTurnActor } from '../../../media/actors/turn/MessageTurnActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('MessageTurnActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageTurnActor;

  /**
   * Helper to find containers by type.
   */
  function findContainers(type: 'text' | 'thinking' | 'tools' | 'shell' | 'pending'): HTMLElement[] {
    return Array.from(element.querySelectorAll(`[data-actor="turn"].${type}-container`));
  }

  /**
   * Helper to query inside a container's shadow DOM.
   */
  function queryInShadow(container: HTMLElement, selector: string): Element | null {
    return container.shadowRoot?.querySelector(selector) ?? null;
  }

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-turn';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  // ============================================
  // Pool Lifecycle Tests
  // ============================================

  describe('Pool lifecycle', () => {
    it('marks parent with data-interleaved-actor attribute', () => {
      actor = new MessageTurnActor({ manager, element });
      expect(element.getAttribute('data-interleaved-actor')).toBe('turn');
    });

    it('creates no containers initially', () => {
      actor = new MessageTurnActor({ manager, element });
      expect(element.children.length).toBe(0);
    });

    it('bind sets turn identity', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({
        turnId: 'turn-123',
        role: 'assistant',
        timestamp: Date.now()
      });

      expect(actor.turnId).toBe('turn-123');
      expect(actor.role).toBe('assistant');
      expect(actor.isAssistant).toBe(true);
      expect(actor.isUser).toBe(false);
      expect(element.getAttribute('data-turn-id')).toBe('turn-123');
      expect(element.getAttribute('data-role')).toBe('assistant');
    });

    it('reset clears all state', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({
        turnId: 'turn-123',
        role: 'assistant',
        timestamp: Date.now()
      });

      // Add some content
      actor.startStreaming();
      actor.createTextSegment('Hello');
      actor.startThinkingIteration();

      expect(element.children.length).toBe(2);

      // Reset
      actor.reset();

      expect(actor.turnId).toBeNull();
      expect(actor.role).toBeNull();
      expect(element.children.length).toBe(0);
      expect(element.hasAttribute('data-turn-id')).toBe(false);
    });

    it('can be rebound after reset', () => {
      actor = new MessageTurnActor({ manager, element });

      // First binding
      actor.bind({ turnId: 'turn-1', role: 'user', timestamp: Date.now() });
      actor.createTextSegment('First message');

      // Reset and rebind
      actor.reset();
      actor.bind({ turnId: 'turn-2', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('Second message');

      expect(actor.turnId).toBe('turn-2');
      expect(actor.role).toBe('assistant');
      expect(element.children.length).toBe(1);
    });
  });

  // ============================================
  // Text Segment Tests
  // ============================================

  describe('Text segments', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'user', timestamp: Date.now() });
    });

    it('creates text segment with shadow DOM', () => {
      actor.createTextSegment('Hello world');

      const containers = findContainers('text');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('renders user message correctly', () => {
      actor.createTextSegment('Hello world');

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Hello world');

      const divider = queryInShadow(containers[0], '.message-divider-label');
      expect(divider?.textContent).toBe('YOU');
    });

    it('renders assistant message correctly', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-2', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('Hello from AI');

      const containers = findContainers('text');
      const divider = queryInShadow(containers[0], '.message-divider-label');
      expect(divider?.textContent).toBe('DEEPSEEK MOBY');
    });

    it('updates text content', () => {
      actor.createTextSegment('Initial');
      actor.updateTextContent('Updated content');

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Updated content');
      expect(actor.getCurrentSegmentContent()).toBe('Updated content');
    });

    it('lazy creates segment on updateTextContent', () => {
      expect(element.children.length).toBe(0);

      actor.updateTextContent('Lazy created');

      const containers = findContainers('text');
      expect(containers.length).toBe(1);
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Lazy created');
    });
  });

  // ============================================
  // Streaming Tests
  // ============================================

  describe('Streaming', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('startStreaming sets streaming state', () => {
      actor.startStreaming();
      expect(actor.isStreaming()).toBe(true);
    });

    it('endStreaming clears streaming state', () => {
      actor.startStreaming();
      actor.endStreaming();
      expect(actor.isStreaming()).toBe(false);
    });

    it('streaming segment has streaming class', () => {
      actor.startStreaming();
      actor.createTextSegment('Streaming...');

      const containers = findContainers('text');
      expect(containers[0].classList.contains('streaming')).toBe(true);
    });

    it('removes streaming class on endStreaming', () => {
      actor.startStreaming();
      actor.createTextSegment('Content');
      actor.endStreaming();

      const containers = findContainers('text');
      expect(containers[0].classList.contains('streaming')).toBe(false);
    });
  });

  // ============================================
  // Interleaving Tests
  // ============================================

  describe('Interleaving', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('finalizeCurrentSegment returns false when no segment exists', () => {
      const result = actor.finalizeCurrentSegment();
      expect(result).toBe(false);
      expect(actor.needsNewSegment()).toBe(false);
    });

    it('finalizeCurrentSegment returns true when segment exists', () => {
      actor.createTextSegment('Content');

      const result = actor.finalizeCurrentSegment();
      expect(result).toBe(true);
      expect(actor.needsNewSegment()).toBe(true);
    });

    it('finalizeCurrentSegment sets hasInterleaved', () => {
      actor.createTextSegment('Content');
      expect(actor.hasInterleaved()).toBe(false);

      actor.finalizeCurrentSegment();
      expect(actor.hasInterleaved()).toBe(true);
    });

    it('resumeWithNewSegment creates continuation segment', () => {
      actor.createTextSegment('First segment');
      expect(element.children.length).toBe(1);

      actor.finalizeCurrentSegment();
      actor.resumeWithNewSegment();

      expect(element.children.length).toBe(2);

      const containers = findContainers('text');
      expect(containers[1].classList.contains('continuation')).toBe(true);
    });

    it('continuation segment hides divider', () => {
      actor.createTextSegment('First');
      actor.finalizeCurrentSegment();
      actor.resumeWithNewSegment();
      actor.updateTextContent('Second');

      const containers = findContainers('text');
      const divider = queryInShadow(containers[1], '.message-divider');
      // Continuation should either not have divider or have it hidden via CSS
      expect(divider === null || getComputedStyle(divider).display === 'none').toBe(true);
    });
  });

  // ============================================
  // Thinking Tests
  // ============================================

  describe('Thinking iterations', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates thinking container with shadow DOM', () => {
      actor.startThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('returns iteration index', () => {
      const idx1 = actor.startThinkingIteration();
      const idx2 = actor.startThinkingIteration();

      expect(idx1).toBe(1);
      expect(idx2).toBe(2);
    });

    it('updates thinking content', () => {
      actor.startThinkingIteration();
      actor.updateThinkingContent('Thinking deeply...');

      const containers = findContainers('thinking');
      const body = queryInShadow(containers[0], '.thinking-body');
      expect(body?.textContent).toContain('Thinking deeply...');
    });

    it('completes thinking iteration', () => {
      actor.startThinkingIteration();
      actor.completeThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers[0].classList.contains('streaming')).toBe(false);
    });

    it('toggle expands/collapses thinking', () => {
      actor.startThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers[0].classList.contains('expanded')).toBe(false);

      actor.toggleThinkingExpanded(1);
      expect(containers[0].classList.contains('expanded')).toBe(true);

      actor.toggleThinkingExpanded(1);
      expect(containers[0].classList.contains('expanded')).toBe(false);
    });
  });

  // ============================================
  // Tool Calls Tests
  // ============================================

  describe('Tool calls', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates tool batch container', () => {
      actor.startToolBatch([
        { name: 'read_file', detail: 'file.ts' },
        { name: 'write_file', detail: 'output.ts' }
      ]);

      const containers = findContainers('tools');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('renders tool items', () => {
      actor.startToolBatch([
        { name: 'read_file', detail: 'file.ts' }
      ]);

      const containers = findContainers('tools');
      const items = containers[0].shadowRoot?.querySelectorAll('.tool-item');
      expect(items?.length).toBe(1);
    });

    it('updates tool status', () => {
      actor.startToolBatch([{ name: 'test_tool', detail: 'test' }]);
      actor.updateTool(0, 'done');

      const containers = findContainers('tools');
      const item = queryInShadow(containers[0], '.tool-item');
      expect(item?.getAttribute('data-status')).toBe('done');
    });

    it('completes tool batch', () => {
      actor.startToolBatch([{ name: 'test', detail: '' }]);
      actor.completeToolBatch();

      const containers = findContainers('tools');
      expect(containers[0].classList.contains('complete')).toBe(true);
    });
  });

  // ============================================
  // Shell Tests
  // ============================================

  describe('Shell segments', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates shell container', () => {
      actor.createShellSegment([{ command: 'ls -la' }]);

      const containers = findContainers('shell');
      expect(containers.length).toBe(1);
    });

    it('starts shell segment (marks as running)', () => {
      const segmentId = actor.createShellSegment([{ command: 'npm test' }]);
      actor.startShellSegment(segmentId);

      const containers = findContainers('shell');
      const item = queryInShadow(containers[0], '.shell-item');
      expect(item?.getAttribute('data-status')).toBe('running');
    });

    it('sets shell results', () => {
      const segmentId = actor.createShellSegment([{ command: 'echo hello' }]);
      actor.startShellSegment(segmentId);
      actor.setShellResults(segmentId, [{ output: 'hello', success: true }]);

      const containers = findContainers('shell');
      expect(containers[0].classList.contains('complete')).toBe(true);

      const output = queryInShadow(containers[0], '.shell-output');
      expect(output?.textContent).toContain('hello');
    });
  });

  // ============================================
  // Pending Files Tests
  // ============================================

  describe('Pending files', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('creates pending container when file added', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(1);
    });

    it('hides container in manual mode', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(true);
    });

    it('shows container in ask mode', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(false);
    });

    it('updates pending status', () => {
      actor.setEditMode('ask');
      const fileId = actor.addPendingFile({ filePath: '/path/to/file.ts' });
      actor.updatePendingStatus(fileId, 'applied');

      const containers = findContainers('pending');
      const item = queryInShadow(containers[0], '.pending-item');
      expect(item?.getAttribute('data-status')).toBe('applied');
    });
  });

  // ============================================
  // Code Block Tests
  // ============================================

  describe('Code blocks', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('renders fenced code blocks', () => {
      actor.createTextSegment('```typescript\nconst x = 1;\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock).toBeTruthy();
    });

    it('shows language label', () => {
      actor.createTextSegment('```javascript\nlet y = 2;\n```');

      const containers = findContainers('text');
      const lang = queryInShadow(containers[0], '.code-lang');
      expect(lang?.textContent).toBe('javascript');
    });

    it('starts expanded in manual mode', () => {
      actor.setEditMode('manual');
      actor.createTextSegment('```typescript\ncode\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock?.classList.contains('expanded')).toBe(true);
    });

    it('starts collapsed in ask/auto mode', () => {
      actor.setEditMode('ask');
      actor.createTextSegment('```typescript\ncode\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock?.classList.contains('expanded')).toBe(false);
    });
  });

  // ============================================
  // State Publication Tests
  // ============================================

  describe('Publications', () => {
    it('publishes turn state', async () => {
      actor = new MessageTurnActor({ manager, element });

      // Wait for registration
      await Promise.resolve();

      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      expect(manager.getState('turn.id')).toBe('turn-1');
      expect(manager.getState('turn.role')).toBe('assistant');
    });

    it('publishes streaming state changes', async () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      await Promise.resolve();

      actor.startStreaming();
      expect(manager.getState('turn.streaming')).toBe(true);

      actor.endStreaming();
      expect(manager.getState('turn.streaming')).toBe(false);
    });
  });

  // ============================================
  // Integration Tests
  // ============================================

  describe('Full turn flow', () => {
    it('handles complete assistant turn with interleaving', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      // Start streaming
      actor.startStreaming();

      // First text segment
      actor.createTextSegment('Let me help you with that.');

      // Thinking interrupts
      actor.finalizeCurrentSegment();
      actor.startThinkingIteration();
      actor.updateThinkingContent('Analyzing the problem...');

      // Tool call interrupts
      actor.startToolBatch([{ name: 'read_file', detail: 'src/main.ts' }]);
      actor.updateTool(0, 'done');
      actor.completeToolBatch();

      // Resume text
      actor.resumeWithNewSegment();
      actor.updateTextContent('Based on the file, here is the solution.');

      // End streaming
      actor.endStreaming();

      // Verify structure: text -> thinking -> tools -> text (continuation)
      expect(element.children.length).toBe(4);

      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('text-container')).toBe(true);
      expect(children[1].classList.contains('thinking-container')).toBe(true);
      expect(children[2].classList.contains('tools-container')).toBe(true);
      expect(children[3].classList.contains('text-container')).toBe(true);
      expect(children[3].classList.contains('continuation')).toBe(true);
    });
  });
});
