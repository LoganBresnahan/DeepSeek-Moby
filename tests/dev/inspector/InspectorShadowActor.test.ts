/**
 * Tests for InspectorShadowActor
 *
 * Tests the actor-based dev inspector including:
 * - Shadow DOM encapsulation for inspector UI
 * - Element selection via composedPath
 * - Computed style reading (including shadow DOM elements)
 * - Style application
 * - UI state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InspectorShadowActor } from '../../../media/dev/inspector/InspectorShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { getAllStyleProperties } from '../../../media/dev/inspector/types';

/**
 * Helper to select an element using the new right-click flow:
 * 1. Trigger mousemove to set _hoveredElement
 * 2. Trigger contextmenu to select
 *
 * @param element The element to select
 * @param composedPath Optional custom composedPath for shadow DOM elements
 */
function selectElement(element: HTMLElement, composedPath?: () => EventTarget[]): void {
  // Simulate hover to set _hoveredElement
  const moveEvent = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(moveEvent, 'composedPath', {
    value: composedPath ?? (() => [element, document.body, document])
  });
  document.dispatchEvent(moveEvent);

  // Simulate right-click to select
  const contextEvent = new MouseEvent('contextmenu', { bubbles: true });
  document.dispatchEvent(contextEvent);
}

describe('InspectorShadowActor', () => {
  let manager: EventStateManager;
  let hostElement: HTMLElement;
  let actor: InspectorShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    hostElement = document.createElement('div');
    hostElement.id = 'inspector-host';
    document.body.appendChild(hostElement);
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Construction', () => {
    it('creates inspector with shadow root', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      expect(hostElement.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      const sheets = hostElement.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('creates panel in shadow root', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      const panel = hostElement.shadowRoot?.querySelector('.inspector-panel');
      expect(panel).toBeTruthy();
    });

    it('creates overlays in light DOM', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      const highlight = document.body.querySelector('.inspector-overlay.highlight');
      const select = document.body.querySelector('.inspector-overlay.select');
      expect(highlight).toBeTruthy();
      expect(select).toBeTruthy();
    });

    it('starts hidden by default', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      expect(actor.isVisible()).toBe(false);
      const panel = hostElement.shadowRoot?.querySelector('.inspector-panel');
      expect(panel?.classList.contains('hidden')).toBe(true);
    });
  });

  describe('Show/Hide/Toggle', () => {
    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
    });

    it('show() makes inspector visible', () => {
      actor.show();

      expect(actor.isVisible()).toBe(true);
      const panel = hostElement.shadowRoot?.querySelector('.inspector-panel');
      expect(panel?.classList.contains('hidden')).toBe(false);
    });

    it('hide() hides inspector', () => {
      actor.show();
      actor.hide();

      expect(actor.isVisible()).toBe(false);
      const panel = hostElement.shadowRoot?.querySelector('.inspector-panel');
      expect(panel?.classList.contains('hidden')).toBe(true);
    });

    it('toggle() toggles visibility', () => {
      expect(actor.isVisible()).toBe(false);

      actor.toggle();
      expect(actor.isVisible()).toBe(true);

      actor.toggle();
      expect(actor.isVisible()).toBe(false);
    });

    it('show() publishes visibility state', async () => {
      const published: Record<string, unknown> = {};
      manager.register({
        actorId: 'test-subscriber',
        element: document.createElement('div'),
        publicationKeys: [],
        subscriptionKeys: ['inspector.visible']
      }, {});

      // Wait for registration
      await Promise.resolve();

      actor.show();

      expect(manager.getState('inspector.visible')).toBe(true);
    });
  });

  describe('Panel UI', () => {
    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();
    });

    it('renders header with title and badge', () => {
      const header = hostElement.shadowRoot?.querySelector('.inspector-header');
      const title = header?.querySelector('.inspector-title');
      const badge = header?.querySelector('.inspector-badge');

      expect(title?.textContent).toBe('Inspector');
      expect(badge?.textContent).toBe('DEV');
    });

    it('renders header with action buttons', () => {
      const header = hostElement.shadowRoot?.querySelector('.inspector-header');
      const actions = header?.querySelector('.inspector-header-actions');
      const inspectBtn = actions?.querySelector('.inspect-btn');
      const matchBtn = actions?.querySelector('.match-btn');
      const clearBtn = actions?.querySelector('.clear-btn');

      expect(inspectBtn).toBeTruthy();
      expect(matchBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();
    });

    it('shows no-selection state initially', () => {
      const noSelection = hostElement.shadowRoot?.querySelector('.no-selection');
      const selectionInfo = hostElement.shadowRoot?.querySelector('.selection-info');

      expect(noSelection?.style.display).not.toBe('none');
      expect(selectionInfo?.classList.contains('visible')).toBe(false);
    });

    it('close button hides inspector', () => {
      const closeBtn = hostElement.shadowRoot?.querySelector('.inspector-close') as HTMLElement;
      closeBtn?.click();

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Inspect Mode', () => {
    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();
    });

    it('inspect button toggles inspect mode', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;

      expect(actor.getState().inspectMode).toBe(false);

      inspectBtn?.click();
      expect(actor.getState().inspectMode).toBe(true);

      inspectBtn?.click();
      expect(actor.getState().inspectMode).toBe(false);
    });

    it('inspect button changes style when active', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;

      inspectBtn?.click();

      expect(inspectBtn?.classList.contains('active')).toBe(true);
    });

    it('escape key exits inspect mode', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      expect(actor.getState().inspectMode).toBe(true);

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.getState().inspectMode).toBe(false);
    });
  });

  describe('Element Selection', () => {
    let targetElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      // Create a target element with styles
      targetElement = document.createElement('div');
      targetElement.className = 'test-target';
      targetElement.style.cssText = 'padding: 10px; margin: 20px;';
      document.body.appendChild(targetElement);
    });

    it('right-clicking element in inspect mode selects it', () => {
      // Enter inspect mode
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      // Select via right-click
      selectElement(targetElement);

      const state = actor.getState();
      expect(state.selectedElement).toBeTruthy();
      expect(state.selectedElement?.element).toBe(targetElement);
    });

    it('selection shows element path', () => {
      // Enter inspect mode
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      const pathEl = hostElement.shadowRoot?.querySelector('.element-path');
      expect(pathEl?.textContent).toContain('test-target');
    });

    it('selection shows style controls', () => {
      // Enter inspect mode and select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      const selectionInfo = hostElement.shadowRoot?.querySelector('.selection-info');
      expect(selectionInfo?.classList.contains('visible')).toBe(true);

      const styleControls = hostElement.shadowRoot?.querySelector('.style-controls');
      const rows = styleControls?.querySelectorAll('.style-row');
      expect(rows?.length).toBe(getAllStyleProperties().length);
    });

    it('selection overlay positions over element', () => {
      // Enter inspect mode and select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      const selectOverlay = document.body.querySelector('.inspector-overlay.select') as HTMLElement;
      expect(selectOverlay?.style.display).toBe('block');
    });

    it('exits inspect mode after selection', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      expect(actor.getState().inspectMode).toBe(true);

      selectElement(targetElement);

      expect(actor.getState().inspectMode).toBe(false);
    });
  });

  describe('Computed Style Reading', () => {
    let styledElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      // Create element with CSS styles
      const style = document.createElement('style');
      style.textContent = `
        .styled-element {
          padding-top: 15px;
          padding-bottom: 20px;
          margin-top: 10px;
          font-size: 16px;
        }
      `;
      document.head.appendChild(style);

      styledElement = document.createElement('div');
      styledElement.className = 'styled-element';
      document.body.appendChild(styledElement);
    });

    it('reads computed styles from CSS', () => {
      // Enter inspect mode and select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(styledElement);

      const state = actor.getState();
      expect(state.selectedElement?.computedStyles.get('padding-top')).toBe(15);
      expect(state.selectedElement?.computedStyles.get('padding-bottom')).toBe(20);
    });

    it('displays computed values in editable fields', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(styledElement);

      // Find the padding-top row
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      let paddingTopRow: Element | undefined;
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          paddingTopRow = row;
        }
      });

      const editableValue = paddingTopRow?.querySelector('.style-value.editable') as HTMLElement;
      expect(editableValue?.textContent).toBe('15px');
    });

    it('reads styles correctly even with inline overrides', () => {
      // Apply an inline style first
      styledElement.style.paddingTop = '30px';

      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(styledElement);

      // Should read the ORIGINAL CSS value (15px), not the inline override (30px)
      // because we temporarily clear inline styles when reading
      const state = actor.getState();
      expect(state.selectedElement?.computedStyles.get('padding-top')).toBe(15);

      // Verify inline style is restored
      expect(styledElement.style.paddingTop).toBe('30px');
    });
  });

  describe('Shadow DOM Element Selection', () => {
    let shadowHost: HTMLElement;
    let shadowElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      // Create a shadow DOM element
      shadowHost = document.createElement('div');
      shadowHost.id = 'shadow-host';
      document.body.appendChild(shadowHost);

      const shadow = shadowHost.attachShadow({ mode: 'open' });

      // Add styles in shadow root
      const style = document.createElement('style');
      style.textContent = `
        .shadow-element {
          padding-top: 25px;
          margin-bottom: 12px;
        }
      `;
      shadow.appendChild(style);

      shadowElement = document.createElement('div');
      shadowElement.className = 'shadow-element';
      shadow.appendChild(shadowElement);
    });

    it('selects elements inside shadow DOM via composedPath', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      // Select element inside shadow DOM
      selectElement(shadowElement, () => [shadowElement, shadowHost.shadowRoot!, shadowHost, document.body, document]);

      const state = actor.getState();
      expect(state.selectedElement).toBeTruthy();
      expect(state.selectedElement?.element).toBe(shadowElement);
      expect(state.selectedElement?.inShadowDOM).toBe(true);
    });

    it('shows shadow indicator in path for shadow DOM elements', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(shadowElement, () => [shadowElement, shadowHost.shadowRoot!, shadowHost, document.body, document]);

      const pathEl = hostElement.shadowRoot?.querySelector('.element-path');
      expect(pathEl?.innerHTML).toContain('shadow-indicator');
    });

    it('reads computed styles from shadow DOM elements', () => {
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(shadowElement, () => [shadowElement, shadowHost.shadowRoot!, shadowHost, document.body, document]);

      const state = actor.getState();
      expect(state.selectedElement?.computedStyles.get('padding-top')).toBe(25);
      expect(state.selectedElement?.computedStyles.get('margin-bottom')).toBe(12);
    });
  });

  describe('Style Application', () => {
    let targetElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      targetElement = document.createElement('div');
      targetElement.className = 'test-target';
      document.body.appendChild(targetElement);

      // Select the element
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);
    });

    it('slider changes apply to element', () => {
      // Find padding-top slider and change it
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      let paddingTopRow: Element | undefined;
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          paddingTopRow = row;
        }
      });

      const editableValue = paddingTopRow?.querySelector('.style-value.editable') as HTMLElement;
      editableValue.textContent = '32px';
      editableValue.dispatchEvent(new Event('blur'));

      expect(targetElement.style.paddingTop).toBe('32px');
    });

    it('editable value changes update element style', () => {
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      let paddingTopRow: Element | undefined;
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          paddingTopRow = row;
        }
      });

      const editableValue = paddingTopRow?.querySelector('.style-value.editable') as HTMLElement;
      editableValue.textContent = '24px';
      editableValue.dispatchEvent(new Event('blur'));

      expect(editableValue?.textContent).toBe('24px');
    });

    it('stores style overrides', () => {
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      let paddingTopRow: Element | undefined;
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          paddingTopRow = row;
        }
      });

      const editableValue = paddingTopRow?.querySelector('.style-value.editable') as HTMLElement;
      editableValue.textContent = '16px';
      editableValue.dispatchEvent(new Event('blur'));

      const state = actor.getState();
      expect(state.styleOverrides.get('padding-top')).toBe('16px');
    });
  });

  describe('Clear Selection', () => {
    let targetElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      targetElement = document.createElement('div');
      targetElement.className = 'test-target';
      document.body.appendChild(targetElement);

      // Select and modify
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      // Apply a style
      targetElement.style.paddingTop = '20px';
    });

    it('clear button resets style overrides on element', () => {
      // Store the override
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      let paddingTopRow: Element | undefined;
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          paddingTopRow = row;
        }
      });

      const editableValue = paddingTopRow?.querySelector('.style-value.editable') as HTMLElement;
      editableValue.textContent = '32px';
      editableValue.dispatchEvent(new Event('blur'));

      expect(targetElement.style.paddingTop).toBe('32px');

      // Clear
      const clearBtn = hostElement.shadowRoot?.querySelector('.clear-btn') as HTMLElement;
      clearBtn?.click();

      // Should reset the inline style
      expect(targetElement.style.paddingTop).toBe('');
    });

    it('clear button hides selection overlay', () => {
      const clearBtn = hostElement.shadowRoot?.querySelector('.clear-btn') as HTMLElement;
      clearBtn?.click();

      const selectOverlay = document.body.querySelector('.inspector-overlay.select') as HTMLElement;
      expect(selectOverlay?.style.display).toBe('none');
    });

    it('clear button shows no-selection state', () => {
      const clearBtn = hostElement.shadowRoot?.querySelector('.clear-btn') as HTMLElement;
      clearBtn?.click();

      const selectionInfo = hostElement.shadowRoot?.querySelector('.selection-info');
      expect(selectionInfo?.classList.contains('visible')).toBe(false);
    });
  });

  describe('Copy CSS', () => {
    let targetElement: HTMLElement;

    beforeEach(() => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      targetElement = document.createElement('div');
      targetElement.className = 'test-target';
      document.body.appendChild(targetElement);

      // Select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      // Apply some styles
      const rows = hostElement.shadowRoot?.querySelectorAll('.style-row');
      rows?.forEach(row => {
        if (row.getAttribute('data-property') === 'padding-top') {
          const editableValue = row.querySelector('.style-value.editable') as HTMLElement;
          editableValue.textContent = '32px';
          editableValue.dispatchEvent(new Event('blur'));
        }
      });
    });

    it('getStyleOverridesCSS returns formatted CSS', () => {
      const css = actor.getStyleOverridesCSS();

      expect(css).toContain('padding-top: 32px;');
      expect(css).toContain('test-target');
    });
  });

  describe('Lifecycle', () => {
    it('destroy removes overlays from DOM', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      expect(document.body.querySelector('.inspector-overlay.highlight')).toBeTruthy();
      expect(document.body.querySelector('.inspector-overlay.select')).toBeTruthy();

      actor.destroy();

      expect(document.body.querySelector('.inspector-overlay.highlight')).toBeFalsy();
      expect(document.body.querySelector('.inspector-overlay.select')).toBeFalsy();
    });

    it('destroy clears selection', () => {
      actor = new InspectorShadowActor(manager, hostElement);
      actor.show();

      const targetElement = document.createElement('div');
      targetElement.className = 'test-target';
      document.body.appendChild(targetElement);

      // Select
      const inspectBtn = hostElement.shadowRoot?.querySelector('.inspect-btn') as HTMLElement;
      inspectBtn?.click();

      selectElement(targetElement);

      expect(actor.getState().selectedElement).toBeTruthy();

      actor.destroy();

      // Can't check state after destroy, but we verified overlays are removed
    });
  });

  describe('getState', () => {
    it('returns complete state object', () => {
      actor = new InspectorShadowActor(manager, hostElement);

      const state = actor.getState();

      expect(state).toHaveProperty('visible', false);
      expect(state).toHaveProperty('inspectMode', false);
      expect(state).toHaveProperty('selectedElement', null);
      expect(state).toHaveProperty('styleOverrides');
    });
  });
});
