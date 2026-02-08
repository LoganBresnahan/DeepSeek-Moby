/**
 * Snapshot tests for SessionActor
 * Captures state for regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { SessionActor, VSCodeAPI } from '../../../media/actors/session/SessionActor';

describe('SessionActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SessionActor;
  let mockVSCode: VSCodeAPI;

  beforeEach(() => {
    SessionActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'session-root';
    document.body.appendChild(element);

    mockVSCode = {
      postMessage: () => {},
      getState: () => ({}),
      setState: () => {}
    };

    actor = new SessionActor(manager, element, mockVSCode);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('state snapshots', () => {
    it('captures initial state', () => {
      expect(actor.getState()).toMatchSnapshot();
    });

    it('captures state after session loaded', () => {
      actor.handleSessionLoaded({
        sessionId: 'snapshot-session-123',
        title: 'My Test Session',
        model: 'deepseek-reasoner'
      });

      expect(actor.getState()).toMatchSnapshot();
    });

    it('captures state during loading', () => {
      actor.loadSession('loading-session');
      expect(actor.getState()).toMatchSnapshot();
    });

    it('captures state with error', () => {
      actor.loadSession('error-session');

      actor.handleSessionError({
        error: 'Failed to load session: Network error'
      });

      expect(actor.getState()).toMatchSnapshot();
    });

    it('captures state after clear', () => {
      // Load a session first via handler method
      actor.handleSessionLoaded({
        sessionId: 'clear-me',
        title: 'To Be Cleared',
        model: 'deepseek-chat'
      });

      // Then clear it
      actor.clearSession();

      expect(actor.getState()).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="session"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});
