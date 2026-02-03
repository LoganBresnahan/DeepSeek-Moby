/**
 * Composite Components
 *
 * Higher-level components built from primitives.
 * LLM-friendly: declarative, predictable structure.
 */

import type {
  UINode,
  DropdownProps,
  ListProps,
  TreeProps,
  TreeItem,
  CardProps,
} from './types';
import type { ContainerVariant, Icon, Spacing } from './tokens';
import { row, stack, text, icon, box, divider } from './primitives';

// ============================================
// DROPDOWN
// ============================================

interface DropdownOptions {
  id?: string;
  className?: string;
  expanded: boolean;
  animation?: 'none' | 'slide' | 'fade';
  onToggle?: string;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing;
}

/**
 * Dropdown - Expandable container with header and body
 */
export function dropdown(header: UINode, body: UINode, options: DropdownOptions): DropdownProps {
  return {
    type: 'dropdown',
    header,
    body,
    ...options,
  };
}

/**
 * Dropdown header helper - standard layout with toggle, icon, label
 */
export function dropdownHeader(
  label: string,
  opts: {
    expanded: boolean;
    icon?: Icon;
    badge?: string;
    preview?: string;
  }
): UINode {
  const toggleIcon = opts.expanded ? 'collapseMinus' : 'expandPlus';

  return row([
    icon(toggleIcon, { className: 'toggle', mr: 'sm' }),
    opts.icon ? icon(opts.icon, { className: 'icon', mr: 'sm' }) : null,
    text(label, { className: 'label', weight: 'medium' }),
    opts.preview && !opts.expanded ? text(opts.preview, { className: 'preview', variant: 'muted', ml: 'sm', truncate: true }) : null,
    opts.badge ? text(opts.badge, { className: 'badge', ml: 'sm' }) : null,
  ], {
    className: 'header',
    align: 'center',
    gap: 'none',
  });
}

// ============================================
// LIST
// ============================================

interface ListOptions {
  id?: string;
  className?: string;
  gap?: Spacing;
  dividers?: boolean;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing;
}

/**
 * List - Renders array of items with optional dividers
 */
export function list(items: UINode[], options: ListOptions = {}): ListProps {
  return {
    type: 'list',
    items,
    ...options,
  };
}

// ============================================
// TREE
// ============================================

interface TreeOptions {
  id?: string;
  className?: string;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing;
}

/**
 * Tree - Hierarchical list with branch characters
 */
export function tree(items: TreeItem[], options: TreeOptions = {}): TreeProps {
  return {
    type: 'tree',
    items,
    ...options,
  };
}

/**
 * Tree item helper
 */
export function treeItem(content: UINode, opts: { isLast?: boolean; children?: TreeItem[] } = {}): TreeItem {
  return {
    content,
    isLast: opts.isLast,
    children: opts.children,
  };
}

// ============================================
// CARD
// ============================================

interface CardOptions {
  id?: string;
  className?: string;
  variant?: ContainerVariant;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing;
}

/**
 * Card - Styled container with header/body/footer
 */
export function card(body: UINode, options: CardOptions & { header?: UINode; footer?: UINode } = {}): CardProps {
  const { header, footer, ...rest } = options;
  return {
    type: 'card',
    header,
    body,
    footer,
    ...rest,
  };
}

// ============================================
// SPECIALIZED COMPONENTS
// ============================================

/**
 * StatusRow - Row with status icon and content
 */
export function statusRow(
  status: 'success' | 'error' | 'warning' | 'pending' | 'spinner',
  content: UINode,
  opts: { id?: string; onClick?: string } = {}
): UINode {
  const statusIcons: Record<string, Icon> = {
    success: 'success',
    error: 'error',
    warning: 'warning',
    pending: 'pending',
    spinner: 'spinner',
  };

  const statusColors: Record<string, 'success' | 'error' | 'warning' | 'textMuted'> = {
    success: 'success',
    error: 'error',
    warning: 'warning',
    pending: 'textMuted',
    spinner: 'textMuted',
  };

  return row([
    icon(statusIcons[status], {
      color: statusColors[status],
      className: `status-icon ${status}`,
      spin: status === 'spinner',
    }),
    typeof content === 'string' ? text(content) : content,
  ], {
    id: opts.id,
    align: 'center',
    gap: 'sm',
    onClick: opts.onClick,
    className: 'status-row',
  });
}

/**
 * FileRow - File display with name and optional actions
 */
export function fileRow(
  fileName: string,
  opts: {
    id?: string;
    status?: 'pending' | 'applied' | 'rejected';
    actions?: UINode;
    onClick?: string;
    treeBranch?: 'branch' | 'end' | 'none';
  } = {}
): UINode {
  const branchIcon = opts.treeBranch === 'end' ? 'treeEnd' :
                     opts.treeBranch === 'branch' ? 'treeBranch' : null;

  return row([
    branchIcon ? icon(branchIcon, { className: 'tree-branch', mr: 'sm' }) : null,
    icon('file', { mr: 'sm' }),
    text(fileName, { className: 'filename', grow: true, truncate: true }),
    opts.actions,
  ], {
    id: opts.id,
    align: 'center',
    className: `file-row ${opts.status || ''}`.trim(),
    onClick: opts.onClick,
  });
}

/**
 * CommandRow - Shell command display
 */
export function commandRow(
  command: string,
  opts: {
    id?: string;
    status?: 'running' | 'success' | 'error';
    exitCode?: number;
    onClick?: string;
    treeBranch?: 'branch' | 'end' | 'none';
  } = {}
): UINode {
  const branchIcon = opts.treeBranch === 'end' ? 'treeEnd' :
                     opts.treeBranch === 'branch' ? 'treeBranch' : null;

  const statusIcon = opts.status === 'running' ? 'spinner' :
                     opts.status === 'success' ? 'success' :
                     opts.status === 'error' ? 'error' : 'pending';

  return row([
    branchIcon ? icon(branchIcon, { className: 'tree-branch', mr: 'sm' }) : null,
    icon(statusIcon, {
      className: `status ${opts.status || ''}`,
      spin: opts.status === 'running',
    }),
    text(command, { className: 'command', family: 'mono', truncate: true, grow: true }),
    opts.exitCode !== undefined ? text(`(${opts.exitCode})`, { variant: 'muted', size: 'sm' }) : null,
  ], {
    id: opts.id,
    align: 'center',
    gap: 'sm',
    className: 'command-row',
    onClick: opts.onClick,
  });
}

/**
 * ToolRow - Tool call display
 */
export function toolRow(
  toolName: string,
  opts: {
    id?: string;
    status?: 'pending' | 'running' | 'success' | 'error';
    detail?: string;
    onClick?: string;
    treeBranch?: 'branch' | 'end' | 'none';
  } = {}
): UINode {
  const branchIcon = opts.treeBranch === 'end' ? 'treeEnd' :
                     opts.treeBranch === 'branch' ? 'treeBranch' : null;

  const statusIcon = opts.status === 'running' ? 'spinner' :
                     opts.status === 'success' ? 'success' :
                     opts.status === 'error' ? 'error' : 'pending';

  return row([
    branchIcon ? text(branchIcon === 'treeEnd' ? '└─' : '├─', { className: 'tree-branch', mr: 'sm', family: 'mono' }) : null,
    icon(statusIcon, {
      className: `status ${opts.status || ''}`,
      spin: opts.status === 'running',
    }),
    text(toolName, { className: 'tool-name', weight: 'medium' }),
    opts.detail ? text(opts.detail, { variant: 'muted', ml: 'sm', truncate: true }) : null,
  ], {
    id: opts.id,
    align: 'center',
    gap: 'sm',
    className: 'tool-row',
    onClick: opts.onClick,
  });
}

/**
 * Empty state placeholder
 */
export function emptyState(message: string, iconName: Icon = 'info'): UINode {
  return box([
    icon(iconName, { size: 'xl', color: 'textMuted' }),
    text(message, { variant: 'muted', mt: 'sm' }),
  ], {
    flex: 'center',
    p: 'xl',
    className: 'empty-state',
  });
}

/**
 * Loading state
 */
export function loadingState(message: string = 'Loading...'): UINode {
  return row([
    icon('spinner', { spin: true }),
    text(message, { variant: 'muted' }),
  ], {
    align: 'center',
    gap: 'sm',
    p: 'md',
    className: 'loading-state',
  });
}
