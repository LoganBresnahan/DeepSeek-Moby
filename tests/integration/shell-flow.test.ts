/**
 * Shell Flow Integration Tests
 *
 * Tests the shell command execution flow from shellExecuting
 * through shellResults, verifying correct actor API usage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  simulateShellExecution,
  type TestActorSystem
} from './helpers';

describe('Shell Flow Integration', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('single command execution', () => {
    it('executes a single command successfully', async () => {
      await simulateShellExecution(
        system,
        ['npm test'],
        [{ output: '10 tests passed', exitCode: 0 }]
      );

      const state = system.shell.getState();
      expect(state.segments.length).toBe(1);
      expect(state.segments[0].commands[0].command).toBe('npm test');
      // success and output are stored directly on command, not in a result object
      expect(state.segments[0].commands[0].success).toBe(true);
      expect(state.segments[0].commands[0].output).toBe('10 tests passed');
    });

    it('handles failed command', async () => {
      await simulateShellExecution(
        system,
        ['npm invalid-cmd'],
        [{ output: 'Command not found', exitCode: 127 }]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(false);
    });
  });

  describe('multiple command execution', () => {
    it('executes multiple commands in sequence', async () => {
      await simulateShellExecution(
        system,
        ['npm install', 'npm test', 'npm build'],
        [
          { output: 'installed 100 packages', exitCode: 0 },
          { output: 'all tests passed', exitCode: 0 },
          { output: 'build complete', exitCode: 0 }
        ]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands.length).toBe(3);
      expect(state.segments[0].commands[0].success).toBe(true);
      expect(state.segments[0].commands[1].success).toBe(true);
      expect(state.segments[0].commands[2].success).toBe(true);
    });

    it('handles mixed success and failure', async () => {
      await simulateShellExecution(
        system,
        ['npm test', 'npm lint'],
        [
          { output: 'passed', exitCode: 0 },
          { output: 'lint errors found', exitCode: 1 }
        ]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(true);
      expect(state.segments[0].commands[1].success).toBe(false);
    });
  });

  describe('segment lifecycle', () => {
    it('creates segment with unique ID', async () => {
      const segmentId1 = system.shell.createSegment(['cmd1']);
      const segmentId2 = system.shell.createSegment(['cmd2']);

      expect(segmentId1).not.toBe(segmentId2);
    });

    it('segment starts incomplete', async () => {
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm test']
      });
      await waitForPubSub();

      const state = system.shell.getState();
      // Segment has 'complete' boolean, not 'status'
      expect(state.segments[0].complete).toBe(false);
    });

    it('segment completes after results', async () => {
      await simulateShellExecution(
        system,
        ['npm test'],
        [{ output: 'done', exitCode: 0 }]
      );

      const state = system.shell.getState();
      expect(state.segments[0].complete).toBe(true);
    });
  });

  describe('multiple segments', () => {
    it('handles sequential shell segments', async () => {
      // First segment
      await simulateShellExecution(
        system,
        ['npm install'],
        [{ output: 'installed', exitCode: 0 }]
      );

      // Second segment
      await simulateShellExecution(
        system,
        ['npm test'],
        [{ output: 'passed', exitCode: 0 }]
      );

      const state = system.shell.getState();
      expect(state.segments.length).toBe(2);
    });

    it('each segment tracks its own commands', async () => {
      await simulateShellExecution(
        system,
        ['install'],
        [{ output: 'ok', exitCode: 0 }]
      );

      await simulateShellExecution(
        system,
        ['build', 'test'],
        [
          { output: 'built', exitCode: 0 },
          { output: 'tested', exitCode: 0 }
        ]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands.length).toBe(1);
      expect(state.segments[1].commands.length).toBe(2);
    });
  });

  describe('error handling', () => {
    it('handles missing output gracefully', async () => {
      await simulateShellExecution(
        system,
        ['silent-cmd'],
        [{ exitCode: 0 }] // No output field
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(true);
      expect(state.segments[0].commands[0].output).toBeUndefined();
    });

    it('ignores results without active segment', async () => {
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');

      // Send results without executing first
      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'orphan', exitCode: 0 }]
      });
      await waitForPubSub();

      expect(setResultsSpy).not.toHaveBeenCalled();
    });

    it('handles empty commands array', async () => {
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: []
      });
      await waitForPubSub();

      // Should create a segment even with empty commands
      const state = system.shell.getState();
      expect(state.segments.length).toBe(1);
      expect(state.segments[0].commands.length).toBe(0);
    });
  });

  describe('segment ID tracking', () => {
    it('correctly tracks segment ID across messages', async () => {
      // This tests the currentShellSegmentId logic in chat.ts
      const createSpy = vi.spyOn(system.shell, 'createSegment');
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');

      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['cmd1']
      });
      await waitForPubSub();

      const createdSegmentId = createSpy.mock.results[0].value;

      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'done', exitCode: 0 }]
      });
      await waitForPubSub();

      expect(setResultsSpy).toHaveBeenCalledWith(
        createdSegmentId,
        expect.any(Array)
      );
    });

    it('clears segment ID after results', async () => {
      // First execution
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['cmd1']
      });
      system.dispatchMessage({
        type: 'shellResults',
        results: [{ exitCode: 0 }]
      });
      await waitForPubSub();

      // Second results without executing should be ignored
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');
      setResultsSpy.mockClear();

      system.dispatchMessage({
        type: 'shellResults',
        results: [{ exitCode: 0, output: 'orphan' }]
      });
      await waitForPubSub();

      expect(setResultsSpy).not.toHaveBeenCalled();
    });
  });

  describe('DOM rendering', () => {
    it('renders shell dropdown in chat messages', async () => {
      await simulateShellExecution(
        system,
        ['npm test'],
        [{ output: 'passed', exitCode: 0 }]
      );

      // ShellActor renders with class 'shell-container'
      const shellElement = system.elements.chatMessages.querySelector(
        '.shell-container'
      );
      expect(shellElement).toBeTruthy();
    });

    it('shows command text in DOM', async () => {
      await simulateShellExecution(
        system,
        ['echo "hello world"'],
        [{ output: 'hello world', exitCode: 0 }]
      );

      const commandText = system.elements.chatMessages.textContent;
      expect(commandText).toContain('echo "hello world"');
    });
  });

  describe('exit code interpretation', () => {
    it('exitCode 0 is success', async () => {
      await simulateShellExecution(
        system,
        ['cmd'],
        [{ exitCode: 0 }]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(true);
    });

    it('exitCode 1 is failure', async () => {
      await simulateShellExecution(
        system,
        ['cmd'],
        [{ exitCode: 1 }]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(false);
    });

    it('any non-zero exitCode is failure', async () => {
      await simulateShellExecution(
        system,
        ['cmd1', 'cmd2', 'cmd3'],
        [
          { exitCode: 127 }, // Command not found
          { exitCode: 255 }, // Generic error
          { exitCode: -1 }   // Signal
        ]
      );

      const state = system.shell.getState();
      expect(state.segments[0].commands[0].success).toBe(false);
      expect(state.segments[0].commands[1].success).toBe(false);
      expect(state.segments[0].commands[2].success).toBe(false);
    });
  });
});
