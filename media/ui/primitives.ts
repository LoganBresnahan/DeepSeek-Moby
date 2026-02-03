/**
 * Primitive Components
 *
 * Building blocks for UI. Pure functions that return UINode definitions.
 * LLM-friendly: simple, composable, predictable.
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
} from './types';
import type {
  Spacing,
  Color,
  FontSize,
  FontWeight,
  FontFamily,
  LineHeight,
  BorderRadius,
  BorderWidth,
  Shadow,
  Transition,
  ContainerVariant,
  ButtonVariant,
  TextVariant,
  BadgeVariant,
  Icon,
  Flex,
} from './tokens';

// ============================================
// BOX
// ============================================

interface BoxOptions {
  id?: string;
  className?: string;
  variant?: ContainerVariant;
  bg?: Color;
  border?: { width?: BorderWidth; color?: Color; radius?: BorderRadius };
  shadow?: Shadow;
  transition?: Transition;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  gap?: Spacing;
  // Layout
  flex?: Flex;
  width?: 'full' | 'auto' | string;
  height?: 'full' | 'auto' | string;
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  grow?: boolean;
  shrink?: boolean;
  // Events
  onClick?: string;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Box - Base container component
 */
export function box(children: UINode | UINode[], options: BoxOptions = {}): BoxProps {
  return {
    type: 'box',
    children: Array.isArray(children) ? children : [children],
    ...options,
  };
}

// ============================================
// TEXT
// ============================================

interface TextOptions {
  id?: string;
  className?: string;
  variant?: TextVariant;
  size?: FontSize;
  weight?: FontWeight;
  family?: FontFamily;
  lineHeight?: LineHeight;
  align?: 'left' | 'center' | 'right';
  truncate?: boolean;
  html?: boolean;
  grow?: boolean;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Text - Display text content
 */
export function text(content: string, options: TextOptions = {}): TextProps {
  return {
    type: 'text',
    content,
    ...options,
  };
}

// ============================================
// ICON
// ============================================

interface IconOptions {
  id?: string;
  className?: string;
  size?: FontSize;
  color?: Color;
  spin?: boolean;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Icon - Display an icon
 */
export function icon(iconName: Icon, options: IconOptions = {}): IconProps {
  return {
    type: 'icon',
    icon: iconName,
    ...options,
  };
}

// ============================================
// BUTTON
// ============================================

interface ButtonOptions {
  id?: string;
  className?: string;
  label?: string;
  icon?: Icon;
  iconPosition?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: string;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Button - Interactive button
 */
export function button(options: ButtonOptions): ButtonProps {
  return {
    type: 'button',
    ...options,
  };
}

// ============================================
// BADGE
// ============================================

interface BadgeOptions {
  id?: string;
  className?: string;
  variant?: BadgeVariant;
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Badge - Small label/tag
 */
export function badge(content: string, options: BadgeOptions = {}): BadgeProps {
  return {
    type: 'badge',
    content,
    ...options,
  };
}

// ============================================
// ROW
// ============================================

interface RowOptions {
  id?: string;
  className?: string;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  gap?: Spacing;
  // Layout
  width?: 'full' | 'auto' | string;
  height?: 'full' | 'auto' | string;
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  grow?: boolean;
  shrink?: boolean;
  // Events
  onClick?: string;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Row - Horizontal flex container
 */
export function row(children: UINode[], options: RowOptions = {}): RowProps {
  return {
    type: 'row',
    children,
    ...options,
  };
}

// ============================================
// STACK
// ============================================

interface StackOptions {
  id?: string;
  className?: string;
  align?: 'start' | 'center' | 'end' | 'stretch';
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  p?: Spacing; pt?: Spacing; pr?: Spacing; pb?: Spacing; pl?: Spacing;
  px?: Spacing; py?: Spacing;
  gap?: Spacing;
  // Layout
  width?: 'full' | 'auto' | string;
  height?: 'full' | 'auto' | string;
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  grow?: boolean;
  shrink?: boolean;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Stack - Vertical flex container
 */
export function stack(children: UINode[], options: StackOptions = {}): StackProps {
  return {
    type: 'stack',
    children,
    ...options,
  };
}

// ============================================
// DIVIDER
// ============================================

interface DividerOptions {
  id?: string;
  className?: string;
  orientation?: 'horizontal' | 'vertical';
  color?: Color;
  // Spacing
  m?: Spacing; mt?: Spacing; mr?: Spacing; mb?: Spacing; ml?: Spacing;
  mx?: Spacing; my?: Spacing;
  // Data
  data?: Record<string, string>;
  testId?: string;
  hidden?: boolean;
}

/**
 * Divider - Visual separator
 */
export function divider(options: DividerOptions = {}): DividerProps {
  return {
    type: 'divider',
    ...options,
  };
}

// ============================================
// CONVENIENCE HELPERS
// ============================================

/**
 * Spacer - Empty box for spacing
 */
export function spacer(size: Spacing = 'md'): BoxProps {
  return box(null, { p: size });
}

/**
 * Clickable - Wrapper that makes content clickable
 */
export function clickable(children: UINode | UINode[], handler: string, options: BoxOptions = {}): BoxProps {
  return box(children, { ...options, onClick: handler, className: `clickable ${options.className || ''}`.trim() });
}

/**
 * Hidden - Conditionally hidden content
 */
export function hidden(show: boolean, content: UINode): UINode {
  if (!show) return null;
  return content;
}

/**
 * Conditional - Render based on condition
 */
export function when<T>(condition: T | null | undefined, render: (value: T) => UINode): UINode {
  if (condition === null || condition === undefined) return null;
  return render(condition);
}

/**
 * List mapping helper
 */
export function each<T>(items: T[], render: (item: T, index: number) => UINode): UINode[] {
  return items.map(render);
}
