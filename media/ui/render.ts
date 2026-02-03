/**
 * UI Renderer
 *
 * Converts UINode definitions to HTML strings and manages Shadow DOM.
 * LLM-friendly: predictable output, explicit transformations.
 */

import type {
  UINode,
  BoxProps,
  TextProps,
  IconProps,
  ButtonProps,
  BadgeProps,
  RowProps,
  StackProps,
  DividerProps,
  DropdownProps,
  ListProps,
  TreeProps,
  TreeItem,
  CardProps,
  SpacingProps,
  LayoutProps,
  EventHandler,
} from './types';
import {
  spacing,
  colors,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  borderRadius,
  borderWidth,
  shadow,
  transition,
  flex,
  icons,
  variants,
  type Spacing,
  type Color,
} from './tokens';

// ============================================
// STYLE GENERATION
// ============================================

/**
 * Convert spacing props to CSS
 */
function spacingToCSS(props: SpacingProps): string {
  const styles: string[] = [];

  // Margin
  if (props.m) styles.push(`margin: ${spacing[props.m]}`);
  if (props.mt) styles.push(`margin-top: ${spacing[props.mt]}`);
  if (props.mr) styles.push(`margin-right: ${spacing[props.mr]}`);
  if (props.mb) styles.push(`margin-bottom: ${spacing[props.mb]}`);
  if (props.ml) styles.push(`margin-left: ${spacing[props.ml]}`);
  if (props.mx) {
    styles.push(`margin-left: ${spacing[props.mx]}`);
    styles.push(`margin-right: ${spacing[props.mx]}`);
  }
  if (props.my) {
    styles.push(`margin-top: ${spacing[props.my]}`);
    styles.push(`margin-bottom: ${spacing[props.my]}`);
  }

  // Padding
  if (props.p) styles.push(`padding: ${spacing[props.p]}`);
  if (props.pt) styles.push(`padding-top: ${spacing[props.pt]}`);
  if (props.pr) styles.push(`padding-right: ${spacing[props.pr]}`);
  if (props.pb) styles.push(`padding-bottom: ${spacing[props.pb]}`);
  if (props.pl) styles.push(`padding-left: ${spacing[props.pl]}`);
  if (props.px) {
    styles.push(`padding-left: ${spacing[props.px]}`);
    styles.push(`padding-right: ${spacing[props.px]}`);
  }
  if (props.py) {
    styles.push(`padding-top: ${spacing[props.py]}`);
    styles.push(`padding-bottom: ${spacing[props.py]}`);
  }

  // Gap
  if (props.gap) styles.push(`gap: ${spacing[props.gap]}`);

  return styles.join('; ');
}

/**
 * Convert layout props to CSS
 */
function layoutToCSS(props: LayoutProps): string {
  const styles: string[] = [];

  if (props.flex) {
    const flexStyles = flex[props.flex];
    Object.entries(flexStyles).forEach(([key, value]) => {
      // Convert camelCase to kebab-case
      const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      styles.push(`${cssKey}: ${value}`);
    });
  }

  if (props.width) {
    styles.push(`width: ${props.width === 'full' ? '100%' : props.width === 'auto' ? 'auto' : props.width}`);
  }
  if (props.height) {
    styles.push(`height: ${props.height === 'full' ? '100%' : props.height === 'auto' ? 'auto' : props.height}`);
  }
  if (props.overflow) styles.push(`overflow: ${props.overflow}`);
  if (props.grow) styles.push('flex-grow: 1');
  if (props.shrink === false) styles.push('flex-shrink: 0');
  if (props.alignSelf) {
    const alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };
    styles.push(`align-self: ${alignMap[props.alignSelf] || props.alignSelf}`);
  }

  return styles.join('; ');
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Build attribute string
 */
function attrs(props: {
  id?: string;
  className?: string;
  style?: string;
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
  onClick?: string;
}): string {
  const parts: string[] = [];

  if (props.id) parts.push(`id="${escapeHtml(props.id)}"`);
  if (props.className) parts.push(`class="${escapeHtml(props.className)}"`);
  if (props.style) parts.push(`style="${escapeHtml(props.style)}"`);
  if (props.testId) parts.push(`data-testid="${escapeHtml(props.testId)}"`);
  if (props.hidden) parts.push('hidden');
  if (props.onClick) parts.push(`data-onclick="${escapeHtml(props.onClick)}"`);

  if (props.data) {
    Object.entries(props.data).forEach(([key, value]) => {
      parts.push(`data-${key}="${escapeHtml(value)}"`);
    });
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ============================================
// COMPONENT RENDERERS
// ============================================

/**
 * Render a UINode to HTML string
 */
export function render(node: UINode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return escapeHtml(node);

  switch (node.type) {
    case 'box': return renderBox(node);
    case 'text': return renderText(node);
    case 'icon': return renderIcon(node);
    case 'button': return renderButton(node);
    case 'badge': return renderBadge(node);
    case 'row': return renderRow(node);
    case 'stack': return renderStack(node);
    case 'divider': return renderDivider(node);
    case 'dropdown': return renderDropdown(node);
    case 'list': return renderList(node);
    case 'tree': return renderTree(node);
    case 'card': return renderCard(node);
    default:
      console.warn('Unknown node type:', (node as { type: string }).type);
      return '';
  }
}

function renderBox(node: BoxProps): string {
  const styleStr = [
    spacingToCSS(node),
    layoutToCSS(node),
    node.bg ? `background: ${colors[node.bg]}` : '',
    node.border?.width ? `border-width: ${borderWidth[node.border.width]}` : '',
    node.border?.color ? `border-color: ${colors[node.border.color]}` : '',
    node.border?.radius ? `border-radius: ${borderRadius[node.border.radius]}` : '',
    node.shadow ? `box-shadow: ${shadow[node.shadow]}` : '',
    node.transition ? `transition: ${transition[node.transition]}` : '',
    node.variant ? Object.entries(variants.container[node.variant]).map(([k, v]) =>
      `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${v}`
    ).join('; ') : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const children = node.children?.map(render).join('') || '';

  return `<div${attrs({ ...node, style: styleStr })}>${children}</div>`;
}

function renderText(node: TextProps): string {
  const styleStr = [
    spacingToCSS(node),
    node.variant ? Object.entries(variants.text[node.variant]).map(([k, v]) =>
      `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${v}`
    ).join('; ') : '',
    node.size ? `font-size: ${fontSize[node.size]}` : '',
    node.weight ? `font-weight: ${fontWeight[node.weight]}` : '',
    node.family ? `font-family: ${fontFamily[node.family]}` : '',
    node.lineHeight ? `line-height: ${lineHeight[node.lineHeight]}` : '',
    node.align ? `text-align: ${node.align}` : '',
    node.truncate ? 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap' : '',
    node.grow ? 'flex-grow: 1' : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const content = node.html ? node.content : escapeHtml(node.content);

  return `<span${attrs({ ...node, style: styleStr })}>${content}</span>`;
}

function renderIcon(node: IconProps): string {
  const iconChar = icons[node.icon] || node.icon;
  const styleStr = [
    spacingToCSS(node),
    node.size ? `font-size: ${fontSize[node.size]}` : '',
    node.color ? `color: ${colors[node.color]}` : '',
    node.spin ? 'animation: spin 1s linear infinite' : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const spinClass = node.spin ? ' spin' : '';

  return `<span${attrs({ ...node, style: styleStr, className: `icon${spinClass} ${node.className || ''}`.trim() })}>${iconChar}</span>`;
}

function renderButton(node: ButtonProps): string {
  const variantStyles = node.variant ? variants.button[node.variant] : {};
  const sizeStyles = {
    sm: 'padding: 2px 6px; font-size: 11px',
    md: 'padding: 4px 10px; font-size: 13px',
    lg: 'padding: 6px 14px; font-size: 14px',
  };

  const styleStr = [
    spacingToCSS(node),
    Object.entries(variantStyles).map(([k, v]) =>
      `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${v}`
    ).join('; '),
    sizeStyles[node.size || 'md'],
    'cursor: pointer; border-radius: 3px',
    node.disabled ? 'opacity: 0.5; cursor: not-allowed' : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const iconLeft = node.icon && node.iconPosition !== 'right'
    ? `<span class="btn-icon">${icons[node.icon]}</span>` : '';
  const iconRight = node.icon && node.iconPosition === 'right'
    ? `<span class="btn-icon">${icons[node.icon]}</span>` : '';
  const label = node.label ? `<span class="btn-label">${escapeHtml(node.label)}</span>` : '';

  const disabledAttr = node.disabled ? ' disabled' : '';

  return `<button${attrs({ ...node, style: styleStr })}${disabledAttr}>${iconLeft}${label}${iconRight}</button>`;
}

function renderBadge(node: BadgeProps): string {
  const variantStyles = node.variant ? variants.badge[node.variant] : variants.badge.default;
  const styleStr = [
    Object.entries(variantStyles).map(([k, v]) =>
      `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${v}`
    ).join('; '),
    'display: inline-block; font-size: 11px',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  return `<span${attrs({ ...node, style: styleStr, className: `badge ${node.className || ''}`.trim() })}>${escapeHtml(node.content)}</span>`;
}

function renderRow(node: RowProps): string {
  const alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch', baseline: 'baseline' };
  const justifyMap = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between', around: 'space-around' };

  const styleStr = [
    'display: flex; flex-direction: row',
    spacingToCSS(node),
    layoutToCSS(node),
    node.align ? `align-items: ${alignMap[node.align]}` : 'align-items: center',
    node.justify ? `justify-content: ${justifyMap[node.justify]}` : '',
    node.wrap ? 'flex-wrap: wrap' : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const children = node.children.map(render).join('');

  return `<div${attrs({ ...node, style: styleStr, className: `row ${node.className || ''}`.trim(), onClick: node.onClick })}>${children}</div>`;
}

function renderStack(node: StackProps): string {
  const alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch' };

  const styleStr = [
    'display: flex; flex-direction: column',
    spacingToCSS(node),
    layoutToCSS(node),
    node.align ? `align-items: ${alignMap[node.align]}` : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const children = node.children.map(render).join('');

  return `<div${attrs({ ...node, style: styleStr, className: `stack ${node.className || ''}`.trim() })}>${children}</div>`;
}

function renderDivider(node: DividerProps): string {
  const isVertical = node.orientation === 'vertical';
  const styleStr = [
    spacingToCSS(node),
    isVertical ? 'width: 1px; height: 100%' : 'height: 1px; width: 100%',
    `background: ${node.color ? colors[node.color] : colors.border}`,
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  return `<div${attrs({ ...node, style: styleStr, className: `divider ${node.className || ''}`.trim() })}></div>`;
}

function renderDropdown(node: DropdownProps): string {
  const expandedClass = node.expanded ? 'expanded' : 'collapsed';
  const animClass = node.animation || 'slide';

  const styleStr = [
    spacingToCSS(node),
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const header = render(node.header);
  const body = render(node.body);

  return `<div${attrs({ ...node, style: styleStr, className: `dropdown ${expandedClass} ${animClass} ${node.className || ''}`.trim() })}>
  <div class="dropdown-header" data-onclick="${node.onToggle || 'toggle'}">${header}</div>
  <div class="dropdown-body">${body}</div>
</div>`;
}

function renderList(node: ListProps): string {
  const styleStr = [
    spacingToCSS(node),
    'display: flex; flex-direction: column',
    node.gap ? `gap: ${spacing[node.gap]}` : '',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  let children = '';
  node.items.forEach((item, i) => {
    children += render(item);
    if (node.dividers && i < node.items.length - 1) {
      children += renderDivider({ type: 'divider', my: 'sm' });
    }
  });

  return `<div${attrs({ ...node, style: styleStr, className: `list ${node.className || ''}`.trim() })}>${children}</div>`;
}

function renderTree(node: TreeProps): string {
  const styleStr = [
    spacingToCSS(node),
    'display: flex; flex-direction: column',
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  function renderTreeItem(item: TreeItem, depth: number = 0): string {
    const branchChar = item.isLast ? icons.treeEnd : icons.treeBranch;
    const indent = '     '.repeat(depth);
    const prefix = depth > 0 ? `<span class="tree-prefix">${indent}${branchChar} </span>` : '';

    let html = `<div class="tree-item" style="display: flex; align-items: center;">${prefix}${render(item.content)}</div>`;

    if (item.children) {
      item.children.forEach((child, i) => {
        html += renderTreeItem({ ...child, isLast: i === item.children!.length - 1 }, depth + 1);
      });
    }

    return html;
  }

  const children = node.items.map((item, i) =>
    renderTreeItem({ ...item, isLast: i === node.items.length - 1 })
  ).join('');

  return `<div${attrs({ ...node, style: styleStr, className: `tree ${node.className || ''}`.trim() })}>${children}</div>`;
}

function renderCard(node: CardProps): string {
  const variantStyles = node.variant ? variants.container[node.variant] : variants.container.card;
  const styleStr = [
    spacingToCSS(node),
    Object.entries(variantStyles).map(([k, v]) =>
      `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}: ${v}`
    ).join('; '),
    node.style ? Object.entries(node.style).map(([k, v]) => `${k}: ${v}`).join('; ') : '',
  ].filter(Boolean).join('; ');

  const header = node.header ? `<div class="card-header">${render(node.header)}</div>` : '';
  const body = `<div class="card-body">${render(node.body)}</div>`;
  const footer = node.footer ? `<div class="card-footer">${render(node.footer)}</div>` : '';

  return `<div${attrs({ ...node, style: styleStr, className: `card ${node.className || ''}`.trim() })}>${header}${body}${footer}</div>`;
}

// ============================================
// BASE STYLES
// ============================================

/**
 * Base CSS for the UI framework
 * Include this in your Shadow DOM
 */
export const baseStyles = `
/* Reset */
*, *::before, *::after {
  box-sizing: border-box;
}

/* Animations */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideDown {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 1000px; }
}

/* Base styles */
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.icon.spin {
  animation: spin 1s linear infinite;
}

/* Dropdown */
.dropdown {
  cursor: pointer;
  user-select: none;
}

.dropdown-header {
  cursor: pointer;
}

.dropdown-body {
  overflow: hidden;
}

.dropdown.collapsed .dropdown-body {
  display: none;
}

.dropdown.slide .dropdown-body {
  transition: max-height 200ms ease, opacity 200ms ease;
}

.dropdown.slide.collapsed .dropdown-body {
  max-height: 0;
  opacity: 0;
}

.dropdown.slide.expanded .dropdown-body {
  max-height: 1000px;
  opacity: 1;
}

.dropdown.fade .dropdown-body {
  transition: opacity 200ms ease;
}

.dropdown.fade.collapsed .dropdown-body {
  opacity: 0;
}

/* Clickable */
.clickable {
  cursor: pointer;
}

.clickable:hover {
  background: ${colors.bgHover};
}

/* Button */
button {
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

button:hover:not(:disabled) {
  filter: brightness(1.1);
}

/* Tree */
.tree-prefix {
  font-family: ${fontFamily.mono};
  color: ${colors.textMuted};
  white-space: pre;
}

/* Status colors */
.status.success { color: ${colors.success}; }
.status.error { color: ${colors.error}; }
.status.warning { color: ${colors.warning}; }
.status.pending { color: ${colors.textMuted}; }
.status.running { color: ${colors.info}; }

/* Utility */
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grow {
  flex-grow: 1;
}

.shrink-0 {
  flex-shrink: 0;
}
`;

// ============================================
// SHADOW DOM HELPERS
// ============================================

/**
 * Render into a Shadow DOM
 */
export function renderToShadow(
  shadowRoot: ShadowRoot,
  content: UINode,
  additionalStyles: string = ''
): void {
  const html = render(content);
  shadowRoot.innerHTML = `
    <style>${baseStyles}${additionalStyles}</style>
    ${html}
  `;
}

/**
 * Bind event handlers in Shadow DOM
 */
export function bindEvents(
  shadowRoot: ShadowRoot,
  handlers: Record<string, (event: Event, element: HTMLElement) => void>
): void {
  // Bind click handlers
  shadowRoot.querySelectorAll('[data-onclick]').forEach(el => {
    const handlerName = el.getAttribute('data-onclick');
    if (handlerName && handlers[handlerName]) {
      el.addEventListener('click', (e) => {
        handlers[handlerName](e, el as HTMLElement);
      });
    }
  });
}
