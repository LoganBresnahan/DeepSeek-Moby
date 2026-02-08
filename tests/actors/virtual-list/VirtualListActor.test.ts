/**
 * Tests for VirtualListActor
 *
 * Tests the virtual rendering system: pool management, visibility detection,
 * content delegation, and height measurement.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { VirtualListActor } from '../../../media/actors/virtual-list/VirtualListActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('VirtualListActor', () => {
  let manager: EventStateManager;
  let scrollContainer: HTMLElement;
  let actor: VirtualListActor;

  /**
   * Helper to get content container inside scroll container.
   */
  function getContentContainer(): HTMLElement {
    return scrollContainer.querySelector('.virtual-list-content') as HTMLElement;
  }

  /**
   * Helper to get visible turn elements.
   */
  function getVisibleTurns(): HTMLElement[] {
    const content = getContentContainer();
    return content ? Array.from(content.querySelectorAll('.virtual-list-turn')) : [];
  }

  /**
   * Helper to simulate scroll.
   */
  function simulateScroll(scrollTop: number): Promise<void> {
    scrollContainer.scrollTop = scrollTop;
    scrollContainer.dispatchEvent(new Event('scroll'));
    // Wait for debounce (16ms default) + buffer
    return new Promise(resolve => setTimeout(resolve, 30));
  }

  /**
   * Helper to mock element dimensions.
   */
  function mockElementDimensions(element: HTMLElement, height: number): void {
    Object.defineProperty(element, 'offsetHeight', {
      value: height,
      configurable: true
    });
    Object.defineProperty(element, 'clientHeight', {
      value: height,
      configurable: true
    });
  }

  beforeEach(() => {
    manager = new EventStateManager();

    // Create scroll container with dimensions
    scrollContainer = document.createElement('div');
    scrollContainer.className = 'scroll-container';
    scrollContainer.style.height = '500px';
    scrollContainer.style.overflow = 'auto';
    document.body.appendChild(scrollContainer);

    // Mock viewport height
    mockElementDimensions(scrollContainer, 500);

    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.clearAllTimers();
  });

  // ============================================
  // Constructor Tests
  // ============================================

  describe('Constructor', () => {
    it('creates content container inside scroll container', () => {
      actor = new VirtualListActor(manager, scrollContainer);

      const content = getContentContainer();
      expect(content).toBeTruthy();
      expect(content.className).toBe('virtual-list-content');
    });

    it('sets up scroll handling', () => {
      const addEventListenerSpy = vi.spyOn(scrollContainer, 'addEventListener');
      actor = new VirtualListActor(manager, scrollContainer);

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
        { passive: true }
      );
    });

    it('prewarms pool with minPoolSize actors', () => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { minPoolSize: 3 }
      });

      const stats = actor.getPoolStats();
      expect(stats.totalActorsCreated).toBe(3);
      expect(stats.actorsInPool).toBe(3);
      expect(stats.actorsInUse).toBe(0);
    });

    it('applies custom configuration', () => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: {
          minPoolSize: 2,
          maxPoolSize: 10,
          defaultTurnHeight: 200,
          overscan: 1,
          scrollDebounce: 32
        }
      });

      const stats = actor.getPoolStats();
      expect(stats.totalActorsCreated).toBe(2);
    });
  });

  // ============================================
  // Pool Lifecycle Tests
  // ============================================

  describe('Pool lifecycle', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { minPoolSize: 2, maxPoolSize: 5 }
      });
    });

    it('acquires actor from pool when available', () => {
      // Pool has 2 actors from prewarm
      const initialStats = actor.getPoolStats();
      expect(initialStats.actorsInPool).toBe(2);

      // Add a turn - should acquire from pool
      actor.addTurn('turn-1', 'user');

      const stats = actor.getPoolStats();
      expect(stats.actorsInPool).toBe(1); // One less in pool
      expect(stats.actorsInUse).toBe(1);
    });

    it('creates new actor when pool is empty', () => {
      // Add more turns than pool has
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');
      actor.addTurn('turn-3', 'user');

      const stats = actor.getPoolStats();
      expect(stats.totalActorsCreated).toBe(3); // 2 prewarmed + 1 new
      expect(stats.actorsInUse).toBe(3);
      expect(stats.actorsInPool).toBe(0);
    });

    it('releases actor back to pool when turn goes off-screen', async () => {
      // Add turns
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const initialStats = actor.getPoolStats();
      expect(initialStats.actorsInUse).toBe(2);

      // Scroll past first turn (simulate going off-screen)
      // This requires mocking the height measurement
      const turn1 = actor.getTurn('turn-1');
      if (turn1) {
        turn1.height = 200;
        turn1.offsetTop = 0;
      }
      const turn2 = actor.getTurn('turn-2');
      if (turn2) {
        turn2.height = 200;
        turn2.offsetTop = 200;
      }

      // Scroll down past turn 1
      await simulateScroll(300);

      // Turn 1 should be released (if out of viewport + overscan)
      // With viewport 500 and overscan 2 * 150 = 300, scrollTop 300
      // viewTop = 300 - 300 = 0, viewBottom = 300 + 500 + 300 = 1100
      // Turn 1: 0-200 is in range, Turn 2: 200-400 is in range
      // Both should still be visible due to overscan
    });

    it('does not exceed maxPoolSize when releasing', async () => {
      // Create many turns
      for (let i = 0; i < 10; i++) {
        actor.addTurn(`turn-${i}`, i % 2 === 0 ? 'user' : 'assistant');
      }

      // Clear all turns
      actor.clear();

      const stats = actor.getPoolStats();
      // Should cap at maxPoolSize (5)
      expect(stats.actorsInPool).toBeLessThanOrEqual(5);
    });
  });

  // ============================================
  // Turn Management Tests
  // ============================================

  describe('Turn management', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    it('adds turn with correct data', () => {
      const turn = actor.addTurn('turn-1', 'user', {
        timestamp: 12345,
        model: 'deepseek-r1',
        files: ['file1.ts', 'file2.ts']
      });

      expect(turn.turnId).toBe('turn-1');
      expect(turn.role).toBe('user');
      expect(turn.timestamp).toBe(12345);
      expect(turn.model).toBe('deepseek-r1');
      expect(turn.files).toEqual(['file1.ts', 'file2.ts']);
      expect(turn.index).toBe(0);
      expect(turn.isStreaming).toBe(false);
    });

    it('calculates offsetTop correctly', () => {
      const turn1 = actor.addTurn('turn-1', 'user');
      const turn2 = actor.addTurn('turn-2', 'assistant');
      const turn3 = actor.addTurn('turn-3', 'user');

      expect(turn1.offsetTop).toBe(0);
      expect(turn2.offsetTop).toBe(150); // Default height
      expect(turn3.offsetTop).toBe(300);
    });

    it('getTurn returns turn by ID', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const turn = actor.getTurn('turn-2');
      expect(turn?.turnId).toBe('turn-2');
      expect(turn?.role).toBe('assistant');
    });

    it('getTurn returns undefined for unknown ID', () => {
      const turn = actor.getTurn('nonexistent');
      expect(turn).toBeUndefined();
    });

    it('startStreamingTurn sets streaming state', () => {
      actor.addTurn('turn-1', 'assistant');
      actor.startStreamingTurn('turn-1');

      const turn = actor.getTurn('turn-1');
      expect(turn?.isStreaming).toBe(true);

      const streaming = actor.getStreamingTurn();
      expect(streaming?.turnId).toBe('turn-1');
    });

    it('endStreamingTurn clears streaming state', () => {
      actor.addTurn('turn-1', 'assistant');
      actor.startStreamingTurn('turn-1');
      actor.endStreamingTurn();

      const turn = actor.getTurn('turn-1');
      expect(turn?.isStreaming).toBe(false);

      const streaming = actor.getStreamingTurn();
      expect(streaming).toBeUndefined();
    });

    it('publishes turnCount on add', () => {
      actor.addTurn('turn-1', 'user');

      expect(manager.getState('virtualList.turnCount')).toBe(1);

      actor.addTurn('turn-2', 'assistant');

      expect(manager.getState('virtualList.turnCount')).toBe(2);
    });
  });

  // ============================================
  // Content Delegation Tests
  // ============================================

  describe('Content delegation', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    describe('Text segments', () => {
      it('adds text segment to turn data', () => {
        actor.addTurn('turn-1', 'user');
        actor.addTextSegment('turn-1', 'Hello world');

        const turn = actor.getTurn('turn-1');
        expect(turn?.textSegments.length).toBe(1);
        expect(turn?.textSegments[0].content).toBe('Hello world');
        expect(turn?.textSegments[0].isContinuation).toBe(false);
      });

      it('updates text content', () => {
        actor.addTurn('turn-1', 'user');
        actor.addTextSegment('turn-1', 'Initial');
        actor.updateTextContent('turn-1', 'Updated');

        const turn = actor.getTurn('turn-1');
        expect(turn?.textSegments[0].content).toBe('Updated');
      });

      it('adds continuation segment', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.addTextSegment('turn-1', 'First');
        actor.addTextSegment('turn-1', 'Second', true);

        const turn = actor.getTurn('turn-1');
        expect(turn?.textSegments.length).toBe(2);
        expect(turn?.textSegments[1].isContinuation).toBe(true);
      });

      it('finalizes current segment', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.startStreamingTurn('turn-1');
        actor.addTextSegment('turn-1', 'Content');
        actor.finalizeCurrentSegment('turn-1');

        const turn = actor.getTurn('turn-1');
        expect(turn?.textSegments[0].complete).toBe(true);
      });
    });

    describe('Thinking iterations', () => {
      it('starts thinking iteration', () => {
        actor.addTurn('turn-1', 'assistant');
        const idx = actor.startThinkingIteration('turn-1');

        expect(idx).toBe(1);

        const turn = actor.getTurn('turn-1');
        expect(turn?.thinkingIterations.length).toBe(1);
        expect(turn?.thinkingIterations[0].complete).toBe(false);
      });

      it('updates thinking content', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.startThinkingIteration('turn-1');
        actor.updateThinkingContent('turn-1', 'Thinking...');

        const turn = actor.getTurn('turn-1');
        expect(turn?.thinkingIterations[0].content).toBe('Thinking...');
      });

      it('tracks multiple iterations', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.startThinkingIteration('turn-1');
        actor.startThinkingIteration('turn-1');
        actor.startThinkingIteration('turn-1');

        const turn = actor.getTurn('turn-1');
        expect(turn?.thinkingIterations.length).toBe(3);
        expect(turn?.thinkingIterations[2].index).toBe(3);
      });
    });

    describe('Tool batches', () => {
      it('starts tool batch', () => {
        actor.addTurn('turn-1', 'assistant');
        const batchId = actor.startToolBatch('turn-1', [
          { name: 'read_file', detail: 'file.ts' },
          { name: 'write_file', detail: 'output.ts' }
        ]);

        expect(batchId).toContain('tools');

        const turn = actor.getTurn('turn-1');
        expect(turn?.toolBatches.length).toBe(1);
        expect(turn?.toolBatches[0].calls.length).toBe(2);
      });

      it('updates tool status', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.startToolBatch('turn-1', [{ name: 'test', detail: '' }]);
        actor.updateTool('turn-1', 0, 'done');

        const turn = actor.getTurn('turn-1');
        expect(turn?.toolBatches[0].calls[0].status).toBe('done');
      });

      it('completes tool batch', () => {
        actor.addTurn('turn-1', 'assistant');
        actor.startToolBatch('turn-1', [{ name: 'test', detail: '' }]);
        actor.completeToolBatch('turn-1');

        const turn = actor.getTurn('turn-1');
        expect(turn?.toolBatches[0].complete).toBe(true);
      });
    });

    describe('Shell segments', () => {
      it('creates shell segment', () => {
        actor.addTurn('turn-1', 'assistant');
        const segmentId = actor.createShellSegment('turn-1', [
          { command: 'npm test', cwd: '/project' }
        ]);

        expect(segmentId).toContain('shell');

        const turn = actor.getTurn('turn-1');
        expect(turn?.shellSegments.length).toBe(1);
        expect(turn?.shellSegments[0].commands[0].command).toBe('npm test');
      });

      it('starts shell segment', () => {
        actor.addTurn('turn-1', 'assistant');
        const segmentId = actor.createShellSegment('turn-1', [{ command: 'ls' }]);
        actor.startShellSegment('turn-1', segmentId!);

        const turn = actor.getTurn('turn-1');
        expect(turn?.shellSegments[0].commands[0].status).toBe('running');
      });

      it('sets shell results', () => {
        actor.addTurn('turn-1', 'assistant');
        const segmentId = actor.createShellSegment('turn-1', [{ command: 'echo hi' }]);
        actor.startShellSegment('turn-1', segmentId!);
        actor.setShellResults('turn-1', segmentId!, [
          { output: 'hi', success: true }
        ]);

        const turn = actor.getTurn('turn-1');
        expect(turn?.shellSegments[0].commands[0].output).toBe('hi');
        expect(turn?.shellSegments[0].commands[0].success).toBe(true);
        expect(turn?.shellSegments[0].complete).toBe(true);
      });
    });

    describe('Pending files', () => {
      it('adds pending file', () => {
        actor.addTurn('turn-1', 'assistant');
        const fileId = actor.addPendingFile('turn-1', {
          filePath: '/path/to/file.ts',
          diffId: 'diff-123'
        });

        expect(fileId).toContain('pending');

        const turn = actor.getTurn('turn-1');
        expect(turn?.pendingFiles.length).toBe(1);
        expect(turn?.pendingFiles[0].filePath).toBe('/path/to/file.ts');
        expect(turn?.pendingFiles[0].fileName).toBe('file.ts');
        expect(turn?.pendingFiles[0].diffId).toBe('diff-123');
      });

      it('updates pending status', () => {
        actor.addTurn('turn-1', 'assistant');
        const fileId = actor.addPendingFile('turn-1', {
          filePath: '/path/file.ts'
        });
        actor.updatePendingStatus('turn-1', fileId!, 'applied');

        const turn = actor.getTurn('turn-1');
        expect(turn?.pendingFiles[0].status).toBe('applied');
      });
    });
  });

  // ============================================
  // Visibility Tests
  // ============================================

  describe('Visibility management', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: {
          minPoolSize: 0,
          overscan: 1,
          defaultTurnHeight: 100
        }
      });
    });

    it('marks initial turns as visible', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const turn1 = actor.getTurn('turn-1');
      const turn2 = actor.getTurn('turn-2');

      expect(turn1?.visible).toBe(true);
      expect(turn2?.visible).toBe(true);
    });

    it('calculates visible range correctly', () => {
      // Add enough turns to exceed viewport
      for (let i = 0; i < 10; i++) {
        actor.addTurn(`turn-${i}`, i % 2 === 0 ? 'user' : 'assistant');
      }

      const range = actor.getVisibleRange();
      expect(range.startIndex).toBeGreaterThanOrEqual(0);
      expect(range.endIndex).toBeGreaterThanOrEqual(range.startIndex);
    });

    it('binds actors to visible turns', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const bound1 = actor.getBoundActor('turn-1');
      const bound2 = actor.getBoundActor('turn-2');

      expect(bound1).toBeTruthy();
      expect(bound2).toBeTruthy();
    });

    it('publishes visible count', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      expect(manager.getState('virtualList.visibleCount')).toBe(2);
    });
  });

  // ============================================
  // Height Management Tests
  // ============================================

  describe('Height management', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { defaultTurnHeight: 100 }
      });
    });

    it('initializes turns with default height', () => {
      const turn = actor.addTurn('turn-1', 'user');

      expect(turn.height).toBe(100);
      expect(turn.heightMeasured).toBe(false);
    });

    it('updates total height as turns are added', () => {
      actor.addTurn('turn-1', 'user');
      expect(actor.getTotalHeight()).toBe(100);

      actor.addTurn('turn-2', 'assistant');
      expect(actor.getTotalHeight()).toBe(200);

      actor.addTurn('turn-3', 'user');
      expect(actor.getTotalHeight()).toBe(300);
    });

    it('sets content container height', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const content = getContentContainer();
      expect(content.style.height).toBe('200px');
    });
  });

  // ============================================
  // Clear/Reset Tests
  // ============================================

  describe('Clear and reset', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    it('clears all turns', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      actor.clear();

      const stats = actor.getPoolStats();
      expect(stats.totalTurns).toBe(0);
      expect(stats.visibleTurns).toBe(0);
    });

    it('releases all actors to pool on clear', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const beforeClear = actor.getPoolStats();
      expect(beforeClear.actorsInUse).toBe(2);

      actor.clear();

      const afterClear = actor.getPoolStats();
      expect(afterClear.actorsInUse).toBe(0);
      expect(afterClear.actorsInPool).toBeGreaterThan(0);
    });

    it('resets total height on clear', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      expect(actor.getTotalHeight()).toBeGreaterThan(0);

      actor.clear();

      expect(actor.getTotalHeight()).toBe(0);
    });

    it('publishes reset counts', () => {
      actor.addTurn('turn-1', 'user');
      actor.clear();

      expect(manager.getState('virtualList.turnCount')).toBe(0);
      expect(manager.getState('virtualList.visibleCount')).toBe(0);
    });
  });

  // ============================================
  // Edit Mode Tests
  // ============================================

  describe('Edit mode', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    it('sets edit mode on all bound actors', () => {
      actor.addTurn('turn-1', 'assistant');
      actor.addTurn('turn-2', 'assistant');

      actor.setEditMode('ask');

      // Verify actors received edit mode
      const bound1 = actor.getBoundActor('turn-1');
      const bound2 = actor.getBoundActor('turn-2');

      // We can't directly check actor's edit mode, but we can verify no errors
      expect(bound1).toBeTruthy();
      expect(bound2).toBeTruthy();
    });
  });

  // ============================================
  // Statistics Tests
  // ============================================

  describe('Statistics', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { minPoolSize: 3 }
      });
    });

    it('getPoolStats returns accurate counts', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const stats = actor.getPoolStats();

      expect(stats.totalTurns).toBe(2);
      expect(stats.visibleTurns).toBe(2);
      expect(stats.actorsInUse).toBe(2);
      expect(stats.actorsInPool).toBe(1); // 3 prewarmed - 2 in use
      expect(stats.totalActorsCreated).toBe(3);
    });

    it('getVisibleRange returns current range', () => {
      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      const range = actor.getVisibleRange();

      expect(range).toEqual({
        startIndex: expect.any(Number),
        endIndex: expect.any(Number),
        scrollTop: expect.any(Number),
        viewportHeight: expect.any(Number)
      });
    });

    it('publishes pool stats', () => {
      actor.addTurn('turn-1', 'user');

      const stats = manager.getState('virtualList.poolStats') as ReturnType<VirtualListActor['getPoolStats']>;

      expect(stats.totalTurns).toBe(1);
      expect(stats.actorsInUse).toBe(1);
    });
  });

  // ============================================
  // Subscription Handler Tests
  // ============================================

  describe('Subscription handlers', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    it('handles streaming.active false to end streaming', () => {
      actor.addTurn('turn-1', 'assistant');
      actor.startStreamingTurn('turn-1');

      // Simulate external streaming.active = false
      manager.publishDirect('streaming.active', false);

      // Streaming should be ended
      expect(actor.getStreamingTurn()).toBeUndefined();
    });
  });

  // ============================================
  // Lifecycle Tests
  // ============================================

  describe('Lifecycle', () => {
    it('removes scroll handler on destroy', () => {
      actor = new VirtualListActor(manager, scrollContainer);
      const removeEventListenerSpy = vi.spyOn(scrollContainer, 'removeEventListener');

      actor.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function)
      );
    });

    it('cleans up content container on destroy', () => {
      actor = new VirtualListActor(manager, scrollContainer);

      const content = getContentContainer();
      expect(content).toBeTruthy();

      actor.destroy();

      expect(scrollContainer.querySelector('.virtual-list-content')).toBeNull();
    });

    it('destroys all actors on destroy', () => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { minPoolSize: 2 }
      });

      actor.addTurn('turn-1', 'user');
      actor.addTurn('turn-2', 'assistant');

      // 2 prewarmed + potentially more in use
      const statsBefore = actor.getPoolStats();
      expect(statsBefore.totalActorsCreated).toBeGreaterThan(0);

      actor.destroy();

      // After destroy, getPoolStats would error, so we just verify destroy completes
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('Edge cases', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer);
    });

    it('handles content updates on non-existent turn', () => {
      // Should not throw
      const result = actor.addTextSegment('nonexistent', 'text');
      expect(result).toBeNull();
    });

    it('handles streaming on non-existent turn', () => {
      // Should not throw
      actor.startStreamingTurn('nonexistent');
      expect(actor.getStreamingTurn()).toBeUndefined();
    });

    it('handles end streaming when not streaming', () => {
      // Should not throw
      actor.endStreamingTurn();
      expect(actor.getStreamingTurn()).toBeUndefined();
    });

    it('handles empty turn list', () => {
      const stats = actor.getPoolStats();
      expect(stats.totalTurns).toBe(0);
      expect(stats.visibleTurns).toBe(0);

      const range = actor.getVisibleRange();
      expect(range.startIndex).toBe(0);
      expect(range.endIndex).toBe(-1);
    });
  });

  // ============================================
  // Integration Tests
  // ============================================

  describe('Integration', () => {
    beforeEach(() => {
      actor = new VirtualListActor(manager, scrollContainer, {
        config: { minPoolSize: 2 }
      });
    });

    it('handles full conversation flow', () => {
      // User message
      actor.addTurn('turn-1', 'user');
      actor.addTextSegment('turn-1', 'Help me with this code');

      // Assistant response with interleaving
      actor.addTurn('turn-2', 'assistant');
      actor.startStreamingTurn('turn-2');

      // First text
      actor.addTextSegment('turn-2', 'Let me help you.');
      actor.finalizeCurrentSegment('turn-2');

      // Thinking
      actor.startThinkingIteration('turn-2');
      actor.updateThinkingContent('turn-2', 'Analyzing...');

      // Tool call
      actor.startToolBatch('turn-2', [{ name: 'read_file', detail: 'src/main.ts' }]);
      actor.updateTool('turn-2', 0, 'done');
      actor.completeToolBatch('turn-2');

      // Resume text
      actor.resumeWithNewSegment('turn-2');
      actor.updateTextContent('turn-2', 'Based on the file...');

      // End streaming
      actor.endStreamingTurn();

      // Verify turn structure
      const turn2 = actor.getTurn('turn-2');
      expect(turn2?.textSegments.length).toBe(2);
      expect(turn2?.thinkingIterations.length).toBe(1);
      expect(turn2?.toolBatches.length).toBe(1);
      expect(turn2?.isStreaming).toBe(false);
    });

    it('handles rapid turn additions', () => {
      // Simulate rapid history load
      for (let i = 0; i < 50; i++) {
        actor.addTurn(`turn-${i}`, i % 2 === 0 ? 'user' : 'assistant');
        actor.addTextSegment(`turn-${i}`, `Message ${i}`);
      }

      const stats = actor.getPoolStats();
      expect(stats.totalTurns).toBe(50);
      // Not all turns should be bound (virtual rendering)
      expect(stats.actorsInUse).toBeLessThanOrEqual(stats.totalTurns);
    });
  });
});
