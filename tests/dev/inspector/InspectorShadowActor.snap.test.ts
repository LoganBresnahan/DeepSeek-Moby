/**
 * Snapshot tests for InspectorShadowActor
 *
 * Tests the rendered HTML structure of the inspector UI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InspectorShadowActor } from '../../../media/dev/inspector/InspectorShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('InspectorShadowActor Snapshots', () => {
  let manager: EventStateManager;
  let hostElement: HTMLElement;
  let actor: InspectorShadowActor;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    hostElement = document.createElement('div');
    hostElement.id = 'inspector-host';
    document.body.appendChild(hostElement);
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Panel structure', () => {
    it('renders panel with correct structure', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const panel = hostElement.shadowRoot?.querySelector('.inspector-panel');
      expect(panel?.innerHTML).toMatchSnapshot();
    });

    it('renders header section', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const header = hostElement.shadowRoot?.querySelector('.inspector-header');
      expect(header?.innerHTML).toMatchSnapshot();
    });

    it('renders toolbar section', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const toolbar = hostElement.shadowRoot?.querySelector('.inspector-toolbar');
      expect(toolbar?.innerHTML).toMatchSnapshot();
    });

    it('renders no-selection state', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const noSelection = hostElement.shadowRoot?.querySelector('.no-selection');
      expect(noSelection?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Selection state', () => {
    it('renders selection info with element path', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      // Create and select target
      const target = document.createElement('div');
      target.className = 'my-component';
      document.body.appendChild(target);

      // Enter inspect mode and select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'composedPath', {
        value: () => [target, document.body, document]
      });
      document.dispatchEvent(clickEvent);

      const selectionInfo = hostElement.shadowRoot?.querySelector('.selection-info');
      expect(selectionInfo?.innerHTML).toMatchSnapshot();
    });

    it('renders style controls', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const target = document.createElement('div');
      target.className = 'test-element';
      document.body.appendChild(target);

      // Select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'composedPath', {
        value: () => [target, document.body, document]
      });
      document.dispatchEvent(clickEvent);

      const styleControls = hostElement.shadowRoot?.querySelector('.style-controls');
      expect(styleControls?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Shadow DOM element selection', () => {
    it('renders shadow indicator for shadow DOM elements', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      // Create shadow DOM element
      const shadowHost = document.createElement('div');
      shadowHost.id = 'shadow-host';
      document.body.appendChild(shadowHost);

      const shadow = shadowHost.attachShadow({ mode: 'open' });
      const shadowElement = document.createElement('div');
      shadowElement.className = 'shadow-child';
      shadow.appendChild(shadowElement);

      // Select shadow element
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      const clickEvent = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(clickEvent, 'composedPath', {
        value: () => [shadowElement, shadow, shadowHost, document.body, document]
      });
      document.dispatchEvent(clickEvent);

      const elementPath = hostElement.shadowRoot?.querySelector('.element-path');
      expect(elementPath?.innerHTML).toMatchSnapshot();
    });
  });

  describe('Inspect mode states', () => {
    it('renders inspect button in default state', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn');
      expect(inspectBtn?.outerHTML).toMatchSnapshot();
    });

    it('renders inspect button in active state', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      expect(inspectBtn?.outerHTML).toMatchSnapshot();
    });
  });
});
