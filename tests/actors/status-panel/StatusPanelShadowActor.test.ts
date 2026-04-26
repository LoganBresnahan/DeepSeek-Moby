/**
 * Tests for StatusPanelShadowActor
 *
 * Tests Shadow DOM encapsulation, Moby animation,
 * status messages, and separator dragging.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusPanelShadowActor } from '../../../media/actors/status-panel/StatusPanelShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('StatusPanelShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StatusPanelShadowActor;
  let mockVscode: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'status-panel-container';
    document.body.appendChild(element);
    mockVscode = { postMessage: vi.fn() };
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders status panel structure', () => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);

      expect(element.shadowRoot?.querySelector('.status-panel')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.moby')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.logs-btn')).toBeTruthy();
    });

    it('uses provided moby image URL', () => {
      actor = new StatusPanelShadowActor(manager, element, '/path/to/moby.png', mockVscode);

      const moby = element.shadowRoot?.querySelector('.moby img') as HTMLImageElement;
      expect(moby?.src).toContain('/path/to/moby.png');
    });
  });

  describe('Status messages', () => {
    beforeEach(() => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
    });

    it('shows status message', () => {
      actor.showMessage('Processing...');

      const messages = element.shadowRoot?.querySelector('.messages');
      expect(messages?.textContent).toContain('Processing...');
    });

    it('shows warning message', () => {
      actor.showWarning('Something might be wrong');

      const warnings = element.shadowRoot?.querySelector('.warnings');
      expect(warnings?.textContent).toContain('Something might be wrong');
    });

    it('shows error message', () => {
      actor.showError('Something went wrong');

      const warnings = element.shadowRoot?.querySelector('.warnings');
      expect(warnings?.textContent).toContain('Something went wrong');
    });

    it('clears message', () => {
      actor.showMessage('Temporary');
      actor.clearMessage();

      const messages = element.shadowRoot?.querySelector('.messages');
      expect(messages?.textContent).toBe('');
    });

    it('clears warning', () => {
      actor.showWarning('Temporary warning');
      actor.clearWarning();

      const warnings = element.shadowRoot?.querySelector('.warnings');
      expect(warnings?.textContent).toBe('');
    });
  });

  describe('Moby animation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
    });

    it('shows blue moby by default', () => {
      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('spurt-yellow')).toBe(false);
      expect(moby?.classList.contains('spurt-red')).toBe(false);
    });

    it('shows yellow moby on warning', () => {
      actor.showWarning('Warning!');

      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('spurt-yellow')).toBe(true);
    });

    it('shows red moby on error', () => {
      actor.showError('Error!');

      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('spurt-red')).toBe(true);
    });

    it('plays spurt animation on message', () => {
      actor.showMessage('New message');

      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('spurting')).toBe(true);

      vi.advanceTimersByTime(700);
      expect(moby?.classList.contains('spurting')).toBe(false);
    });
  });

  describe('Logs button', () => {
    beforeEach(() => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
    });

    it('calls onLogs handler when clicked', () => {
      const handler = vi.fn();
      actor.onLogs(handler);

      const logsBtn = element.shadowRoot?.querySelector('.logs-btn') as HTMLButtonElement;
      logsBtn.click();

      expect(handler).toHaveBeenCalled();
    });

    it('posts showLogs message to vscode', () => {
      const logsBtn = element.shadowRoot?.querySelector('.logs-btn') as HTMLButtonElement;
      logsBtn.click();

      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'showLogs' });
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
    });

    it('returns current state', () => {
      actor.showMessage('Test message');
      actor.showWarning('Test warning');

      const state = actor.getState();

      expect(state.message).toBe('Test message');
      // Warning clears error and vice versa, so warning should be empty after showWarning clears message slot
      // Actually warning sets _warning and clears _error
      expect(state.warning).toBe('Test warning');
      expect(state.error).toBe('');
    });

    it('error replaces warning', () => {
      actor.showWarning('Warning');
      actor.showError('Error');

      const state = actor.getState();
      expect(state.warning).toBe('');
      expect(state.error).toBe('Error');
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
      actor.showMessage('Test');

      actor.destroy();

      // Should clear shadow content
      expect(element.shadowRoot?.innerHTML).toBe('');
    });
  });

  // Phase 3.5 regression locks: the activity-label / activity-streaming
  // subscriptions are how the orchestrator surfaces "what is the model
  // doing right now?" to the UI. Two distinct issues we hit on the way
  // in:
  //   1. The publication keys ('activity.streaming' / 'activity.label')
  //      had to be declared in the actor's publications map. Missing
  //      declarations meant publishDirect silently dropped the broadcast.
  //   2. setActivity null/string semantics — setting null must clear the
  //      label AND restore the message slot's visibility.
  describe('Activity indicator (Phase 3.5)', () => {
    beforeEach(() => {
      actor = new StatusPanelShadowActor(manager, element, 'moby.png', mockVscode);
    });

    it('shows activity label when activity.label publishes a string', () => {
      manager.publishDirect('activity.label', 'Writing src/foo.ts');
      const label = element.shadowRoot?.querySelector('.activity-text');
      expect(label?.textContent).toBe('Writing src/foo.ts');
      expect(label?.classList.contains('visible')).toBe(true);
    });

    it('hides activity label when activity.label publishes null', () => {
      manager.publishDirect('activity.label', 'Working');
      manager.publishDirect('activity.label', null);
      const label = element.shadowRoot?.querySelector('.activity-text');
      expect(label?.textContent).toBe('');
      expect(label?.classList.contains('visible')).toBe(false);
    });

    it('suppresses the messages slot while an activity label is showing', () => {
      manager.publishDirect('activity.label', 'Working');
      const messages = element.shadowRoot?.querySelector('.messages');
      expect(messages?.classList.contains('suppressed')).toBe(true);
    });

    it('restores messages slot visibility when activity is cleared', () => {
      manager.publishDirect('activity.label', 'Working');
      manager.publishDirect('activity.label', null);
      const messages = element.shadowRoot?.querySelector('.messages');
      expect(messages?.classList.contains('suppressed')).toBe(false);
    });

    it('adds activity-active + spurt-blue when streaming flag is set true', () => {
      manager.publishDirect('activity.streaming', true);
      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('activity-active')).toBe(true);
      expect(moby?.classList.contains('spurt-blue')).toBe(true);
    });

    it('removes activity-active when streaming flag is set false', () => {
      manager.publishDirect('activity.streaming', true);
      manager.publishDirect('activity.streaming', false);
      const moby = element.shadowRoot?.querySelector('.moby');
      expect(moby?.classList.contains('activity-active')).toBe(false);
    });

    it('overrides yellow/red spurts with blue when streaming starts', () => {
      // Simulate a warning/error spurt already in progress, then a stream begins.
      const moby = element.shadowRoot?.querySelector('.moby') as HTMLElement;
      moby.classList.add('spurt-yellow');
      manager.publishDirect('activity.streaming', true);
      expect(moby.classList.contains('spurt-yellow')).toBe(false);
      expect(moby.classList.contains('spurt-blue')).toBe(true);
    });
  });
});
