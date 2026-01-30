/**
 * Unit tests for SessionActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { SessionActor, VSCodeAPI } from '../../../media/actors/session/SessionActor';

describe('SessionActor', () => {
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
      postMessage: vi.fn(),
      getState: vi.fn(() => ({})),
      setState: vi.fn()
    };

    actor = new SessionActor(manager, element, mockVSCode);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('session-root-SessionActor')).toBe(true);
    });

    it('starts with default state', () => {
      const state = actor.getState();
      expect(state.id).toBe(null);
      expect(state.title).toBe('New Chat');
      expect(state.model).toBe('deepseek-chat');
      expect(state.loading).toBe(false);
      expect(state.error).toBe(null);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="session"]');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('createSession', () => {
    it('sets loading state', () => {
      actor.createSession();

      expect(actor.isLoading).toBe(true);
    });

    it('posts createSession message to VS Code', () => {
      actor.createSession('deepseek-reasoner');

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'createSession',
        model: 'deepseek-reasoner'
      });
    });

    it('uses current model if not specified', () => {
      actor.setModel('deepseek-reasoner');
      actor.createSession();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'createSession',
        model: 'deepseek-reasoner'
      });
    });
  });

  describe('loadSession', () => {
    it('sets loading state', () => {
      actor.loadSession('session-123');

      expect(actor.isLoading).toBe(true);
    });

    it('posts loadSession message to VS Code', () => {
      actor.loadSession('session-123');

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'loadSession',
        sessionId: 'session-123'
      });
    });
  });

  describe('clearSession', () => {
    it('resets session state', () => {
      // Simulate loaded session first
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'session-123',
          title: 'Test Session',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);

      actor.clearSession();

      expect(actor.sessionId).toBe(null);
      expect(actor.title).toBe('New Chat');
    });

    it('posts clearSession message to VS Code', () => {
      actor.clearSession();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'clearSession'
      });
    });
  });

  describe('renameSession', () => {
    it('does nothing if no session', () => {
      actor.renameSession('New Title');

      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('updates title and posts message', () => {
      // Load a session first
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'session-123',
          title: 'Old Title',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);

      actor.renameSession('New Title');

      expect(actor.title).toBe('New Title');
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'renameSession',
        sessionId: 'session-123',
        title: 'New Title'
      });
    });
  });

  describe('setModel', () => {
    it('updates model', () => {
      actor.setModel('deepseek-reasoner');

      expect(actor.model).toBe('deepseek-reasoner');
    });

    it('posts setModel message to VS Code', () => {
      actor.setModel('deepseek-reasoner');

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setModel',
        model: 'deepseek-reasoner'
      });
    });

    it('publishes model change', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');

      actor.setModel('deepseek-reasoner');

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'session.model': 'deepseek-reasoner'
          })
        })
      );
    });
  });

  describe('VS Code message handling', () => {
    it('handles sessionLoaded message', () => {
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'session-456',
          title: 'Loaded Session',
          model: 'deepseek-reasoner'
        }
      });
      window.dispatchEvent(event);

      expect(actor.sessionId).toBe('session-456');
      expect(actor.title).toBe('Loaded Session');
      expect(actor.model).toBe('deepseek-reasoner');
      expect(actor.isLoading).toBe(false);
    });

    it('handles sessionCreated message', () => {
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionCreated',
          sessionId: 'new-session-789',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);

      expect(actor.sessionId).toBe('new-session-789');
      expect(actor.title).toBe('New Chat');
      expect(actor.isLoading).toBe(false);
    });

    it('handles sessionError message', () => {
      actor.loadSession('bad-session');

      const event = new MessageEvent('message', {
        data: {
          type: 'sessionError',
          error: 'Session not found'
        }
      });
      window.dispatchEvent(event);

      expect(actor.isLoading).toBe(false);
      expect(actor.error).toBe('Session not found');
    });

    it('handles modelChanged message', () => {
      const event = new MessageEvent('message', {
        data: {
          type: 'modelChanged',
          model: 'deepseek-reasoner'
        }
      });
      window.dispatchEvent(event);

      expect(actor.model).toBe('deepseek-reasoner');
    });

    it('handles loadHistory message (sets loading false)', () => {
      actor.loadSession('session-123');
      expect(actor.isLoading).toBe(true);

      const event = new MessageEvent('message', {
        data: { type: 'loadHistory', messages: [] }
      });
      window.dispatchEvent(event);

      expect(actor.isLoading).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('does nothing if no session', () => {
      actor.deleteSession();

      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('posts deleteSession and clears state', () => {
      // Load session first
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'to-delete',
          title: 'Delete Me',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);

      actor.deleteSession();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'deleteSession',
        sessionId: 'to-delete'
      });
      expect(actor.sessionId).toBe(null);
    });
  });

  describe('exportSession', () => {
    it('does nothing if no session', () => {
      actor.exportSession('json');

      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
    });

    it('posts exportSession message', () => {
      // Load session first
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'export-me',
          title: 'Export Session',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);

      actor.exportSession('markdown');

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'exportSession',
        sessionId: 'export-me',
        format: 'markdown'
      });
    });
  });

  describe('getters', () => {
    it('provides sessionId getter', () => {
      expect(actor.sessionId).toBe(null);
    });

    it('provides title getter', () => {
      expect(actor.title).toBe('New Chat');
    });

    it('provides model getter', () => {
      expect(actor.model).toBe('deepseek-chat');
    });

    it('provides isLoading getter', () => {
      expect(actor.isLoading).toBe(false);
    });

    it('provides error getter', () => {
      expect(actor.error).toBe(null);
    });
  });
});
