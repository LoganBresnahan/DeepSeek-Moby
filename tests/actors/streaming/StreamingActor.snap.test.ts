/**
 * Snapshot tests for StreamingActor
 * These capture the DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('StreamingActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StreamingActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'streaming-root';
    element.className = 'streaming-container';
    document.body.appendChild(element);

    actor = new StreamingActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    manager.resetStyles();
    document.body.innerHTML = '';
  });

  describe('indicator states', () => {
    it('renders inactive state (no indicator)', () => {
      // Actor is inactive by default
      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders active streaming indicator', () => {
      actor.startStream('msg-123');

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders deactivated indicator after stream ends', () => {
      actor.startStream('msg-123');
      actor.endStream();

      expect(element.innerHTML).toMatchSnapshot();
    });

    it('renders cleared state after abort', () => {
      actor.startStream('msg-123');
      actor.handleContentChunk('Some content');
      actor.abortStream();

      expect(element.innerHTML).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles via EventStateManager', () => {
      // Manager should have streaming styles registered
      expect(manager.hasStyles('streaming')).toBe(true);

      // Shared style element should exist
      const styleTag = document.getElementById('actor-styles');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.getAttribute('data-managed-by')).toBe('EventStateManager');

      // Should contain streaming styles (marked with comment)
      expect(manager.getStyleContent()).toContain('/* === streaming === */');
    });

    it('only injects styles once per actor type', () => {
      // Create another actor with the same manager
      const element2 = document.createElement('div');
      element2.id = 'streaming-root-2';
      document.body.appendChild(element2);

      const actor2 = new StreamingActor(manager, element2);

      // Should still only have one style element
      const styleTags = document.querySelectorAll('#actor-styles');
      expect(styleTags.length).toBe(1);

      // Content should not be duplicated
      const content = manager.getStyleContent();
      const matches = content.match(/\/\* === streaming === \*\//g);
      expect(matches?.length).toBe(1);

      actor2.destroy();
    });
  });
});

describe('StreamingActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StreamingActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'streaming-root';
    document.body.appendChild(element);
    actor = new StreamingActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    manager.resetStyles();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures active streaming state', () => {
    actor.startStream('msg-123', 'deepseek-chat');
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with content', () => {
    actor.startStream('msg-123', 'deepseek-chat');
    actor.handleContentChunk('Hello, I am an AI assistant.');
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state with thinking (reasoner model)', () => {
    actor.startStream('msg-456', 'deepseek-reasoner');
    actor.handleThinkingChunk('Let me analyze this problem step by step...');
    actor.handleContentChunk('The answer is 42.');
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures completed stream state', () => {
    actor.startStream('msg-789', 'deepseek-chat');
    actor.handleContentChunk('This is the complete response.');
    actor.endStream();
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures aborted stream state', () => {
    actor.startStream('msg-999', 'deepseek-chat');
    actor.handleContentChunk('This will be discarded...');
    actor.abortStream();
    expect(actor.getState()).toMatchSnapshot();
  });
});
