/**
 * UI Framework Types
 *
 * All types are explicit and documented.
 * LLM-friendly: clear structure, no ambiguity.
 */

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
  Flex,
  Icon,
  ContainerVariant,
  ButtonVariant,
  TextVariant,
  BadgeVariant,
} from './tokens';

// ============================================
// BASE COMPONENT PROPS
// ============================================

/**
 * Common props all components can have
 */
export interface BaseProps {
  /** Unique identifier for the element */
  id?: string;
  /** CSS class names to add */
  className?: string;
  /** Inline styles (use sparingly - prefer tokens) */
  style?: Record<string, string>;
  /** Data attributes */
  data?: Record<string, string>;
  /** Test ID for testing */
  testId?: string;
  /** Whether element is hidden */
  hidden?: boolean;
}

/**
 * Spacing props for margin and padding
 */
export interface SpacingProps {
  /** Margin on all sides */
  m?: Spacing;
  /** Margin top */
  mt?: Spacing;
  /** Margin right */
  mr?: Spacing;
  /** Margin bottom */
  mb?: Spacing;
  /** Margin left */
  ml?: Spacing;
  /** Margin horizontal (left + right) */
  mx?: Spacing;
  /** Margin vertical (top + bottom) */
  my?: Spacing;

  /** Padding on all sides */
  p?: Spacing;
  /** Padding top */
  pt?: Spacing;
  /** Padding right */
  pr?: Spacing;
  /** Padding bottom */
  pb?: Spacing;
  /** Padding left */
  pl?: Spacing;
  /** Padding horizontal (left + right) */
  px?: Spacing;
  /** Padding vertical (top + bottom) */
  py?: Spacing;

  /** Gap between children (for flex/grid) */
  gap?: Spacing;
}

/**
 * Layout props for positioning
 */
export interface LayoutProps {
  /** Flex layout preset */
  flex?: Flex;
  /** Width: 'full' = 100%, 'auto' = auto, or specific value */
  width?: 'full' | 'auto' | string;
  /** Height: 'full' = 100%, 'auto' = auto, or specific value */
  height?: 'full' | 'auto' | string;
  /** Overflow behavior */
  overflow?: 'visible' | 'hidden' | 'scroll' | 'auto';
  /** Flex grow */
  grow?: boolean;
  /** Flex shrink */
  shrink?: boolean;
  /** Align self */
  alignSelf?: 'start' | 'center' | 'end' | 'stretch';
}

// ============================================
// COMPONENT DEFINITIONS
// ============================================

/**
 * Box - The base container component
 */
export interface BoxProps extends BaseProps, SpacingProps, LayoutProps {
  type: 'box';
  variant?: ContainerVariant;
  bg?: Color;
  border?: {
    width?: BorderWidth;
    color?: Color;
    radius?: BorderRadius;
  };
  shadow?: Shadow;
  transition?: Transition;
  children?: UINode[];
  /** Click handler name (resolved by actor) */
  onClick?: string;
}

/**
 * Text - For displaying text content
 */
export interface TextProps extends BaseProps, SpacingProps {
  type: 'text';
  content: string;
  variant?: TextVariant;
  size?: FontSize;
  weight?: FontWeight;
  family?: FontFamily;
  lineHeight?: LineHeight;
  align?: 'left' | 'center' | 'right';
  truncate?: boolean;
  /** If true, content is rendered as HTML (be careful!) */
  html?: boolean;
  /** Flex grow */
  grow?: boolean;
}

/**
 * Icon - For displaying icons
 */
export interface IconProps extends BaseProps, SpacingProps {
  type: 'icon';
  icon: Icon;
  size?: FontSize;
  color?: Color;
  spin?: boolean;
}

/**
 * Button - Interactive button
 */
export interface ButtonProps extends BaseProps, SpacingProps {
  type: 'button';
  label?: string;
  icon?: Icon;
  iconPosition?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: string;
}

/**
 * Badge - Small label/tag
 */
export interface BadgeProps extends BaseProps {
  type: 'badge';
  content: string;
  variant?: BadgeVariant;
}

/**
 * Row - Horizontal flex container
 */
export interface RowProps extends BaseProps, SpacingProps, LayoutProps {
  type: 'row';
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  children: UINode[];
  /** Click handler name (resolved by actor) */
  onClick?: string;
}

/**
 * Stack - Vertical flex container
 */
export interface StackProps extends BaseProps, SpacingProps, LayoutProps {
  type: 'stack';
  align?: 'start' | 'center' | 'end' | 'stretch';
  children: UINode[];
}

/**
 * Divider - Visual separator
 */
export interface DividerProps extends BaseProps, SpacingProps {
  type: 'divider';
  orientation?: 'horizontal' | 'vertical';
  color?: Color;
}

// ============================================
// COMPOSITE COMPONENTS
// ============================================

/**
 * Dropdown - Expandable container
 */
export interface DropdownProps extends BaseProps, SpacingProps {
  type: 'dropdown';
  /** Header content when collapsed */
  header: UINode;
  /** Body content when expanded */
  body: UINode;
  /** Current expanded state */
  expanded: boolean;
  /** Animation style */
  animation?: 'none' | 'slide' | 'fade';
  /** Click handler name for toggle */
  onToggle?: string;
}

/**
 * List - Renders array of items
 */
export interface ListProps extends BaseProps, SpacingProps {
  type: 'list';
  items: UINode[];
  /** Gap between items */
  gap?: Spacing;
  /** Show dividers between items */
  dividers?: boolean;
}

/**
 * Tree - Hierarchical list with branches
 */
export interface TreeProps extends BaseProps, SpacingProps {
  type: 'tree';
  items: TreeItem[];
}

export interface TreeItem {
  content: UINode;
  isLast?: boolean;
  children?: TreeItem[];
}

/**
 * Card - Styled container
 */
export interface CardProps extends BaseProps, SpacingProps {
  type: 'card';
  header?: UINode;
  body: UINode;
  footer?: UINode;
  variant?: ContainerVariant;
}

// ============================================
// UNION TYPE
// ============================================

/**
 * All possible UI nodes
 */
export type UINode =
  | BoxProps
  | TextProps
  | IconProps
  | ButtonProps
  | BadgeProps
  | RowProps
  | StackProps
  | DividerProps
  | DropdownProps
  | ListProps
  | TreeProps
  | CardProps
  | string  // Raw text shorthand
  | null;   // Nothing

/**
 * Component definition for building components
 */
export interface ComponentDef<P extends BaseProps = BaseProps> {
  /** Component type name */
  type: string;
  /** Default props */
  defaults?: Partial<P>;
  /** Render function */
  render: (props: P) => string;
  /** CSS styles */
  styles?: string;
}

// ============================================
// STATE & EVENTS
// ============================================

/**
 * Event handler definition
 */
export interface EventHandler {
  /** Element selector or ID */
  target: string;
  /** DOM event type */
  event: 'click' | 'change' | 'input' | 'focus' | 'blur' | 'keydown' | 'keyup';
  /** Handler name (resolved by actor) */
  handler: string;
  /** Prevent default behavior */
  preventDefault?: boolean;
  /** Stop propagation */
  stopPropagation?: boolean;
}

/**
 * Component state for reactive updates
 */
export interface ComponentState {
  [key: string]: unknown;
}

// ============================================
// RENDER CONTEXT
// ============================================

/**
 * Context passed to render functions
 */
export interface RenderContext {
  /** Current component state */
  state: ComponentState;
  /** Event handlers to bind */
  handlers: Map<string, (event: Event) => void>;
  /** Shadow root to render into */
  shadowRoot: ShadowRoot;
  /** Parent actor for pub/sub */
  actorId: string;
}
