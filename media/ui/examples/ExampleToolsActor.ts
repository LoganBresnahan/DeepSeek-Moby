/**
 * Example: Tools Actor using UI Framework
 *
 * This demonstrates how to build an actor using the declarative UI framework.
 * Compare this to the imperative approach in the original ToolCallsShadowActor.
 */

import { UIActor, UIActorState } from '../UIActor';
import { ui } from '../index';
import type { UINode } from '../types';
import { EventStateManager } from '../../state/EventStateManager';

// ============================================
// STATE TYPE
// ============================================

interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'error';
  detail?: string;
}

interface ToolsState extends UIActorState {
  expanded: boolean;
  tools: ToolCall[];
}

// ============================================
// ACTOR IMPLEMENTATION
// ============================================

export class ExampleToolsActor extends UIActor<ToolsState> {
  constructor(manager: EventStateManager, element: HTMLElement) {
    super(manager, element, 'example-tools', {
      expanded: false,
      tools: [],
    });
  }

  // ==========================================
  // PUBLIC API
  // ==========================================

  addTool(name: string, detail?: string): string {
    const id = `tool-${Date.now()}`;
    this.setState({
      tools: [...this.state.tools, { id, name, status: 'pending', detail }],
    });
    return id;
  }

  updateTool(id: string, updates: Partial<ToolCall>): void {
    this.setState({
      tools: this.state.tools.map(t =>
        t.id === id ? { ...t, ...updates } : t
      ),
    });
  }

  toggleExpanded(): void {
    this.setState({ expanded: !this.state.expanded });
  }

  // ==========================================
  // VIEW (Declarative UI)
  // ==========================================

  protected getView(): UINode {
    const { expanded, tools } = this.state;

    // Empty state
    if (tools.length === 0) {
      return null;
    }

    // Build the dropdown
    return ui.dropdown(
      // Header
      this.renderHeader(),
      // Body
      this.renderBody(),
      // Options
      {
        expanded,
        onToggle: 'toggle',
        className: 'tools-dropdown',
      }
    );
  }

  private renderHeader(): UINode {
    const { expanded, tools } = this.state;
    const preview = this.getPreview();

    return ui.dropdownHeader('Tools', {
      expanded,
      icon: 'tools',
      badge: `[${tools.length}]`,
      preview: expanded ? undefined : preview,
    });
  }

  private renderBody(): UINode {
    const { tools } = this.state;

    return ui.list(
      tools.map((tool, i) =>
        ui.toolRow(tool.name, {
          id: tool.id,
          status: tool.status,
          detail: tool.detail,
          treeBranch: i === tools.length - 1 ? 'end' : 'branch',
          onClick: `focus-${tool.id}`,
        })
      ),
      { gap: 'xs' }
    );
  }

  private getPreview(): string {
    const names = this.state.tools.slice(0, 3).map(t => t.name);
    const preview = names.join(' · ');
    return this.state.tools.length > 3 ? `${preview} ...` : preview;
  }

  // ==========================================
  // STYLES
  // ==========================================

  protected getStyles(): string {
    return `
      .tools-dropdown {
        margin: 8px 0;
        font-family: var(--vscode-font-family);
        font-size: 13px;
      }

      .dropdown-header {
        padding: 4px 8px;
        border-radius: 4px;
      }

      .dropdown-header:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .dropdown-body {
        padding: 4px 0 4px 16px;
      }

      .tool-row {
        padding: 2px 4px;
        border-radius: 2px;
      }

      .tool-row:hover {
        background: var(--vscode-list-hoverBackground);
      }
    `;
  }

  // ==========================================
  // EVENT HANDLERS
  // ==========================================

  protected getHandlers(): Record<string, (e: Event, el: HTMLElement) => void> {
    const handlers: Record<string, (e: Event, el: HTMLElement) => void> = {
      toggle: () => this.toggleExpanded(),
    };

    // Add focus handlers for each tool
    this.state.tools.forEach(tool => {
      handlers[`focus-${tool.id}`] = () => {
        console.log('Focus tool:', tool.name);
        // Emit focus event, etc.
      };
    });

    return handlers;
  }

  // ==========================================
  // PUB/SUB
  // ==========================================

  protected getPublicationKeys(): string[] {
    return ['tools.count', 'tools.expanded'];
  }

  protected onStateChange(prevState: ToolsState, nextState: ToolsState): void {
    // Publish relevant state changes
    if (prevState.tools.length !== nextState.tools.length) {
      this.publish({ 'tools.count': nextState.tools.length });
    }
    if (prevState.expanded !== nextState.expanded) {
      this.publish({ 'tools.expanded': nextState.expanded });
    }
  }
}

// ============================================
// USAGE EXAMPLE
// ============================================

/*
// In your main code:

const manager = new EventStateManager();
const container = document.getElementById('chat-messages');
const toolsActor = new ExampleToolsActor(manager, container);

// Add tools
const id1 = toolsActor.addTool('Read', 'config.ts');
const id2 = toolsActor.addTool('Write', 'output.ts');

// Update status
toolsActor.updateTool(id1, { status: 'running' });
toolsActor.updateTool(id1, { status: 'success' });

// Toggle expansion
toolsActor.toggleExpanded();

// Cleanup
toolsActor.destroy();
*/
