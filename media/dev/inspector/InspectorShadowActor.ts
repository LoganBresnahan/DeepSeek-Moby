/**
 * InspectorShadowActor
 *
 * UI inspection tool for real-time style adjustment and debugging.
 * Uses Shadow DOM for its own UI to avoid style conflicts with the app being inspected.
 *
 * Key features:
 * - Properly handles elements inside other Shadow DOMs via composedPath()
 * - Correctly reads computed styles by temporarily removing inline overrides
 * - Stores and can export CSS overrides for permanent application
 * - Chrome DevTools-style inline CSS editing
 *
 * NOTE: This tool intentionally accesses other actors' shadow roots
 * for inspection purposes, which violates the normal "no cross-shadow queries" rule.
 * This is acceptable because its purpose is specifically to debug/inspect the UI.
 */

import { EventStateActor } from '../../state/EventStateActor';
import { EventStateManager } from '../../state/EventStateManager';
import { inspectorShadowStyles } from './shadowStyles';
import {
  StyleProperty,
  StyleCategory,
  InspectedElement,
  InspectorState,
  STYLE_CATEGORIES,
  getAllStyleProperties
} from './types';

export class InspectorShadowActor extends EventStateActor {
  // Shadow DOM for inspector UI
  private shadow: ShadowRoot;
  private panel: HTMLElement;
  private highlightOverlay: HTMLElement;
  private selectOverlay: HTMLElement;

  // Inspector state
  private _visible = false;
  private _inspectMode = false;
  private _selectedElement: InspectedElement | null = null;
  private _styleOverrides: Map<string, string> = new Map();
  private _expandedCategories: Set<string> = new Set(['spacing']); // Start with spacing open
  private _customProperties: StyleProperty[] = [];

  // Multi-element mode: apply styles to all elements with matching classes
  private _applyToMatching = true;
  private _matchingElements: HTMLElement[] = [];
  private _siblingOverlays: HTMLElement[] = [];

  // History of all changes (persists across element selections)
  private _changeHistory: Array<{
    element: HTMLElement;
    path: string;
    overrides: Map<string, string>;
  }> = [];

  // Dragging state
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };

  // Resizing state
  private isResizing = false;
  private resizeStart = { x: 0, y: 0, width: 0, height: 0 };

  // Currently hovered element (for right-click/keyboard selection)
  private _hoveredElement: HTMLElement | null = null;

  // Bound handlers for cleanup
  private boundHandleMouseMove: (e: MouseEvent) => void;
  private boundHandleMouseUp: () => void;
  private boundHandleContextMenu: (e: MouseEvent) => void;
  private boundHandleKeyDown: (e: KeyboardEvent) => void;
  private boundHandleScroll: () => void;

  constructor(manager: EventStateManager, element: HTMLElement) {
    super({
      manager,
      element,
      publications: {
        'inspector.visible': () => this._visible,
        'inspector.inspectMode': () => this._inspectMode,
        'inspector.hasSelection': () => this._selectedElement !== null
      },
      subscriptions: {},
      enableDOMChangeDetection: false
    });

    // Create shadow root for inspector UI
    this.shadow = this.element.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = inspectorShadowStyles;
    this.shadow.appendChild(style);

    // Create overlays (in light DOM so they cover everything)
    this.highlightOverlay = this.createOverlay('highlight');
    this.selectOverlay = this.createOverlay('select');
    document.body.appendChild(this.highlightOverlay);
    document.body.appendChild(this.selectOverlay);

    // Create panel (in shadow DOM)
    this.panel = this.createPanel();
    this.shadow.appendChild(this.panel);

    // Bind event handlers
    this.boundHandleMouseMove = this.handleMouseMove.bind(this);
    this.boundHandleMouseUp = this.handleMouseUp.bind(this);
    this.boundHandleContextMenu = this.handleContextMenu.bind(this);
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleScroll = this.handleScroll.bind(this);

    // Set up document-level event listeners
    this.bindGlobalEvents();

    console.log('[InspectorShadowActor] Ready');
  }

  // ============================================
  // UI Creation
  // ============================================

  private createOverlay(type: 'highlight' | 'select' | 'sibling'): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = `inspector-overlay ${type}`;

    const styles: Record<string, string> = {
      highlight: 'border: 2px dashed rgba(59, 142, 234, 0.8); background: rgba(59, 142, 234, 0.1);',
      select: 'border: 2px solid #3b8eea; background: rgba(59, 142, 234, 0.15);',
      sibling: 'border: 2px dashed rgba(134, 179, 0, 0.8); background: rgba(134, 179, 0, 0.1);'
    };

    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 999997;
      display: none;
      ${styles[type]}
    `;
    return overlay;
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'inspector-panel hidden';
    panel.innerHTML = `
      <div class="inspector-header">
        <div class="inspector-header-left">
          <span class="inspector-icon">🎯</span>
          <span class="inspector-title">Inspector</span>
          <span class="inspector-badge">DEV</span>
        </div>
        <div class="inspector-header-actions">
          <button class="inspect-btn header-btn" title="Select element (right-click)">
            <span>🎯</span> Select
          </button>
          <button class="match-btn header-btn active" title="Apply to all matching elements">All</button>
          <button class="clear-btn header-btn" title="Clear selection">Clear</button>
        </div>
        <button class="inspector-close">×</button>
      </div>

      <div class="inspector-body">
        <div class="no-selection">
          <div class="no-selection-icon">👆</div>
          <div class="no-selection-text">
            Click "Select" then<br>right-click any element
          </div>
        </div>
        <div class="selection-info">
          <div class="element-path"></div>
          <div class="box-model collapsed">
            <div class="box-model-header">
              <span class="box-model-toggle">▶</span>
              <span class="box-model-label">Box Model</span>
            </div>
            <div class="box-model-diagram">
              <div class="box-margin">
                <span class="box-value margin-top">0</span>
                <span class="box-value margin-right">0</span>
                <span class="box-value margin-bottom">0</span>
                <span class="box-value margin-left">0</span>
                <span class="box-label margin-label">margin</span>
                <div class="box-border">
                  <span class="box-value border-top">0</span>
                  <span class="box-value border-right">0</span>
                  <span class="box-value border-bottom">0</span>
                  <span class="box-value border-left">0</span>
                  <span class="box-label border-label">border</span>
                  <div class="box-padding">
                    <span class="box-value padding-top">0</span>
                    <span class="box-value padding-right">0</span>
                    <span class="box-value padding-bottom">0</span>
                    <span class="box-value padding-left">0</span>
                    <span class="box-label padding-label">padding</span>
                    <div class="box-content">
                      <span class="content-size">0 × 0</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="style-controls"></div>
          <div class="history-section">
            <div class="history-header">
              <span class="history-title">Changes Made:</span>
              <button class="copy-history-btn" title="Copy all changes as CSS">📋</button>
            </div>
            <div class="history-list">
              <div class="history-empty">No changes yet</div>
            </div>
          </div>
        </div>
      </div>
      <div class="resize-handle"></div>
    `;

    // Bind panel events
    this.bindPanelEvents(panel);

    return panel;
  }

  private bindPanelEvents(panel: HTMLElement): void {
    // Event isolation: prevent clicks inside the inspector from affecting the page
    // This stops inspector interactions from closing popups/dropdowns being inspected
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('mouseup', (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    panel.addEventListener('pointerup', (e) => e.stopPropagation());

    // Close button
    panel.querySelector('.inspector-close')?.addEventListener('click', () => {
      this.hide();
    });

    // Inspect mode toggle
    panel.querySelector('.inspect-btn')?.addEventListener('click', () => {
      this.toggleInspectMode();
    });

    // Clear button
    panel.querySelector('.clear-btn')?.addEventListener('click', () => {
      this.clearSelection();
    });

    // Match toggle button
    panel.querySelector('.match-btn')?.addEventListener('click', () => {
      this.toggleMatchMode();
    });

    // Copy history button
    panel.querySelector('.copy-history-btn')?.addEventListener('click', () => {
      this.copyHistoryToClipboard();
    });

    // Box model toggle
    panel.querySelector('.box-model-header')?.addEventListener('click', () => {
      const boxModel = panel.querySelector('.box-model') as HTMLElement;
      const toggle = panel.querySelector('.box-model-toggle') as HTMLElement;
      if (boxModel && toggle) {
        boxModel.classList.toggle('collapsed');
        toggle.textContent = boxModel.classList.contains('collapsed') ? '▶' : '▼';
      }
    });

    // Header dragging
    const header = panel.querySelector('.inspector-header') as HTMLElement;
    header?.addEventListener('mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.startDrag(e);
    });

    // Resize handle
    const resizeHandle = panel.querySelector('.resize-handle') as HTMLElement;
    resizeHandle?.addEventListener('mousedown', (e: MouseEvent) => {
      this.startResize(e);
    });
  }

  private bindGlobalEvents(): void {
    document.addEventListener('mousemove', this.boundHandleMouseMove);
    document.addEventListener('mouseup', this.boundHandleMouseUp);
    // Note: contextmenu listener is added/removed dynamically in toggleInspectMode()
    // Right-click to select elements (doesn't interfere with normal UI)
    document.addEventListener('keydown', this.boundHandleKeyDown);
    // Listen for scroll on capture phase to catch scrolling in any container
    document.addEventListener('scroll', this.boundHandleScroll, { capture: true, passive: true });
    window.addEventListener('scroll', this.boundHandleScroll, { passive: true });
  }

  // ============================================
  // Event Handlers
  // ============================================

  private handleMouseMove(e: MouseEvent): void {
    // Early exit if inspector is not visible - no interference with app
    if (!this._visible && !this.isDragging && !this.isResizing) return;

    // Handle dragging
    if (this.isDragging) {
      this.panel.style.left = `${e.clientX - this.dragOffset.x}px`;
      this.panel.style.top = `${e.clientY - this.dragOffset.y}px`;
      this.panel.style.right = 'auto';
      return;
    }

    // Handle resizing (bottom-right corner)
    if (this.isResizing) {
      // For bottom-right: dragging right (positive deltaX) increases width
      const deltaX = e.clientX - this.resizeStart.x;
      const deltaY = e.clientY - this.resizeStart.y;

      const newWidth = Math.max(250, Math.min(600, this.resizeStart.width + deltaX));
      const newHeight = Math.max(200, Math.min(800, this.resizeStart.height + deltaY));

      this.panel.style.width = `${newWidth}px`;
      this.panel.style.maxHeight = `${newHeight}px`;
      return;
    }

    // Handle inspect mode hover
    if (this._inspectMode) {
      this.handleHover(e);
    }
  }

  private handleMouseUp(): void {
    // Only process if actively dragging/resizing
    if (!this.isDragging && !this.isResizing) return;

    if (this.isDragging) {
      this.isDragging = false;
      document.body.style.userSelect = '';
    }
    if (this.isResizing) {
      this.isResizing = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
  }

  private handleContextMenu(e: MouseEvent): void {
    if (!this._inspectMode || !this._hoveredElement) return;

    // Prevent native context menu
    e.preventDefault();

    // Debug: log what we're selecting
    console.log('[Inspector] Right-click selecting:', this._hoveredElement.tagName.toLowerCase() +
      (this._hoveredElement.className ? '.' + this._hoveredElement.className.split(' ')[0] : ''));

    this.selectElement(this._hoveredElement);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Only handle keyboard when in inspect mode - no interference otherwise
    if (!this._inspectMode) return;

    if (e.key === 'Escape') {
      this.toggleInspectMode();
      return;
    }

    // Enter or Space selects hovered element
    if (this._hoveredElement && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.selectElement(this._hoveredElement);
    }
  }

  private handleScroll(): void {
    // Only update overlays when inspector is visible with selection - no interference otherwise
    if (!this._visible || !this._selectedElement) return;

    // Update overlay positions when page scrolls
    if (this._selectedElement.element.isConnected) {
      this.positionOverlay(this.selectOverlay, this._selectedElement.element);

      // Update sibling overlays
      this._matchingElements.forEach((el, idx) => {
        if (el.isConnected && this._siblingOverlays[idx]) {
          this.positionOverlay(this._siblingOverlays[idx], el);
        }
      });
    }
  }

  private handleHover(e: MouseEvent): void {
    // Get actual element from composedPath
    const actualTarget = e.composedPath()[0] as HTMLElement;

    // Skip if hovering over inspector
    if (this.isInspectorElement(actualTarget)) {
      this._hoveredElement = null;
      this.highlightOverlay.style.display = 'none';
      return;
    }

    const target = this.findInspectableElement(actualTarget);
    if (target) {
      this._hoveredElement = target;
      this.positionOverlay(this.highlightOverlay, target);
      this.highlightOverlay.style.display = 'block';
    } else {
      this._hoveredElement = null;
      this.highlightOverlay.style.display = 'none';
    }
  }

  private startDrag(e: MouseEvent): void {
    this.isDragging = true;
    const rect = this.panel.getBoundingClientRect();
    this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    document.body.style.userSelect = 'none';
  }

  private startResize(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.isResizing = true;
    const rect = this.panel.getBoundingClientRect();
    this.resizeStart = {
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nwse-resize';
  }

  // ============================================
  // Element Selection
  // ============================================

  private isInspectorElement(el: HTMLElement): boolean {
    // Check if element is part of inspector UI
    if (this.element.contains(el)) return true;
    if (this.highlightOverlay.contains(el)) return true;
    if (this.selectOverlay.contains(el)) return true;

    // Check if element is in our shadow root
    let current: Node | null = el;
    while (current) {
      if (current === this.shadow) return true;
      current = (current as Element).parentNode || (current as ShadowRoot).host;
    }

    return false;
  }

  private findInspectableElement(el: HTMLElement): HTMLElement | null {
    // Skip inspector elements
    if (this.isInspectorElement(el)) {
      return null;
    }

    // Simple approach: return exactly what was clicked
    // Don't try to walk up to find "better" elements - user clicked what they want
    if (el !== document.body && el !== document.documentElement) {
      return el;
    }

    return null;
  }

  private selectElement(el: HTMLElement): void {
    const target = this.findInspectableElement(el);
    if (!target) return;

    // Exit inspect mode
    this.toggleInspectMode();

    // Determine if element is in shadow DOM
    const shadowInfo = this.getShadowInfo(target);

    // Build inspected element info
    this._selectedElement = {
      element: target,
      path: this.getElementPath(target),
      inShadowDOM: shadowInfo.inShadow,
      shadowRoot: shadowInfo.root,
      computedStyles: this.readComputedStyles(target)
    };

    // Show selection overlay
    this.positionOverlay(this.selectOverlay, target);
    this.selectOverlay.style.display = 'block';

    // Find and highlight matching elements if mode is enabled
    this.findAndHighlightMatchingElements();

    // Update UI
    this.updateSelectionUI();

    this.publish({
      'inspector.hasSelection': true
    });

    console.log('[InspectorShadowActor] Selected:', this._selectedElement.path,
      'inShadow:', shadowInfo.inShadow,
      'classes:', Array.from(target.classList),
      'styles:', Object.fromEntries(this._selectedElement.computedStyles));
  }

  /**
   * Determine if an element is inside a shadow DOM and get its root.
   */
  private getShadowInfo(el: HTMLElement): { inShadow: boolean; root: ShadowRoot | null } {
    let current: Node | null = el;

    while (current) {
      if (current instanceof ShadowRoot) {
        return { inShadow: true, root: current };
      }
      current = current.parentNode;
    }

    return { inShadow: false, root: null };
  }

  /**
   * Read computed styles from an element.
   * Handles both light DOM and shadow DOM elements.
   *
   * KEY FIX: We temporarily clear any inline styles we previously applied
   * to read the original CSS values, then restore them.
   */
  private readComputedStyles(target: HTMLElement): Map<string, number> {
    const styles = new Map<string, number>();
    const allProperties = getAllStyleProperties();

    // Step 1: Save any inline styles we may have applied
    const savedInlineStyles = new Map<string, string>();
    allProperties.forEach(prop => {
      const camelProp = this.toCamelCase(prop.cssProperty);
      const currentInline = (target.style as Record<string, string>)[camelProp];
      if (currentInline) {
        savedInlineStyles.set(prop.cssProperty, currentInline);
        // Temporarily clear inline style
        (target.style as Record<string, string>)[camelProp] = '';
      }
    });

    // Also check custom properties
    this._customProperties.forEach(prop => {
      const camelProp = this.toCamelCase(prop.cssProperty);
      const currentInline = (target.style as Record<string, string>)[camelProp];
      if (currentInline) {
        savedInlineStyles.set(prop.cssProperty, currentInline);
        (target.style as Record<string, string>)[camelProp] = '';
      }
    });

    // Step 2: Read computed styles (now without our inline overrides)
    // This works for both light DOM and shadow DOM elements
    const computed = getComputedStyle(target);

    allProperties.forEach(prop => {
      const rawValue = computed.getPropertyValue(prop.cssProperty);
      const parsed = parseFloat(rawValue);

      let numValue: number;
      if (!isNaN(parsed)) {
        numValue = parsed;
      } else if (prop.cssProperty === 'line-height' && rawValue === 'normal') {
        // line-height: normal is typically ~1.2 based on font
        numValue = 1.4;
      } else if (prop.cssProperty === 'font-weight' && rawValue === 'normal') {
        numValue = 400;
      } else if (prop.cssProperty === 'font-weight' && rawValue === 'bold') {
        numValue = 700;
      } else {
        numValue = prop.defaultValue;
      }

      // Clamp to slider range
      numValue = Math.max(prop.min, Math.min(prop.max, numValue));
      styles.set(prop.cssProperty, numValue);
    });

    // Also read custom properties
    this._customProperties.forEach(prop => {
      const rawValue = computed.getPropertyValue(prop.cssProperty);
      const parsed = parseFloat(rawValue);
      const numValue = !isNaN(parsed) ? Math.max(prop.min, Math.min(prop.max, parsed)) : prop.defaultValue;
      styles.set(prop.cssProperty, numValue);
    });

    // Step 3: Restore inline styles
    savedInlineStyles.forEach((value, prop) => {
      const camelProp = this.toCamelCase(prop);
      (target.style as Record<string, string>)[camelProp] = value;
    });

    return styles;
  }

  private positionOverlay(overlay: HTMLElement, target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  private getElementPath(el: HTMLElement): string {
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    let depth = 0;

    while (current && current !== document.body && depth < 3) {
      let part = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const mainClass = current.className.split(' ')[0];
        if (mainClass) part += `.${mainClass}`;
      }
      parts.unshift(part);

      // Check if we're crossing a shadow boundary
      const parent = current.parentNode;
      if (parent instanceof ShadowRoot) {
        // Mark shadow boundary and continue to host
        parts.unshift('[shadow]');
        current = parent.host as HTMLElement;
      } else {
        current = current.parentElement;
      }
      depth++;
    }

    return parts.join(' > ');
  }

  // ============================================
  // UI Updates
  // ============================================

  private updateSelectionUI(): void {
    const noSelection = this.panel.querySelector('.no-selection') as HTMLElement;
    const selectionInfo = this.panel.querySelector('.selection-info') as HTMLElement;

    if (!this._selectedElement) {
      noSelection.style.display = 'block';
      selectionInfo.classList.remove('visible');
      return;
    }

    noSelection.style.display = 'none';
    selectionInfo.classList.add('visible');

    // Update path
    const pathEl = this.panel.querySelector('.element-path') as HTMLElement;
    if (this._selectedElement.inShadowDOM) {
      pathEl.innerHTML = `<span class="shadow-indicator">⚡</span> ${this._selectedElement.path}`;
    } else {
      pathEl.textContent = this._selectedElement.path;
    }

    // Update box model visualization
    this.updateBoxModel();

    // Build style controls
    this.buildStyleControls();
  }

  private buildStyleControls(): void {
    if (!this._selectedElement) return;

    const container = this.panel.querySelector('.style-controls') as HTMLElement;
    container.innerHTML = '';

    // Render each category as a collapsible section
    STYLE_CATEGORIES.forEach(category => {
      const section = this.buildCategorySection(category);
      container.appendChild(section);
    });

    // Render custom properties section
    const customSection = this.buildCustomSection();
    container.appendChild(customSection);
  }

  private buildCategorySection(category: StyleCategory): HTMLElement {
    const isExpanded = this._expandedCategories.has(category.id);

    // Count properties that have non-default values
    const activeCount = category.properties.filter(prop => {
      const value = this._selectedElement?.computedStyles.get(prop.cssProperty);
      const hasOverride = this._styleOverrides.has(prop.cssProperty);
      return hasOverride || (value !== undefined && value !== prop.defaultValue && value !== 0);
    }).length;

    const section = document.createElement('div');
    section.className = `style-category${isExpanded ? ' expanded' : ''}`;
    section.setAttribute('data-category', category.id);

    // Category header - only show count badge if there are active properties
    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-toggle">${isExpanded ? '▼' : '▶'}</span>
      <span class="category-icon">${category.icon}</span>
      <span class="category-name">${category.name}</span>
      ${activeCount > 0 ? `<span class="category-count">${activeCount}</span>` : ''}
    `;

    header.addEventListener('click', () => {
      this.toggleCategory(category.id);
    });

    section.appendChild(header);

    // Category body (property sliders)
    const body = document.createElement('div');
    body.className = 'category-body';

    category.properties.forEach(prop => {
      const row = this.buildPropertyRow(prop);
      body.appendChild(row);
    });

    section.appendChild(body);

    return section;
  }

  private buildPropertyRow(prop: StyleProperty): HTMLElement {
    const hasPresets = prop.presets && prop.presets.length > 0;

    // Determine display value - check for string overrides first (for colors and custom values)
    let displayValue: string;
    const stringOverride = this._styleOverrides.get(prop.cssProperty);
    if (stringOverride) {
      displayValue = stringOverride;
    } else if (prop.isColor && this._selectedElement) {
      // For color properties, read computed value as string
      const computed = getComputedStyle(this._selectedElement.element);
      displayValue = computed.getPropertyValue(prop.cssProperty).trim() || '';
    } else {
      const value = this._selectedElement?.computedStyles.get(prop.cssProperty) ?? prop.defaultValue;
      // Show blank for default/zero values instead of "0px"
      if (value === prop.defaultValue || value === 0) {
        displayValue = '';
      } else {
        displayValue = `${value}${prop.unit || ''}`;
      }
    }

    const row = document.createElement('div');
    row.className = 'style-row';
    row.setAttribute('data-property', prop.cssProperty);

    // Build preset dropdown menu if presets exist
    const presetDropdown = hasPresets ? `
      <div class="preset-dropdown" data-prop="${prop.cssProperty}">
        ${prop.presets!.map(preset => `
          <button class="preset-option" data-preset="${preset}">${preset}</button>
        `).join('')}
      </div>
    ` : '';

    // Chrome DevTools style: property: [editable value] ▼
    row.innerHTML = `
      <label class="style-label">${prop.name}:</label>
      <span class="style-value editable"
            contenteditable="true"
            data-prop="${prop.cssProperty}"
            data-unit="${prop.unit || ''}">${displayValue}</span>
      ${hasPresets ? `<button class="preset-trigger" data-prop="${prop.cssProperty}" title="Select preset value">▼</button>` : ''}
      ${presetDropdown}
    `;

    // Bind editable value events
    const valueEl = row.querySelector('.style-value') as HTMLElement;
    this.bindEditableValue(valueEl, prop);

    // Bind preset trigger and options if presets exist
    if (hasPresets) {
      const trigger = row.querySelector('.preset-trigger') as HTMLButtonElement;
      const dropdown = row.querySelector('.preset-dropdown') as HTMLElement;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePresetDropdown(dropdown, trigger);
      });

      // Bind preset option clicks
      dropdown.querySelectorAll('.preset-option').forEach(option => {
        option.addEventListener('click', (e) => {
          e.stopPropagation();
          const preset = (option as HTMLElement).dataset.preset;
          if (preset) {
            // Apply preset value and update the editable field
            this.applyStyle(prop.cssProperty, preset);
            valueEl.textContent = preset;
            this.closeAllPresetDropdowns();
          }
        });
      });
    }

    return row;
  }

  /**
   * Bind editable value events for inline CSS editing
   */
  private bindEditableValue(el: HTMLElement, prop: StyleProperty): void {
    // Focus: select all text for easy replacement
    el.addEventListener('focus', () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    // Blur: apply value
    el.addEventListener('blur', () => {
      const newValue = el.textContent?.trim() || `${prop.defaultValue}${prop.unit || ''}`;
      this.applyStyle(prop.cssProperty, newValue);
    });

    // Keyboard handling
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
      if (e.key === 'Escape') {
        // Revert to current applied value
        const currentValue = this._styleOverrides.get(prop.cssProperty) ||
          this._selectedElement?.computedStyles.get(prop.cssProperty) ||
          `${prop.defaultValue}${prop.unit || ''}`;
        el.textContent = currentValue;
        el.blur();
      }
      // Arrow up/down to increment/decrement numbers
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const text = el.textContent || '';
        const numMatch = text.match(/^(-?\d+(?:\.\d+)?)(.*)/);
        if (numMatch) {
          e.preventDefault();
          const num = parseFloat(numMatch[1]);
          const unit = numMatch[2];
          const step = e.shiftKey ? 10 : 1;
          const newNum = e.key === 'ArrowUp' ? num + step : num - step;
          el.textContent = `${newNum}${unit}`;
          this.applyStyle(prop.cssProperty, `${newNum}${unit}`);
        }
      }
    });
  }

  private togglePresetDropdown(dropdown: HTMLElement, trigger: HTMLButtonElement): void {
    const isOpen = dropdown.classList.contains('open');

    // Close all other dropdowns first
    this.closeAllPresetDropdowns();

    if (!isOpen) {
      // Position dropdown using fixed positioning to avoid clipping
      const triggerRect = trigger.getBoundingClientRect();
      const dropdownHeight = 200; // Approximate max height
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;

      // Position horizontally aligned with trigger
      dropdown.style.position = 'fixed';
      dropdown.style.left = `${triggerRect.left}px`;

      // Position vertically - prefer below, but flip if not enough space
      if (spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove) {
        dropdown.style.top = `${triggerRect.bottom + 2}px`;
        dropdown.style.bottom = 'auto';
      } else {
        dropdown.style.bottom = `${window.innerHeight - triggerRect.top + 2}px`;
        dropdown.style.top = 'auto';
      }

      dropdown.classList.add('open');
      trigger.classList.add('active');

      // Close on outside click
      const closeHandler = (e: MouseEvent) => {
        if (!dropdown.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          dropdown.classList.remove('open');
          trigger.classList.remove('active');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }
  }

  private closeAllPresetDropdowns(): void {
    this.panel.querySelectorAll('.preset-dropdown.open').forEach(dropdown => {
      dropdown.classList.remove('open');
    });
    this.panel.querySelectorAll('.preset-trigger.active').forEach(trigger => {
      trigger.classList.remove('active');
    });
  }

  private applyPreset(prop: StyleProperty, preset: string, row: HTMLElement): void {
    // Apply the preset value
    this.applyStyle(prop.cssProperty, preset);

    // Update the value display to show the preset
    const valueDisplay = row.querySelector('.style-value') as HTMLElement;
    valueDisplay.textContent = preset;

    // Disable the slider since we're using a keyword value
    const slider = row.querySelector('.style-slider') as HTMLInputElement;
    slider.disabled = true;
    row.classList.add('using-preset');

    // Close the dropdown
    this.closeAllPresetDropdowns();
  }

  private buildCustomSection(): HTMLElement {
    const isExpanded = this._expandedCategories.has('custom');
    const customCount = this._customProperties.length;

    const section = document.createElement('div');
    section.className = `style-category custom-category${isExpanded ? ' expanded' : ''}`;
    section.setAttribute('data-category', 'custom');

    // Category header - only show count badge if there are custom properties
    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="category-toggle">${isExpanded ? '▼' : '▶'}</span>
      <span class="category-icon">+</span>
      <span class="category-name">Custom</span>
      ${customCount > 0 ? `<span class="category-count">${customCount}</span>` : ''}
    `;

    header.addEventListener('click', () => {
      this.toggleCategory('custom');
    });

    section.appendChild(header);

    // Category body
    const body = document.createElement('div');
    body.className = 'category-body';

    // Add custom property input
    const addRow = document.createElement('div');
    addRow.className = 'add-custom-row';
    addRow.innerHTML = `
      <input type="text" class="custom-prop-input" placeholder="opacity: 0.5">
      <button class="add-custom-btn" title="Add property">+</button>
    `;

    const input = addRow.querySelector('.custom-prop-input') as HTMLInputElement;
    const addBtn = addRow.querySelector('.add-custom-btn') as HTMLButtonElement;

    const addCustomProperty = () => {
      const inputValue = input.value.trim();
      if (!inputValue) return;

      // Parse "property: value" format
      let propName: string;
      let initialValue: string | null = null;

      if (inputValue.includes(':')) {
        const colonIdx = inputValue.indexOf(':');
        propName = inputValue.slice(0, colonIdx).trim().toLowerCase();
        initialValue = inputValue.slice(colonIdx + 1).trim();
        // Remove trailing semicolon if present
        if (initialValue.endsWith(';')) {
          initialValue = initialValue.slice(0, -1).trim();
        }
      } else {
        propName = inputValue.toLowerCase();
      }

      if (!propName) return;

      // Check if property already exists
      const allProps = getAllStyleProperties();
      if (allProps.some(p => p.cssProperty === propName) ||
          this._customProperties.some(p => p.cssProperty === propName)) {
        input.classList.add('error');
        setTimeout(() => input.classList.remove('error'), 500);
        return;
      }

      // Detect if this is a color property
      const isColorProp = this.isColorProperty(propName);

      // Create custom property with sensible defaults
      const customProp: StyleProperty = {
        name: this.formatPropertyName(propName),
        cssProperty: propName,
        value: 0,
        defaultValue: 0,
        unit: isColorProp ? '' : this.guessUnit(propName),
        min: this.guessMin(propName),
        max: this.guessMax(propName),
        step: this.guessStep(propName),
        isColor: isColorProp // Flag for special handling
      };

      this._customProperties.push(customProp);
      input.value = '';

      // Apply initial value if provided
      if (initialValue && this._selectedElement) {
        this.applyStyle(propName, initialValue);
        // Store as string override, not as computed numeric
        this._styleOverrides.set(propName, initialValue);
      }

      // Rebuild the controls
      this.buildStyleControls();
      // Ensure custom is expanded
      this._expandedCategories.add('custom');
      this.updateCategoryUI('custom');
    };

    addBtn.addEventListener('click', addCustomProperty);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addCustomProperty();
    });

    body.appendChild(addRow);

    // Render existing custom properties
    this._customProperties.forEach(prop => {
      const row = this.buildPropertyRow(prop);
      body.appendChild(row);
    });

    section.appendChild(body);

    return section;
  }

  private toggleCategory(categoryId: string): void {
    if (this._expandedCategories.has(categoryId)) {
      this._expandedCategories.delete(categoryId);
    } else {
      this._expandedCategories.add(categoryId);
    }
    this.updateCategoryUI(categoryId);
  }

  private updateCategoryUI(categoryId: string): void {
    const section = this.panel.querySelector(`[data-category="${categoryId}"]`) as HTMLElement;
    if (!section) return;

    const isExpanded = this._expandedCategories.has(categoryId);
    section.classList.toggle('expanded', isExpanded);

    const toggle = section.querySelector('.category-toggle');
    if (toggle) toggle.textContent = isExpanded ? '▼' : '▶';
  }

  // Helpers for custom property creation
  private formatPropertyName(cssProperty: string): string {
    return cssProperty
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private guessUnit(propName: string): string {
    if (propName.includes('opacity') || propName.includes('z-index') || propName.includes('order') ||
        propName.includes('flex-grow') || propName.includes('flex-shrink') || propName.includes('scale')) {
      return '';
    }
    if (propName.includes('rotate')) return 'deg';
    return 'px';
  }

  private guessMin(propName: string): number {
    if (propName.includes('z-index') || propName.includes('order')) return -100;
    if (propName.includes('margin') || propName.includes('translate') || propName.includes('rotate')) return -100;
    if (propName.includes('opacity') || propName.includes('scale')) return 0;
    return 0;
  }

  private guessMax(propName: string): number {
    if (propName.includes('opacity')) return 1;
    if (propName.includes('z-index')) return 1000;
    if (propName.includes('scale')) return 3;
    if (propName.includes('rotate')) return 360;
    if (propName.includes('width') || propName.includes('height')) return 1000;
    return 100;
  }

  private guessStep(propName: string): number {
    if (propName.includes('opacity') || propName.includes('scale')) return 0.1;
    if (propName.includes('z-index') || propName.includes('order')) return 1;
    return 1;
  }

  /**
   * Check if a CSS property is a color property (values are colors, not numbers)
   */
  private isColorProperty(propName: string): boolean {
    const colorProps = [
      'color', 'background', 'background-color', 'border-color',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'outline-color', 'text-decoration-color', 'fill', 'stroke',
      'box-shadow', 'text-shadow', 'caret-color', 'accent-color'
    ];
    return colorProps.includes(propName) || propName.endsWith('-color');
  }

  /**
   * Update the box model visualization with current values.
   */
  private updateBoxModel(): void {
    if (!this._selectedElement) return;

    const el = this._selectedElement.element;
    const computed = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Helper to get numeric value
    const getVal = (prop: string) => Math.round(parseFloat(computed.getPropertyValue(prop)) || 0);

    // Update margin values
    this.setBoxValue('margin-top', getVal('margin-top'));
    this.setBoxValue('margin-right', getVal('margin-right'));
    this.setBoxValue('margin-bottom', getVal('margin-bottom'));
    this.setBoxValue('margin-left', getVal('margin-left'));

    // Update border values
    this.setBoxValue('border-top', getVal('border-top-width'));
    this.setBoxValue('border-right', getVal('border-right-width'));
    this.setBoxValue('border-bottom', getVal('border-bottom-width'));
    this.setBoxValue('border-left', getVal('border-left-width'));

    // Update padding values
    this.setBoxValue('padding-top', getVal('padding-top'));
    this.setBoxValue('padding-right', getVal('padding-right'));
    this.setBoxValue('padding-bottom', getVal('padding-bottom'));
    this.setBoxValue('padding-left', getVal('padding-left'));

    // Update content size
    const contentWidth = Math.round(rect.width - getVal('padding-left') - getVal('padding-right') - getVal('border-left-width') - getVal('border-right-width'));
    const contentHeight = Math.round(rect.height - getVal('padding-top') - getVal('padding-bottom') - getVal('border-top-width') - getVal('border-bottom-width'));

    const contentSizeEl = this.panel.querySelector('.content-size') as HTMLElement;
    if (contentSizeEl) {
      contentSizeEl.textContent = `${contentWidth} × ${contentHeight}`;
    }
  }

  private setBoxValue(className: string, value: number): void {
    const el = this.panel.querySelector(`.${className}`) as HTMLElement;
    if (el) {
      el.textContent = value.toString();
      // Highlight non-zero values
      el.classList.toggle('has-value', value !== 0);
    }
  }

  private applyStyle(property: string, value: string): void {
    if (!this._selectedElement) return;

    // Store override for current element
    this._styleOverrides.set(property, value);

    // Apply to selected element
    const camelProp = this.toCamelCase(property);
    (this._selectedElement.element.style as Record<string, string>)[camelProp] = value;

    // Apply to all matching elements if mode is enabled
    if (this._applyToMatching && this._matchingElements.length > 0) {
      this._matchingElements.forEach(el => {
        (el.style as Record<string, string>)[camelProp] = value;
      });
      // Update sibling overlay positions (in case size changed)
      this._matchingElements.forEach((el, idx) => {
        if (this._siblingOverlays[idx]) {
          this.positionOverlay(this._siblingOverlays[idx], el);
        }
      });
    }

    // Update selection overlay position (in case size changed)
    this.positionOverlay(this.selectOverlay, this._selectedElement.element);

    // Save to history - find or create entry for this element
    let historyEntry = this._changeHistory.find(h => h.element === this._selectedElement!.element);
    if (!historyEntry) {
      historyEntry = {
        element: this._selectedElement.element,
        path: this._selectedElement.path,
        overrides: new Map()
      };
      this._changeHistory.push(historyEntry);
    }
    historyEntry.overrides.set(property, value);

    // Update box model if a relevant property changed
    if (property.includes('margin') || property.includes('padding') ||
        property.includes('border') || property.includes('width') ||
        property.includes('height')) {
      this.updateBoxModel();
    }

    // Update the history list UI
    this.updateHistoryList();
  }

  private updateHistoryList(): void {
    const listEl = this.panel.querySelector('.history-list') as HTMLElement;
    if (!listEl) return;

    if (this._changeHistory.length === 0) {
      listEl.innerHTML = '<div class="history-empty">No changes yet</div>';
      return;
    }

    let html = '';
    this._changeHistory.forEach((entry, idx) => {
      const isCurrentElement = entry.element === this._selectedElement?.element;
      html += `<div class="history-item${isCurrentElement ? ' current' : ''}" data-history-idx="${idx}">`;
      html += `<div class="history-path">/* ${entry.path} */</div>`;
      entry.overrides.forEach((value, prop) => {
        html += `<div class="history-override">`;
        html += `<span class="override-prop">${prop}:</span> <span class="override-value">${value};</span>`;
        html += `<button class="override-delete" data-history-idx="${idx}" data-prop="${prop}" title="Revert this change">×</button>`;
        html += `</div>`;
      });
      html += '</div>';
    });
    listEl.innerHTML = html;

    // Bind click handlers to refocus elements
    listEl.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't trigger if clicking delete button
        if ((e.target as HTMLElement).classList.contains('override-delete')) return;
        const idx = parseInt((item as HTMLElement).dataset.historyIdx || '0', 10);
        this.refocusHistoryElement(idx);
      });
    });

    // Bind delete buttons
    listEl.querySelectorAll('.override-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt((btn as HTMLElement).dataset.historyIdx || '0', 10);
        const prop = (btn as HTMLElement).dataset.prop || '';
        this.removeHistoryOverride(idx, prop);
      });
    });
  }

  private refocusHistoryElement(idx: number): void {
    const entry = this._changeHistory[idx];
    if (!entry || !entry.element.isConnected) {
      console.warn('[Inspector] History element no longer in DOM');
      return;
    }

    // Reselect this element
    this.selectElement(entry.element);
  }

  private removeHistoryOverride(idx: number, property: string): void {
    const entry = this._changeHistory[idx];
    if (!entry) return;

    // Remove the style from the element
    const camelProp = this.toCamelCase(property);
    if (entry.element.isConnected) {
      (entry.element.style as Record<string, string>)[camelProp] = '';
    }

    // Remove from the override map
    entry.overrides.delete(property);

    // Also remove from current style overrides if this is the selected element
    if (this._selectedElement?.element === entry.element) {
      this._styleOverrides.delete(property);

      // Update the slider to show the computed (original) value
      const allProps = [...STYLE_CATEGORIES.flatMap(c => c.properties), ...this._customProperties];
      const propDef = allProps.find(p => p.cssProperty === property);
      if (propDef && entry.element.isConnected) {
        const computed = getComputedStyle(entry.element);
        const rawValue = computed.getPropertyValue(property);
        const parsed = parseFloat(rawValue);
        const newValue = !isNaN(parsed) ? Math.max(propDef.min, Math.min(propDef.max, parsed)) : propDef.defaultValue;

        // Update the slider in the UI
        const slider = this.panel.querySelector(`[data-prop="${property}"]`) as HTMLInputElement;
        if (slider) {
          slider.value = newValue.toString();
          const valueDisplay = slider.closest('.style-row')?.querySelector('.style-value') as HTMLElement;
          if (valueDisplay) {
            valueDisplay.textContent = `${newValue}${propDef.unit}`;
          }
        }

        // Update computed styles cache
        this._selectedElement.computedStyles.set(property, newValue);
      }

      // Update box model if needed
      if (property.includes('margin') || property.includes('padding') ||
          property.includes('border') || property.includes('width') || property.includes('height')) {
        this.updateBoxModel();
      }
    }

    // If the entry has no more overrides, remove it from history
    if (entry.overrides.size === 0) {
      this._changeHistory.splice(idx, 1);
    }

    // Update the UI
    this.updateHistoryList();

    // Update overlay position
    if (entry.element.isConnected) {
      if (this._selectedElement?.element === entry.element) {
        this.positionOverlay(this.selectOverlay, entry.element);
      }
    }
  }

  private copyHistoryToClipboard(): void {
    const btn = this.panel.querySelector('.copy-history-btn') as HTMLElement;

    if (this._changeHistory.length === 0) {
      btn.textContent = '⚠️';
      btn.title = 'No changes to copy';
      setTimeout(() => {
        btn.textContent = '📋';
        btn.title = 'Copy all changes';
      }, 1500);
      return;
    }

    let css = '';
    this._changeHistory.forEach(entry => {
      css += `/* ${entry.path} */\n`;
      entry.overrides.forEach((value, prop) => {
        css += `${prop}: ${value};\n`;
      });
      css += '\n';
    });

    navigator.clipboard.writeText(css.trim()).then(() => {
      btn.textContent = '✓';
      btn.title = 'Copied!';
      setTimeout(() => {
        btn.textContent = '📋';
        btn.title = 'Copy all changes';
      }, 1500);
    }).catch(() => {
      btn.textContent = '❌';
      btn.title = 'Copy failed';
      setTimeout(() => {
        btn.textContent = '📋';
        btn.title = 'Copy all changes';
      }, 1500);
    });
  }

  // ============================================
  // Actions
  // ============================================

  private toggleInspectMode(): void {
    this._inspectMode = !this._inspectMode;
    const btn = this.panel.querySelector('.inspect-btn') as HTMLElement;

    if (this._inspectMode) {
      btn.classList.add('active');
      btn.innerHTML = '<span>🎯</span> Right Click = select';
      document.body.style.cursor = 'crosshair';
      // Enable contextmenu (right-click) capture during inspect mode
      document.addEventListener('contextmenu', this.boundHandleContextMenu);
    } else {
      btn.classList.remove('active');
      btn.innerHTML = '<span>🎯</span> Select';
      document.body.style.cursor = '';
      this.highlightOverlay.style.display = 'none';
      this._hoveredElement = null;
      // Remove contextmenu listener when not inspecting
      document.removeEventListener('contextmenu', this.boundHandleContextMenu);
    }

    this.publish({ 'inspector.inspectMode': this._inspectMode });
  }

  private toggleMatchMode(): void {
    this._applyToMatching = !this._applyToMatching;
    const btn = this.panel.querySelector('.match-btn') as HTMLElement;

    if (this._applyToMatching) {
      btn.classList.add('active');
      btn.innerHTML = '<span>🔗</span> All';
      btn.title = 'Apply to all elements with same classes (ON)';
      // Re-find and highlight matching elements
      if (this._selectedElement) {
        this.findAndHighlightMatchingElements();
      }
    } else {
      btn.classList.remove('active');
      btn.innerHTML = '<span>🔗</span> One';
      btn.title = 'Apply to selected element only';
      // Clear sibling highlights
      this.clearSiblingOverlays();
      this._matchingElements = [];
    }
  }

  /**
   * Find all elements that share the same classes as the selected element.
   * Searches both light DOM and shadow DOMs.
   */
  private findMatchingElements(element: HTMLElement): HTMLElement[] {
    const classes = Array.from(element.classList);
    if (classes.length === 0) return [];

    const matches: HTMLElement[] = [];
    const selector = classes.map(c => `.${c}`).join('');

    // Search in light DOM
    const lightMatches = document.querySelectorAll<HTMLElement>(selector);
    lightMatches.forEach(el => {
      if (el !== element && !this.isInspectorElement(el)) {
        matches.push(el);
      }
    });

    // Search in all shadow roots
    this.searchShadowRoots(document.body, selector, element, matches);

    return matches;
  }

  /**
   * Recursively search shadow roots for matching elements.
   */
  private searchShadowRoots(
    root: Element,
    selector: string,
    exclude: HTMLElement,
    matches: HTMLElement[]
  ): void {
    // Check if this element has a shadow root
    if (root.shadowRoot) {
      const shadowMatches = root.shadowRoot.querySelectorAll<HTMLElement>(selector);
      shadowMatches.forEach(el => {
        if (el !== exclude && !this.isInspectorElement(el)) {
          matches.push(el);
        }
      });

      // Recurse into shadow root children
      root.shadowRoot.querySelectorAll('*').forEach(child => {
        this.searchShadowRoots(child, selector, exclude, matches);
      });
    }

    // Recurse into light DOM children
    root.querySelectorAll('*').forEach(child => {
      if (child.shadowRoot) {
        this.searchShadowRoots(child, selector, exclude, matches);
      }
    });
  }

  private findAndHighlightMatchingElements(): void {
    if (!this._selectedElement || !this._applyToMatching) return;

    // Clear existing sibling overlays
    this.clearSiblingOverlays();

    // Find matching elements
    this._matchingElements = this.findMatchingElements(this._selectedElement.element);

    // Create overlays for each matching element
    this._matchingElements.forEach(el => {
      const overlay = this.createOverlay('sibling');
      this.positionOverlay(overlay, el);
      overlay.style.display = 'block';
      document.body.appendChild(overlay);
      this._siblingOverlays.push(overlay);
    });

    console.log(`[Inspector] Found ${this._matchingElements.length} matching elements`);
  }

  private clearSiblingOverlays(): void {
    this._siblingOverlays.forEach(overlay => overlay.remove());
    this._siblingOverlays = [];
  }

  private clearSelection(): void {
    if (this._selectedElement) {
      // Reset all style overrides on the selected element
      this._styleOverrides.forEach((_, prop) => {
        const camelProp = this.toCamelCase(prop);
        (this._selectedElement!.element.style as Record<string, string>)[camelProp] = '';
      });

      // Also reset on matching elements
      this._matchingElements.forEach(el => {
        this._styleOverrides.forEach((_, prop) => {
          const camelProp = this.toCamelCase(prop);
          (el.style as Record<string, string>)[camelProp] = '';
        });
      });

      // Remove history entry for the selected element
      const historyIdx = this._changeHistory.findIndex(h => h.element === this._selectedElement!.element);
      if (historyIdx !== -1) {
        this._changeHistory.splice(historyIdx, 1);
      }
    }

    this._selectedElement = null;
    this._matchingElements = [];
    this._styleOverrides.clear();
    this.selectOverlay.style.display = 'none';
    this.clearSiblingOverlays();

    // Reset UI
    const noSelection = this.panel.querySelector('.no-selection') as HTMLElement;
    const selectionInfo = this.panel.querySelector('.selection-info') as HTMLElement;
    noSelection.style.display = 'block';
    selectionInfo.classList.remove('visible');

    // Update history list
    this.updateHistoryList();

    this.publish({ 'inspector.hasSelection': false });
  }


  // ============================================
  // Public API
  // ============================================

  show(): void {
    this._visible = true;
    this.panel.classList.remove('hidden');

    // Reset position to top-right corner
    this.panel.style.top = '10px';
    this.panel.style.right = '10px';
    this.panel.style.left = 'auto';

    this.publish({ 'inspector.visible': true });
  }

  hide(): void {
    this._visible = false;
    this.panel.classList.add('hidden');

    if (this._inspectMode) {
      this.toggleInspectMode();
    }

    // Reset all applied styles when closing
    this.resetAllStyles();

    // Hide the selection overlay and sibling overlays when closing inspector
    this.selectOverlay.style.display = 'none';
    this.clearSiblingOverlays();

    // Clear state
    this._selectedElement = null;
    this._matchingElements = [];
    this._styleOverrides.clear();

    // Reset UI to no-selection state
    const noSelection = this.panel.querySelector('.no-selection') as HTMLElement;
    const selectionInfo = this.panel.querySelector('.selection-info') as HTMLElement;
    if (noSelection) noSelection.style.display = 'block';
    if (selectionInfo) selectionInfo.classList.remove('visible');

    this.publish({ 'inspector.visible': false });

    // Dispatch a custom event for external listeners (like the toggle button)
    this.element.dispatchEvent(new CustomEvent('inspector-hidden', { bubbles: true }));
  }

  /**
   * Reset all style changes made through the inspector.
   * Called when closing/hiding the inspector.
   */
  private resetAllStyles(): void {
    // Reset all styles from history (selected elements)
    this._changeHistory.forEach(entry => {
      if (entry.element.isConnected) {
        entry.overrides.forEach((_, prop) => {
          const camelProp = this.toCamelCase(prop);
          (entry.element.style as Record<string, string>)[camelProp] = '';
        });
      }
    });

    // Also reset matching elements using current style overrides
    // (matching elements aren't tracked in history, only the primary selection is)
    this._matchingElements.forEach(el => {
      if (el.isConnected) {
        this._styleOverrides.forEach((_, prop) => {
          const camelProp = this.toCamelCase(prop);
          (el.style as Record<string, string>)[camelProp] = '';
        });
      }
    });

    // Clear history
    this._changeHistory = [];
    this.updateHistoryList();
  }

  toggle(): void {
    if (this._visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  isVisible(): boolean {
    return this._visible;
  }

  getState(): InspectorState {
    return {
      visible: this._visible,
      inspectMode: this._inspectMode,
      selectedElement: this._selectedElement,
      styleOverrides: new Map(this._styleOverrides),
      expandedCategories: new Set(this._expandedCategories),
      customProperties: [...this._customProperties]
    };
  }

  /**
   * Get current style overrides as CSS string
   */
  getStyleOverridesCSS(): string {
    if (!this._selectedElement || this._styleOverrides.size === 0) return '';

    let css = `/* ${this._selectedElement.path} */\n`;
    this._styleOverrides.forEach((value, prop) => {
      css += `${prop}: ${value};\n`;
    });
    return css;
  }

  // ============================================
  // Utilities
  // ============================================

  private toCamelCase(str: string): string {
    return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  // ============================================
  // Lifecycle
  // ============================================

  destroy(): void {
    // Remove global event listeners
    document.removeEventListener('mousemove', this.boundHandleMouseMove);
    document.removeEventListener('mouseup', this.boundHandleMouseUp);
    document.removeEventListener('click', this.boundHandleClick, true);
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    document.removeEventListener('scroll', this.boundHandleScroll, true);
    window.removeEventListener('scroll', this.boundHandleScroll);

    // Remove overlays from DOM
    this.highlightOverlay.remove();
    this.selectOverlay.remove();

    // Clear selection
    this.clearSelection();

    super.destroy();
  }
}
