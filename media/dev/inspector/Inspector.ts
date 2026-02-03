/**
 * Dev Inspector Panel
 *
 * Interactive element inspector for adjusting UI in real-time.
 * Click elements to select them, then adjust their styles with sliders.
 */

interface StyleProperty {
  name: string;
  cssProperty: string;
  value: number;
  defaultValue: number;
  unit: string;
  min: number;
  max: number;
  step: number;
}

// Only use specific properties (not shorthands) so getComputedStyle returns actual values
const defaultStyles: StyleProperty[] = [
  { name: 'Padding Top', cssProperty: 'padding-top', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Padding Bottom', cssProperty: 'padding-bottom', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Padding Left', cssProperty: 'padding-left', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Padding Right', cssProperty: 'padding-right', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Margin Top', cssProperty: 'margin-top', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Margin Bottom', cssProperty: 'margin-bottom', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1 },
  { name: 'Gap', cssProperty: 'gap', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 32, step: 1 },
  { name: 'Border Radius', cssProperty: 'border-radius', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 24, step: 1 },
  { name: 'Font Size', cssProperty: 'font-size', value: 13, defaultValue: 13, unit: 'px', min: 8, max: 24, step: 1 },
  { name: 'Line Height', cssProperty: 'line-height', value: 1.4, defaultValue: 1.4, unit: '', min: 1, max: 2.5, step: 0.1 },
  { name: 'Opacity', cssProperty: 'opacity', value: 1, defaultValue: 1, unit: '', min: 0, max: 1, step: 0.1 },
];

export class Inspector {
  private panel: HTMLElement;
  private selectedElement: HTMLElement | null = null;
  private highlightOverlay: HTMLElement;
  private selectOverlay: HTMLElement;
  private isInspectMode = false;
  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private styleOverrides: Map<HTMLElement, Map<string, string>> = new Map();

  constructor() {
    this.highlightOverlay = this.createOverlay('highlight');
    this.selectOverlay = this.createOverlay('select');
    this.panel = this.createPanel();

    document.body.appendChild(this.highlightOverlay);
    document.body.appendChild(this.selectOverlay);
    document.body.appendChild(this.panel);

    this.bindEvents();
    console.log('[Inspector] Ready - click 🔧 or F2, then click elements to inspect');
  }

  private createOverlay(type: 'highlight' | 'select'): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = `inspector-overlay inspector-overlay-${type}`;
    overlay.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 999997;
      display: none;
      ${type === 'highlight'
        ? 'border: 2px dashed rgba(59, 142, 234, 0.8); background: rgba(59, 142, 234, 0.1);'
        : 'border: 2px solid #3b8eea; background: rgba(59, 142, 234, 0.15);'
      }
    `;
    return overlay;
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'dev-inspector';
    panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 300px;
      max-height: calc(100vh - 20px);
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-editorWidget-border, #454545);
      border-radius: 6px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      color: var(--vscode-foreground, #ccc);
      z-index: 999999;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      display: none;
      flex-direction: column;
    `;

    panel.innerHTML = `
      <div class="inspector-header" style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: var(--vscode-titleBar-activeBackground, #3c3c3c);
        border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
        cursor: move;
        user-select: none;
      ">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 14px;">🎯</span>
          <span style="font-weight: 600;">Element Inspector</span>
          <span style="
            background: var(--vscode-badge-background, #4d4d4d);
            color: var(--vscode-badge-foreground, #fff);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
          ">DEV</span>
        </div>
        <button class="inspector-close" style="
          background: none;
          border: none;
          color: inherit;
          cursor: pointer;
          padding: 2px 6px;
          font-size: 16px;
          opacity: 0.7;
        ">×</button>
      </div>

      <div class="inspector-toolbar" style="
        display: flex;
        gap: 4px;
        padding: 8px;
        border-bottom: 1px solid var(--vscode-editorWidget-border, #454545);
        background: var(--vscode-sideBarSectionHeader-background, #333);
      ">
        <button class="inspect-btn" style="
          flex: 1;
          padding: 6px 10px;
          background: var(--vscode-button-background, #0e639c);
          border: none;
          border-radius: 4px;
          color: var(--vscode-button-foreground, #fff);
          cursor: pointer;
          font-size: 11px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
        ">
          <span>🎯</span> Select Element
        </button>
        <button class="clear-btn" style="
          padding: 6px 10px;
          background: var(--vscode-button-secondaryBackground, #3a3d41);
          border: none;
          border-radius: 4px;
          color: var(--vscode-button-secondaryForeground, #fff);
          cursor: pointer;
          font-size: 11px;
        ">Clear</button>
      </div>

      <div class="inspector-body" style="
        overflow-y: auto;
        max-height: 400px;
        padding: 12px;
      ">
        <div class="no-selection" style="
          text-align: center;
          padding: 24px;
          color: var(--vscode-descriptionForeground, #999);
        ">
          <div style="font-size: 32px; margin-bottom: 8px;">👆</div>
          <div>Click "Select Element" then click<br>any UI element to inspect it</div>
        </div>
        <div class="selection-info" style="display: none;">
          <div class="element-path" style="
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10px;
            color: var(--vscode-textLink-foreground, #3794ff);
            margin-bottom: 12px;
            padding: 6px 8px;
            background: var(--vscode-textCodeBlock-background, #2d2d2d);
            border-radius: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          "></div>
          <div class="style-controls"></div>
          <button class="copy-css-btn" style="
            width: 100%;
            margin-top: 12px;
            padding: 8px;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            border: none;
            border-radius: 4px;
            color: var(--vscode-button-secondaryForeground, #fff);
            cursor: pointer;
            font-size: 11px;
          ">📋 Copy CSS Overrides</button>
        </div>
      </div>
    `;

    return panel;
  }

  private bindEvents(): void {
    // Close button
    this.panel.querySelector('.inspector-close')?.addEventListener('click', () => {
      this.hide();
    });

    // Inspect mode toggle
    this.panel.querySelector('.inspect-btn')?.addEventListener('click', () => {
      this.toggleInspectMode();
    });

    // Clear button
    this.panel.querySelector('.clear-btn')?.addEventListener('click', () => {
      this.clearSelection();
    });

    // Copy CSS button
    this.panel.querySelector('.copy-css-btn')?.addEventListener('click', () => {
      this.copyCSSToClipboard();
    });

    // Dragging
    const header = this.panel.querySelector('.inspector-header') as HTMLElement;
    header?.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.isDragging = true;
      const rect = this.panel.getBoundingClientRect();
      this.dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        this.panel.style.left = `${e.clientX - this.dragOffset.x}px`;
        this.panel.style.top = `${e.clientY - this.dragOffset.y}px`;
        this.panel.style.right = 'auto';
      }

      if (this.isInspectMode) {
        this.handleHover(e);
      }
    });

    document.addEventListener('mouseup', () => {
      this.isDragging = false;
      document.body.style.userSelect = '';
    });

    // Element selection
    document.addEventListener('click', (e) => {
      if (this.isInspectMode) {
        e.preventDefault();
        e.stopPropagation();
        this.selectElement(e);
      }
    }, true);

    // Escape to exit inspect mode
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isInspectMode) {
        this.toggleInspectMode();
      }
    });
  }

  private toggleInspectMode(): void {
    this.isInspectMode = !this.isInspectMode;
    const btn = this.panel.querySelector('.inspect-btn') as HTMLElement;

    if (this.isInspectMode) {
      btn.style.background = '#d63384';
      btn.innerHTML = '<span>🎯</span> Click an element...';
      document.body.style.cursor = 'crosshair';
    } else {
      btn.style.background = 'var(--vscode-button-background, #0e639c)';
      btn.innerHTML = '<span>🎯</span> Select Element';
      document.body.style.cursor = '';
      this.highlightOverlay.style.display = 'none';
    }
  }

  private handleHover(e: MouseEvent): void {
    // Use composedPath to get actual element inside shadow DOM
    const actualTarget = e.composedPath()[0] as HTMLElement;

    // Skip if hovering over the inspector panel itself
    if (this.panel.contains(actualTarget)) {
      this.highlightOverlay.style.display = 'none';
      return;
    }

    const target = this.findInspectableElement(actualTarget);
    if (target) {
      this.positionOverlay(this.highlightOverlay, target);
      this.highlightOverlay.style.display = 'block';
    } else {
      this.highlightOverlay.style.display = 'none';
    }
  }

  private findInspectableElement(el: HTMLElement): HTMLElement | null {
    // Walk up to find an element with a class or in a shadow root
    let current: HTMLElement | null = el;

    while (current && current !== document.body) {
      // Skip the inspector itself
      if (current.classList.contains('dev-inspector') ||
          current.classList.contains('dev-toggle-btn') ||
          current.classList.contains('inspector-overlay')) {
        return null;
      }

      // Good targets: elements with classes, inside shadow DOM content
      if (current.className && typeof current.className === 'string' && current.className.length > 0) {
        return current;
      }

      current = current.parentElement;
    }

    return el !== document.body ? el : null;
  }

  private selectElement(e: MouseEvent): void {
    // Use composedPath to get actual element inside shadow DOM
    const actualTarget = e.composedPath()[0] as HTMLElement;
    const target = this.findInspectableElement(actualTarget);
    if (!target) return;

    this.selectedElement = target;
    this.toggleInspectMode(); // Exit inspect mode

    // Show selection overlay
    this.positionOverlay(this.selectOverlay, target);
    this.selectOverlay.style.display = 'block';

    // Update UI
    this.panel.querySelector('.no-selection')!.setAttribute('style', 'display: none');
    this.panel.querySelector('.selection-info')!.setAttribute('style', 'display: block');

    // Show element path
    const path = this.getElementPath(target);
    (this.panel.querySelector('.element-path') as HTMLElement).textContent = path;

    // Build style controls
    this.buildStyleControls(target);
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

    for (let i = 0; i < 3 && current && current !== document.body; i++) {
      let part = current.tagName.toLowerCase();
      if (current.className && typeof current.className === 'string') {
        const mainClass = current.className.split(' ')[0];
        if (mainClass) part += `.${mainClass}`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  private buildStyleControls(target: HTMLElement): void {
    const container = this.panel.querySelector('.style-controls') as HTMLElement;

    // Temporarily clear inline styles to read the original CSS values
    const savedStyles = new Map<string, string>();
    defaultStyles.forEach(prop => {
      const camelProp = this.camelCase(prop.cssProperty);
      const currentInline = (target.style as any)[camelProp];
      if (currentInline) {
        savedStyles.set(prop.cssProperty, currentInline);
        (target.style as any)[camelProp] = '';
      }
    });

    // Now read the true computed values (from CSS, not inline)
    const computed = getComputedStyle(target);

    container.innerHTML = defaultStyles.map(prop => {
      // Get current computed value - use specific properties, not shorthands
      const currentValue = computed.getPropertyValue(prop.cssProperty);
      const parsed = parseFloat(currentValue);
      // Use parsed value if valid number (including 0), otherwise fallback to default
      let numValue = !isNaN(parsed) ? parsed : prop.defaultValue;

      // Handle special cases
      if (prop.cssProperty === 'line-height' && currentValue === 'normal') {
        numValue = 1.4;
      }

      // Clamp to slider range
      numValue = Math.max(prop.min, Math.min(prop.max, numValue));

      return `
        <div class="style-row" style="
          display: flex;
          align-items: center;
          padding: 6px 0;
          gap: 8px;
          border-bottom: 1px solid var(--vscode-editorWidget-border, #3c3c3c);
        " data-property="${prop.cssProperty}">
          <label style="
            min-width: 90px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground, #999);
          ">${prop.name}</label>
          <input type="range"
            min="${prop.min}" max="${prop.max}" step="${prop.step}"
            value="${numValue}"
            data-prop="${prop.cssProperty}"
            data-unit="${prop.unit}"
            style="
              flex: 1;
              height: 4px;
              -webkit-appearance: none;
              background: var(--vscode-scrollbarSlider-background, #4d4d4d);
              border-radius: 2px;
              outline: none;
            ">
          <span class="value-display" style="
            min-width: 45px;
            text-align: right;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
          ">${numValue}${prop.unit}</span>
        </div>
      `;
    }).join('');

    // Restore any previously applied inline styles
    savedStyles.forEach((value, prop) => {
      const camelProp = this.camelCase(prop);
      (target.style as any)[camelProp] = value;
    });

    // Bind slider events
    container.querySelectorAll('input[type="range"]').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const input = e.target as HTMLInputElement;
        const prop = input.dataset.prop!;
        const unit = input.dataset.unit || '';
        const value = input.value;

        // Update display
        const row = input.closest('.style-row');
        const display = row?.querySelector('.value-display');
        if (display) display.textContent = `${value}${unit}`;

        // Apply to element
        this.applyStyle(prop, `${value}${unit}`);
      });
    });
  }

  private applyStyle(property: string, value: string): void {
    if (!this.selectedElement) return;

    // Store override
    if (!this.styleOverrides.has(this.selectedElement)) {
      this.styleOverrides.set(this.selectedElement, new Map());
    }
    this.styleOverrides.get(this.selectedElement)!.set(property, value);

    // Apply directly
    (this.selectedElement.style as any)[this.camelCase(property)] = value;

    // Update selection overlay position (in case size changed)
    this.positionOverlay(this.selectOverlay, this.selectedElement);
  }

  private camelCase(str: string): string {
    return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  private clearSelection(): void {
    if (this.selectedElement && this.styleOverrides.has(this.selectedElement)) {
      // Reset all overrides
      const overrides = this.styleOverrides.get(this.selectedElement)!;
      overrides.forEach((_, prop) => {
        (this.selectedElement!.style as any)[this.camelCase(prop)] = '';
      });
      this.styleOverrides.delete(this.selectedElement);
    }

    this.selectedElement = null;
    this.selectOverlay.style.display = 'none';

    this.panel.querySelector('.no-selection')!.setAttribute('style', 'display: block; text-align: center; padding: 24px; color: var(--vscode-descriptionForeground, #999);');
    this.panel.querySelector('.selection-info')!.setAttribute('style', 'display: none');
  }

  private copyCSSToClipboard(): void {
    if (!this.selectedElement || !this.styleOverrides.has(this.selectedElement)) return;

    const overrides = this.styleOverrides.get(this.selectedElement)!;
    const path = this.getElementPath(this.selectedElement);

    let css = `/* ${path} */\n`;
    overrides.forEach((value, prop) => {
      css += `${prop}: ${value};\n`;
    });

    navigator.clipboard.writeText(css).then(() => {
      const btn = this.panel.querySelector('.copy-css-btn') as HTMLElement;
      const original = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = original, 1500);
    });
  }

  show(): void {
    this.panel.style.display = 'flex';
  }

  hide(): void {
    this.panel.style.display = 'none';
    if (this.isInspectMode) {
      this.toggleInspectMode();
    }
  }

  toggle(): void {
    if (this.panel.style.display === 'none') {
      this.show();
    } else {
      this.hide();
    }
  }

  destroy(): void {
    this.clearSelection();
    this.panel.remove();
    this.highlightOverlay.remove();
    this.selectOverlay.remove();
  }
}
