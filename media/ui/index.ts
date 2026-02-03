/**
 * UI Framework
 *
 * A declarative, constraint-based UI framework optimized for LLM collaboration.
 *
 * Design Principles:
 * 1. Declarative - Describe WHAT, not HOW
 * 2. Constrained - Finite choices (tokens), not infinite (raw CSS)
 * 3. Composable - Small primitives that combine predictably
 * 4. Explicit - No magic, all state visible
 * 5. Typed - Full TypeScript support
 *
 * Example usage:
 *
 * ```typescript
 * import { ui, render, renderToShadow, bindEvents } from './ui';
 *
 * // Define component
 * const myDropdown = ui.dropdown(
 *   ui.dropdownHeader('Tools', { expanded: false, icon: 'tools', badge: '[3]' }),
 *   ui.list([
 *     ui.toolRow('Read', { status: 'success', detail: 'file.ts' }),
 *     ui.toolRow('Write', { status: 'running', detail: 'output.ts' }),
 *     ui.toolRow('Bash', { status: 'pending', detail: 'npm test' }),
 *   ]),
 *   { expanded: false, onToggle: 'handleToggle' }
 * );
 *
 * // Render to Shadow DOM
 * renderToShadow(this.shadowRoot, myDropdown, customStyles);
 *
 * // Bind event handlers
 * bindEvents(this.shadowRoot, {
 *   handleToggle: () => this.toggleExpanded()
 * });
 * ```
 */

// Re-export everything
export * from './tokens';
export * from './types';
export * from './primitives';
export * from './components';
export * from './render';

// Import for namespace
import * as tokens from './tokens';
import * as primitives from './primitives';
import * as components from './components';

/**
 * Unified namespace for all UI building functions
 *
 * Use this for a cleaner API:
 * ```
 * import { ui } from './ui';
 * const elem = ui.row([ui.text('Hello'), ui.icon('success')]);
 * ```
 */
export const ui = {
  // Tokens (for reference)
  tokens,

  // Primitives
  box: primitives.box,
  text: primitives.text,
  icon: primitives.icon,
  button: primitives.button,
  badge: primitives.badge,
  row: primitives.row,
  stack: primitives.stack,
  divider: primitives.divider,
  spacer: primitives.spacer,
  clickable: primitives.clickable,
  hidden: primitives.hidden,
  when: primitives.when,
  each: primitives.each,

  // Composite components
  dropdown: components.dropdown,
  dropdownHeader: components.dropdownHeader,
  list: components.list,
  tree: components.tree,
  treeItem: components.treeItem,
  card: components.card,

  // Specialized
  statusRow: components.statusRow,
  fileRow: components.fileRow,
  commandRow: components.commandRow,
  toolRow: components.toolRow,
  emptyState: components.emptyState,
  loadingState: components.loadingState,
};

export default ui;
