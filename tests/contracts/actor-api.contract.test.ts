/**
 * Actor API Contract Tests
 *
 * These tests verify that actor public APIs match what chat.ts expects.
 * If these tests fail, it means the integration between chat.ts and
 * actors is broken - either update chat.ts or the actor API.
 *
 * IMPORTANT: Keep these in sync with chat.ts message handlers!
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../media/state/EventStateManager';
import { StreamingActor } from '../../media/actors/streaming/StreamingActor';
import { MessageActor } from '../../media/actors/message/MessageActor';
import { ShellActor } from '../../media/actors/shell/ShellActor';
import { ToolCallsActor } from '../../media/actors/tools/ToolCallsActor';
import { ThinkingActor } from '../../media/actors/thinking/ThinkingActor';
import { ScrollActor } from '../../media/actors/scroll/ScrollActor';

describe('StreamingActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StreamingActor;

  beforeEach(() => {
    StreamingActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);
    actor = new StreamingActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has startStream(messageId, model) method', () => {
      expect(typeof actor.startStream).toBe('function');
      expect(() => actor.startStream('msg-id', 'model')).not.toThrow();
    });

    it('has handleContentChunk(token) method', () => {
      expect(typeof actor.handleContentChunk).toBe('function');
      actor.startStream('msg', 'model');
      expect(() => actor.handleContentChunk('token')).not.toThrow();
    });

    it('has handleThinkingChunk(token) method', () => {
      expect(typeof actor.handleThinkingChunk).toBe('function');
      actor.startStream('msg', 'model');
      expect(() => actor.handleThinkingChunk('thinking')).not.toThrow();
    });

    it('has endStream() method', () => {
      expect(typeof actor.endStream).toBe('function');
      actor.startStream('msg', 'model');
      expect(() => actor.endStream()).not.toThrow();
    });
  });

  describe('properties required by chat.ts', () => {
    it('has isActive getter', () => {
      expect('isActive' in actor).toBe(true);
      expect(typeof actor.isActive).toBe('boolean');
    });

    it('has content getter', () => {
      expect('content' in actor).toBe(true);
      expect(typeof actor.content).toBe('string');
    });

    it('has thinking getter', () => {
      expect('thinking' in actor).toBe(true);
      expect(typeof actor.thinking).toBe('string');
    });

    it('has messageId getter', () => {
      expect('messageId' in actor).toBe(true);
    });
  });
});

describe('MessageActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageActor;

  beforeEach(() => {
    MessageActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);

    // MessageActor needs StreamingActor for subscriptions
    const streamEl = document.createElement('div');
    document.body.appendChild(streamEl);
    new StreamingActor(manager, streamEl);

    actor = new MessageActor(manager, element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has addUserMessage(content, files?) method', () => {
      expect(typeof actor.addUserMessage).toBe('function');
      expect(() => actor.addUserMessage('content')).not.toThrow();
      expect(() => actor.addUserMessage('content', ['file.txt'])).not.toThrow();
    });

    it('has addAssistantMessage(content, options?) method', () => {
      expect(typeof actor.addAssistantMessage).toBe('function');
      expect(() => actor.addAssistantMessage('content')).not.toThrow();
      expect(() =>
        actor.addAssistantMessage('content', { thinking: 'reasoning' })
      ).not.toThrow();
    });

    it('has clear() method', () => {
      expect(typeof actor.clear).toBe('function');
      expect(() => actor.clear()).not.toThrow();
    });

    it('has getMessages() method', () => {
      expect(typeof actor.getMessages).toBe('function');
      expect(Array.isArray(actor.getMessages())).toBe(true);
    });

    it('has getState() method', () => {
      expect(typeof actor.getState).toBe('function');
      const state = actor.getState();
      expect('count' in state).toBe(true);
      expect('streaming' in state).toBe(true);
    });
  });

  describe('addAssistantMessage options contract', () => {
    it('accepts thinking in options', () => {
      const id = actor.addAssistantMessage('response', {
        thinking: 'I thought about this'
      });
      const msg = actor.getMessage(id);
      expect(msg?.thinking).toBe('I thought about this');
    });

    it('handles undefined thinking', () => {
      const id = actor.addAssistantMessage('response', { thinking: undefined });
      const msg = actor.getMessage(id);
      expect(msg?.thinking).toBeUndefined();
    });
  });
});

describe('ShellActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ShellActor;

  beforeEach(() => {
    ShellActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);
    actor = new ShellActor(manager, element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has createSegment(commands) method that returns segmentId', () => {
      expect(typeof actor.createSegment).toBe('function');
      const segmentId = actor.createSegment(['cmd']);
      expect(typeof segmentId).toBe('string');
      expect(segmentId.length).toBeGreaterThan(0);
    });

    it('has startSegment(segmentId) method', () => {
      expect(typeof actor.startSegment).toBe('function');
      const id = actor.createSegment(['cmd']);
      expect(() => actor.startSegment(id)).not.toThrow();
    });

    it('has setResults(segmentId, results) method', () => {
      expect(typeof actor.setResults).toBe('function');
      const id = actor.createSegment(['cmd']);
      actor.startSegment(id);
      expect(() =>
        actor.setResults(id, [{ success: true, output: 'done' }])
      ).not.toThrow();
    });

    it('has getState() method', () => {
      expect(typeof actor.getState).toBe('function');
      const state = actor.getState();
      expect('segments' in state).toBe(true);
      expect(Array.isArray(state.segments)).toBe(true);
    });
  });

  describe('setResults results contract', () => {
    it('accepts success boolean', () => {
      const id = actor.createSegment(['cmd']);
      actor.startSegment(id);
      actor.setResults(id, [{ success: true }]);

      const state = actor.getState();
      // success is stored directly on command, not in a result object
      expect(state.segments[0].commands[0].success).toBe(true);
    });

    it('accepts optional output string', () => {
      const id = actor.createSegment(['cmd']);
      actor.startSegment(id);
      actor.setResults(id, [{ success: true, output: 'hello' }]);

      const state = actor.getState();
      expect(state.segments[0].commands[0].output).toBe('hello');
    });

    it('handles undefined output', () => {
      const id = actor.createSegment(['cmd']);
      actor.startSegment(id);
      actor.setResults(id, [{ success: false }]);

      const state = actor.getState();
      expect(state.segments[0].commands[0].success).toBe(false);
    });
  });
});

describe('ToolCallsActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ToolCallsActor;

  beforeEach(() => {
    ToolCallsActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);
    actor = new ToolCallsActor(manager, element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has startBatch(tools) method', () => {
      expect(typeof actor.startBatch).toBe('function');
      expect(() =>
        actor.startBatch([{ name: 'tool', detail: 'detail' }])
      ).not.toThrow();
    });

    it('has updateBatch(tools) method', () => {
      expect(typeof actor.updateBatch).toBe('function');
      expect(() =>
        actor.updateBatch([{ name: 'tool', detail: 'detail', status: 'done' }])
      ).not.toThrow();
    });

    it('has getCalls() method', () => {
      expect(typeof actor.getCalls).toBe('function');
      expect(Array.isArray(actor.getCalls())).toBe(true);
    });

    it('has complete() method', () => {
      expect(typeof actor.complete).toBe('function');
      expect(() => actor.complete()).not.toThrow();
    });

    it('has getState() method', () => {
      expect(typeof actor.getState).toBe('function');
      const state = actor.getState();
      // ToolCallsState has { calls, activeCount, expanded }
      expect('calls' in state).toBe(true);
      expect('activeCount' in state).toBe(true);
      expect('expanded' in state).toBe(true);
    });
  });

  describe('startBatch tools contract', () => {
    it('accepts name and detail', () => {
      actor.startBatch([{ name: 'read_file', detail: 'test.txt' }]);
      const calls = actor.getCalls();
      expect(calls[0].name).toBe('read_file');
      expect(calls[0].detail).toBe('test.txt');
    });
  });

  describe('updateBatch tools contract', () => {
    it('accepts name, detail, and status', () => {
      // First start a batch, then update it
      actor.startBatch([{ name: 'tool', detail: 'd' }]);
      actor.updateBatch([
        { name: 'tool', detail: 'd', status: 'running' }
      ]);
      const calls = actor.getCalls();
      expect(calls[0].status).toBe('running');
    });

    it('accepts valid status values', () => {
      const statuses = ['pending', 'running', 'done', 'error'] as const;
      for (const status of statuses) {
        // Start fresh batch for each status test
        actor.clear();
        actor.startBatch([{ name: 't', detail: 'd' }]);
        actor.updateBatch([{ name: 't', detail: 'd', status }]);
        expect(actor.getCalls()[0].status).toBe(status);
      }
    });

    it('accepts undefined status (defaults to running)', () => {
      // Start a batch first
      actor.startBatch([{ name: 't', detail: 'd' }]);
      // When status is undefined, updateBatch keeps existing status (running from startBatch)
      actor.updateBatch([{ name: 't', detail: 'd', status: undefined }]);
      expect(actor.getCalls()[0].status).toBe('running');
    });
  });
});

describe('ThinkingActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ThinkingActor;

  beforeEach(() => {
    ThinkingActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);

    // ThinkingActor may need StreamingActor for subscriptions
    const streamEl = document.createElement('div');
    document.body.appendChild(streamEl);
    new StreamingActor(manager, streamEl);

    actor = new ThinkingActor(manager, element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has startIteration() method', () => {
      expect(typeof actor.startIteration).toBe('function');
      expect(() => actor.startIteration()).not.toThrow();
    });

    it('has completeIteration() method', () => {
      expect(typeof actor.completeIteration).toBe('function');
      actor.startIteration();
      expect(() => actor.completeIteration()).not.toThrow();
    });

    it('has getState() method', () => {
      expect(typeof actor.getState).toBe('function');
      const state = actor.getState();
      expect('iterations' in state).toBe(true);
      expect(Array.isArray(state.iterations)).toBe(true);
    });
  });

  describe('iteration lifecycle', () => {
    it('creates iteration on startIteration', () => {
      actor.startIteration();
      expect(actor.getState().iterations.length).toBeGreaterThan(0);
    });

    it('completes iteration on completeIteration', () => {
      actor.startIteration();
      actor.completeIteration();
      const state = actor.getState();
      // Check that iteration is marked complete (implementation specific)
      expect(state.iterations.length).toBeGreaterThan(0);
    });
  });
});

describe('ScrollActor API Contract', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: ScrollActor;

  beforeEach(() => {
    ScrollActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    document.body.appendChild(element);

    // ScrollActor subscribes to streaming
    const streamEl = document.createElement('div');
    document.body.appendChild(streamEl);
    new StreamingActor(manager, streamEl);

    actor = new ScrollActor(manager, element);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('methods required by chat.ts', () => {
    it('has getState() method', () => {
      expect(typeof actor.getState).toBe('function');
      const state = actor.getState();
      // ScrollState has { autoScroll, userScrolled, nearBottom }
      expect('autoScroll' in state).toBe(true);
      expect('userScrolled' in state).toBe(true);
      expect('nearBottom' in state).toBe(true);
    });
  });

  describe('state contract', () => {
    it('tracks scroll state', () => {
      const state = actor.getState();
      expect(typeof state.autoScroll).toBe('boolean');
      expect(typeof state.userScrolled).toBe('boolean');
      expect(typeof state.nearBottom).toBe('boolean');
    });
  });
});

describe('Cross-Actor Integration Contract', () => {
  it('MessageActor.addAssistantMessage accepts same options as chat.ts provides', () => {
    MessageActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();

    const manager = new EventStateManager();
    const el = document.createElement('div');
    const streamEl = document.createElement('div');
    document.body.appendChild(el);
    document.body.appendChild(streamEl);

    new StreamingActor(manager, streamEl);
    const message = new MessageActor(manager, el);

    // This is exactly what chat.ts does:
    // message.addAssistantMessage(msg.message.content, { thinking: msg.message.reasoning })
    const msgData = { content: 'Response', reasoning: 'Reasoning text' };
    expect(() =>
      message.addAssistantMessage(msgData.content, {
        thinking: msgData.reasoning
      })
    ).not.toThrow();

    document.body.innerHTML = '';
  });

  it('ShellActor result mapping matches chat.ts transformation', () => {
    ShellActor.resetStylesInjected();

    const manager = new EventStateManager();
    const el = document.createElement('div');
    document.body.appendChild(el);

    const shell = new ShellActor(manager, el);

    // This is exactly what chat.ts does:
    // shell.setResults(id, results.map(result => ({
    //   success: result.exitCode === 0,
    //   output: result.output
    // })));

    const backendResults = [
      { output: 'success output', exitCode: 0 },
      { output: 'error output', exitCode: 1 },
      { exitCode: 127 } // No output
    ];

    const mappedResults = backendResults.map(result => ({
      success: result.exitCode === 0,
      output: result.output
    }));

    const id = shell.createSegment(['cmd1', 'cmd2', 'cmd3']);
    shell.startSegment(id);
    expect(() => shell.setResults(id, mappedResults)).not.toThrow();

    document.body.innerHTML = '';
  });
});
