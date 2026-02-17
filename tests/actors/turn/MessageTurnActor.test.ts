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
  function findContainers(type: 'text' | 'thinking' | 'tools' | 'shell' | 'pending' | 'approval'): HTMLElement[] {
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

      // Add some content (startStreaming renders role header = 1 child)
      actor.startStreaming();
      actor.createTextSegment('Hello');
      actor.startThinkingIteration();

      expect(element.children.length).toBe(3); // header + text + thinking

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

    it('startStreaming renders role header immediately', () => {
      expect(element.children.length).toBe(0);
      actor.startStreaming();
      // Role header should be rendered as the first child
      expect(element.children.length).toBe(1);
      const header = element.children[0] as HTMLElement;
      expect(header.classList.contains('header-container')).toBe(true);
      expect(header.classList.contains('assistant')).toBe(true);
    });

    it('startStreaming role header is idempotent with subsequent content', () => {
      actor.startStreaming();
      expect(element.children.length).toBe(1); // header only
      actor.createTextSegment('Hello');
      // Header + text segment (not two headers)
      expect(element.children.length).toBe(2);
      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('text-container')).toBe(true);
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
      expect(element.children.length).toBe(2); // header + text

      actor.finalizeCurrentSegment();
      actor.resumeWithNewSegment();

      expect(element.children.length).toBe(3); // header + text + continuation text

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

    it('shows applied files in manual mode (history restoration)', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(false);
    });

    it('shows container as Modified Files when manual mode has applied files', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts', status: 'applied' });

      const containers = findContainers('pending');
      const title = queryInShadow(containers[0], '.pending-title');
      expect(title?.textContent).toBe('Modified Files');
    });

    it('updates pending status', () => {
      actor.setEditMode('ask');
      const fileId = actor.addPendingFile({ filePath: '/path/to/file.ts' });
      actor.updatePendingStatus(fileId, 'applied');

      const containers = findContainers('pending');
      const item = queryInShadow(containers[0], '.pending-item');
      expect(item?.getAttribute('data-status')).toBe('applied');
    });

    it('updates pending status by diffId fallback', () => {
      actor.setEditMode('ask');
      const fileId = actor.addPendingFile({
        filePath: '/path/to/file.ts',
        diffId: 'diff-123'
      });

      // Use a non-matching fileId but matching diffId — should find via fallback
      actor.updatePendingStatus('wrong-id', 'applied', 'diff-123');

      const containers = findContainers('pending');
      const item = queryInShadow(containers[0], '.pending-item');
      expect(item?.getAttribute('data-status')).toBe('applied');
    });

    it('prefers diffId over filePath in fallback lookup', () => {
      actor.setEditMode('ask');

      // Group 1: rejected file
      actor.addPendingFile({ filePath: '/path/to/file.ts', diffId: 'diff-1', status: 'rejected' });

      // Group 2: same file, new diffId (retry)
      actor.startToolBatch([{ name: 'apply_code_edit', detail: 'file.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: '/path/to/file.ts', diffId: 'diff-2' });

      // Update by diffId targeting group 2 — should NOT match group 1
      actor.updatePendingStatus('wrong-id', 'applied', 'diff-2', '/path/to/file.ts');

      // Group 1 should remain rejected, group 2 should be applied
      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
      const item1 = queryInShadow(containers[0], '.pending-item');
      const item2 = queryInShadow(containers[1], '.pending-item');
      expect(item1?.getAttribute('data-status')).toBe('rejected');
      expect(item2?.getAttribute('data-status')).toBe('applied');
    });

    it('creates separate pending containers per tool batch', () => {
      actor.setEditMode('auto');

      // First tool batch + modified file
      actor.startToolBatch([{ name: 'apply_code_edit', detail: 'file1.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file1.ts', status: 'applied' });

      // Second tool batch + modified file
      actor.startToolBatch([{ name: 'apply_code_edit', detail: 'file2.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file2.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
      // Each should have 1 file
      containers.forEach(c => {
        const items = c.shadowRoot?.querySelectorAll('.pending-item');
        expect(items?.length).toBe(1);
      });
    });

    it('groups consecutive pending files in same container', () => {
      actor.setEditMode('auto');

      actor.startToolBatch([{ name: 'apply_code_edit', detail: 'files' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file1.ts', status: 'applied' });
      actor.addPendingFile({ filePath: 'src/file2.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(1);
      const items = containers[0].shadowRoot?.querySelectorAll('.pending-item');
      expect(items?.length).toBe(2);
    });

    it('creates separate containers with shell segments between pending files', () => {
      actor.setEditMode('auto');

      // R1 flow: code blocks → shell → code blocks
      actor.addPendingFile({ filePath: 'src/a.ts', status: 'applied' });
      actor.createShellSegment([{ command: 'ls' }]);
      actor.addPendingFile({ filePath: 'src/b.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
    });

    it('updates status across multiple pending groups', () => {
      actor.setEditMode('auto');

      actor.startToolBatch([{ name: 'edit', detail: 'f1' }]);
      actor.completeToolBatch();
      const id1 = actor.addPendingFile({ filePath: 'src/f1.ts', status: 'applied' });

      actor.startToolBatch([{ name: 'edit', detail: 'f2' }]);
      actor.completeToolBatch();
      const id2 = actor.addPendingFile({ filePath: 'src/f2.ts', status: 'applied' });

      // Update status of file in second group
      actor.updatePendingStatus(id2, 'rejected');

      const containers = findContainers('pending');
      const item2 = containers[1].shadowRoot?.querySelector('.pending-item');
      expect(item2?.getAttribute('data-status')).toBe('rejected');

      // First group should be unchanged
      const item1 = containers[0].shadowRoot?.querySelector('.pending-item');
      expect(item1?.getAttribute('data-status')).toBe('applied');
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

    it('shows placeholder instead of incomplete code block during streaming', () => {
      actor.startStreaming();
      actor.createTextSegment('Here is the code:');
      actor.updateTextContent('Here is the code:\n```python\ndef hello():');

      const containers = findContainers('text');
      const placeholder = queryInShadow(containers[0], '.code-generating');
      expect(placeholder).toBeTruthy();
      // No code block dropdown should exist
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock).toBeNull();
    });

    it('shows code block dropdown when complete during streaming', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('```python\ndef hello():\n    pass\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock).toBeTruthy();
      // No placeholder — block is complete
      const placeholder = queryInShadow(containers[0], '.code-generating');
      expect(placeholder).toBeNull();
    });

    it('shows no placeholder for incomplete code blocks when not streaming', () => {
      // History restore — not streaming
      actor.createTextSegment('Truncated:\n```python\ndef hello():');

      const containers = findContainers('text');
      const placeholder = queryInShadow(containers[0], '.code-generating');
      expect(placeholder).toBeNull();
    });

    it('placeholder contains cycling phrases', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('```typescript\nconst x');

      const containers = findContainers('text');
      const phrases = containers[0].shadowRoot?.querySelectorAll('.gen-phrase');
      expect(phrases?.length).toBe(3);
    });

    it('placeholder characters have wave animation delays', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('```js\ncode');

      const containers = findContainers('text');
      const chars = containers[0].shadowRoot?.querySelectorAll('.gc');
      expect(chars!.length).toBeGreaterThan(0);
      // Each char should have --d CSS variable for staggered animation
      const firstChar = chars![0] as HTMLElement;
      expect(firstChar.style.getPropertyValue('--d')).toBe('0');
      const secondChar = chars![1] as HTMLElement;
      expect(secondChar.style.getPropertyValue('--d')).toBe('1');
    });

    it('skips DOM update when formatted output unchanged during code streaming', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('Hello\n```python\ndef a():');

      const containers = findContainers('text');
      const contentEl = queryInShadow(containers[0], '.content') as HTMLElement;
      const firstHtml = contentEl.innerHTML;

      // More code tokens arrive but visible output stays the same
      actor.updateTextContent('Hello\n```python\ndef a():\n    pass');
      expect(contentEl.innerHTML).toBe(firstHtml);
    });

    it('finalizeCurrentSegment removes placeholder from finalized segment', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      // Segment has complete block + incomplete block → dropdown + placeholder
      actor.updateTextContent('```python\ndef a():\n    pass\n```\n\n```javascript\nconst x');

      const containers = findContainers('text');
      // Before finalize: placeholder should be present
      expect(queryInShadow(containers[0], '.code-generating')).toBeTruthy();

      // Finalize the segment (simulates interleaving for diffListChanged)
      actor.finalizeCurrentSegment();

      // After finalize: placeholder should be removed, code block dropdown kept
      expect(queryInShadow(containers[0], '.code-generating')).toBeNull();
      expect(queryInShadow(containers[0], '.code-block')).toBeTruthy();
    });

    it('finalized segment does not show raw code from incomplete block', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('Done:\n```python\nprint("hi")\n```\n\n```javascript\nconst x = 1;');

      actor.finalizeCurrentSegment();

      const containers = findContainers('text');
      const contentEl = queryInShadow(containers[0], '.content') as HTMLElement;
      // The raw "const x = 1;" from the incomplete block should not appear
      expect(contentEl.textContent).not.toContain('const x = 1;');
      // The complete python block should still be a dropdown
      expect(queryInShadow(containers[0], '.code-block')).toBeTruthy();
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

  // ============================================
  // Command Approval Tests
  // ============================================

  describe('Command approval', () => {
    let approvalCallback: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      approvalCallback = vi.fn();
      actor = new MessageTurnActor({
        manager,
        element,
        onCommandApprovalAction: approvalCallback,
      });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates approval container with shadow DOM', () => {
      actor.createCommandApproval('npm install', 'npm');

      const containers = findContainers('approval');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('returns a unique approval ID', () => {
      const id1 = actor.createCommandApproval('npm install', 'npm');
      const id2 = actor.createCommandApproval('git push', 'git');

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('renders pending state with command and buttons', () => {
      const approvalId = actor.createCommandApproval('npm install express', 'npm');

      const containers = findContainers('approval');
      const header = queryInShadow(containers[0], '.approval-header');
      expect(header?.textContent).toContain('Command approval required');

      const command = queryInShadow(containers[0], '.approval-command code');
      expect(command?.textContent).toContain('npm install express');

      const buttons = containers[0].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length).toBe(4);
    });

    it('renders four buttons with correct labels', () => {
      actor.createCommandApproval('npm test', 'npm');

      const containers = findContainers('approval');
      const buttons = Array.from(containers[0].shadowRoot?.querySelectorAll('.approval-btn') ?? []);
      const labels = buttons.map(b => b.textContent?.trim());

      expect(labels).toContain('Allow Once');
      expect(labels).toContain('Block Once');
      expect(labels.some(l => l?.includes('Always Allow'))).toBe(true);
      expect(labels.some(l => l?.includes('Always Block'))).toBe(true);
    });

    it('always allow/block buttons include prefix', () => {
      actor.createCommandApproval('npm run build', 'npm');

      const containers = findContainers('approval');
      const alwaysAllow = queryInShadow(containers[0], '.always-allow');
      const alwaysBlock = queryInShadow(containers[0], '.always-block');

      expect(alwaysAllow?.textContent).toContain('"npm"');
      expect(alwaysBlock?.textContent).toContain('"npm"');
    });

    it('resolveCommandApproval updates to allowed state', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm');
      actor.resolveCommandApproval(approvalId, 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[0].classList.contains('allowed')).toBe(true);

      const header = queryInShadow(containers[0], '.approval-header.resolved');
      expect(header?.textContent).toContain('Allowed');
      expect(header?.textContent).toContain('npm test');
    });

    it('resolveCommandApproval updates to blocked state', () => {
      const approvalId = actor.createCommandApproval('rm -rf /', 'rm');
      actor.resolveCommandApproval(approvalId, 'blocked');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[0].classList.contains('blocked')).toBe(true);

      const header = queryInShadow(containers[0], '.approval-header.resolved');
      expect(header?.textContent).toContain('Blocked');
    });

    it('resolved state removes action buttons', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm');
      actor.resolveCommandApproval(approvalId, 'allowed');

      const containers = findContainers('approval');
      const buttons = containers[0].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length ?? 0).toBe(0);
    });

    it('clicking allow once calls callback with correct args', () => {
      actor.createCommandApproval('npm test', 'npm');

      const containers = findContainers('approval');
      const allowOnce = queryInShadow(containers[0], '.allow-once') as HTMLButtonElement;
      allowOnce?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'allowed', false, 'npm');
    });

    it('clicking always allow calls callback with persistent=true', () => {
      actor.createCommandApproval('npm test', 'npm');

      const containers = findContainers('approval');
      const alwaysAllow = queryInShadow(containers[0], '.always-allow') as HTMLButtonElement;
      alwaysAllow?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'allowed', true, 'npm');
    });

    it('clicking block once calls callback with blocked decision', () => {
      actor.createCommandApproval('npm test', 'npm');

      const containers = findContainers('approval');
      const blockOnce = queryInShadow(containers[0], '.block-once') as HTMLButtonElement;
      blockOnce?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'blocked', false, 'npm');
    });

    it('clicking always block calls callback with persistent=true', () => {
      actor.createCommandApproval('npm test', 'npm');

      const containers = findContainers('approval');
      const alwaysBlock = queryInShadow(containers[0], '.always-block') as HTMLButtonElement;
      alwaysBlock?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'blocked', true, 'npm');
    });

    it('does not fire callback when approval already resolved', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm');
      actor.resolveCommandApproval(approvalId, 'allowed');

      // Buttons are gone after resolve, but even if somehow triggered, guard should prevent callback
      expect(approvalCallback).not.toHaveBeenCalled();
    });

    it('multiple approvals render independently', () => {
      actor.createCommandApproval('npm install', 'npm');
      actor.createCommandApproval('git push', 'git');

      const containers = findContainers('approval');
      expect(containers.length).toBe(2);
    });

    it('resolving one approval does not affect another', () => {
      const id1 = actor.createCommandApproval('npm install', 'npm');
      const id2 = actor.createCommandApproval('git push', 'git');

      actor.resolveCommandApproval(id1, 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[1].classList.contains('resolved')).toBe(false);

      // Second still has buttons
      const buttons = containers[1].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length).toBe(4);
    });

    it('breaks pending group chain when approval is created', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });
      actor.createCommandApproval('npm test', 'npm');
      actor.addPendingFile({ filePath: '/path/to/other.ts' });

      // Should have 2 pending containers (not grouped) + 1 approval
      const pendingContainers = findContainers('pending');
      const approvalContainers = findContainers('approval');
      expect(pendingContainers.length).toBe(2);
      expect(approvalContainers.length).toBe(1);
    });

    it('reset clears all command approval state', () => {
      actor.createCommandApproval('npm test', 'npm');
      actor.createCommandApproval('git push', 'git');

      expect(findContainers('approval').length).toBe(2);

      actor.reset();

      expect(findContainers('approval').length).toBe(0);
    });

    it('resolveCommandApproval is a no-op for unknown ID', () => {
      actor.createCommandApproval('npm test', 'npm');
      // Should not throw
      actor.resolveCommandApproval('nonexistent-id', 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(false);
    });

    it('escapes HTML in command text', () => {
      actor.createCommandApproval('echo "<script>alert(1)</script>"', 'echo');

      const containers = findContainers('approval');
      const code = queryInShadow(containers[0], '.approval-command code');
      // Should not contain raw <script> tag
      expect(code?.innerHTML).not.toContain('<script>');
      expect(code?.textContent).toContain('<script>');
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

      // Verify structure: header -> text -> thinking -> tools -> text (continuation)
      expect(element.children.length).toBe(5);

      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('text-container')).toBe(true);
      expect(children[2].classList.contains('thinking-container')).toBe(true);
      expect(children[3].classList.contains('tools-container')).toBe(true);
      expect(children[4].classList.contains('text-container')).toBe(true);
      expect(children[4].classList.contains('continuation')).toBe(true);
    });

    it('handles turn with command approval interleaved', () => {
      const cb = vi.fn();
      actor = new MessageTurnActor({ manager, element, onCommandApprovalAction: cb });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();

      // Text → tool calls → approval → text continuation
      actor.createTextSegment('Running tests...');
      actor.finalizeCurrentSegment();
      actor.startToolBatch([{ name: 'run_command', detail: 'npm test' }]);
      actor.completeToolBatch();
      const approvalId = actor.createCommandApproval('npm test', 'npm');
      actor.resolveCommandApproval(approvalId, 'allowed');
      actor.resumeWithNewSegment();
      actor.updateTextContent('Tests passed!');
      actor.endStreaming();

      // header + text + tools + approval + text(continuation)
      expect(element.children.length).toBe(5);
      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('text-container')).toBe(true);
      expect(children[2].classList.contains('tools-container')).toBe(true);
      expect(children[3].classList.contains('approval-container')).toBe(true);
      expect(children[3].classList.contains('resolved')).toBe(true);
      expect(children[4].classList.contains('text-container')).toBe(true);
      expect(children[4].classList.contains('continuation')).toBe(true);
    });
  });
});
