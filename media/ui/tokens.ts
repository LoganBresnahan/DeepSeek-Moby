/**
 * Design Tokens
 *
 * Constrained set of values for consistent UI.
 * LLM-friendly: finite choices, clear names, no magic numbers.
 */

// ============================================
// SPACING - Use names, not pixels
// ============================================
export const spacing = {
  none: '0',
  xs: '2px',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '24px',
} as const;

export type Spacing = keyof typeof spacing;

// ============================================
// COLORS - VS Code theme variables
// ============================================
export const colors = {
  // Text
  text: 'var(--vscode-foreground)',
  textMuted: 'var(--vscode-descriptionForeground)',
  textDisabled: 'var(--vscode-disabledForeground)',

  // Backgrounds
  bg: 'var(--vscode-editor-background)',
  bgHover: 'var(--vscode-list-hoverBackground)',
  bgActive: 'var(--vscode-list-activeSelectionBackground)',
  bgInput: 'var(--vscode-input-background)',

  // Borders
  border: 'var(--vscode-panel-border)',
  borderFocus: 'var(--vscode-focusBorder)',

  // Semantic
  success: 'var(--vscode-testing-iconPassed)',
  error: 'var(--vscode-testing-iconFailed)',
  warning: 'var(--vscode-editorWarning-foreground)',
  info: 'var(--vscode-editorInfo-foreground)',

  // Interactive
  link: 'var(--vscode-textLink-foreground)',
  linkHover: 'var(--vscode-textLink-activeForeground)',
  button: 'var(--vscode-button-background)',
  buttonText: 'var(--vscode-button-foreground)',
  buttonHover: 'var(--vscode-button-hoverBackground)',
} as const;

export type Color = keyof typeof colors;

// ============================================
// TYPOGRAPHY
// ============================================
export const fontFamily = {
  default: 'var(--vscode-font-family)',
  mono: "var(--vscode-editor-font-family, 'SF Mono', 'Fira Code', Consolas, monospace)",
} as const;

export const fontSize = {
  xs: '10px',
  sm: '11px',
  md: '13px',
  lg: '14px',
  xl: '16px',
} as const;

export const fontWeight = {
  normal: '400',
  medium: '500',
  bold: '600',
} as const;

export const lineHeight = {
  tight: '1.2',
  normal: '1.4',
  relaxed: '1.6',
} as const;

export type FontFamily = keyof typeof fontFamily;
export type FontSize = keyof typeof fontSize;
export type FontWeight = keyof typeof fontWeight;
export type LineHeight = keyof typeof lineHeight;

// ============================================
// BORDERS
// ============================================
export const borderRadius = {
  none: '0',
  sm: '2px',
  md: '4px',
  lg: '6px',
  full: '9999px',
} as const;

export const borderWidth = {
  none: '0',
  thin: '1px',
  medium: '2px',
} as const;

export type BorderRadius = keyof typeof borderRadius;
export type BorderWidth = keyof typeof borderWidth;

// ============================================
// SHADOWS
// ============================================
export const shadow = {
  none: 'none',
  sm: '0 1px 2px rgba(0, 0, 0, 0.1)',
  md: '0 2px 4px rgba(0, 0, 0, 0.15)',
  lg: '0 4px 8px rgba(0, 0, 0, 0.2)',
} as const;

export type Shadow = keyof typeof shadow;

// ============================================
// TRANSITIONS
// ============================================
export const transition = {
  none: 'none',
  fast: '100ms ease',
  normal: '200ms ease',
  slow: '300ms ease',
} as const;

export type Transition = keyof typeof transition;

// ============================================
// LAYOUT
// ============================================
export const flex = {
  row: { display: 'flex', flexDirection: 'row' },
  col: { display: 'flex', flexDirection: 'column' },
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  between: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  start: { display: 'flex', alignItems: 'flex-start' },
  end: { display: 'flex', alignItems: 'flex-end' },
} as const;

export type Flex = keyof typeof flex;

// ============================================
// ICONS - Predefined icon set
// ============================================
export const icons = {
  // Toggles
  expandPlus: '+',
  collapseMinus: '-',
  expandArrow: '▶',
  collapseArrow: '▼',

  // Status
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  pending: '○',
  spinner: '◐',

  // Actions
  close: '×',
  add: '+',
  remove: '-',
  edit: '✎',
  copy: '⎘',
  check: '✓',

  // File types
  file: '📄',
  folder: '📁',
  code: '{ }',

  // Semantic
  thinking: '💭',
  tools: '🔧',
  shell: '⌘',
  message: '💬',

  // Tree
  treeBranch: '├─',
  treeEnd: '└─',
  treeLine: '│',
} as const;

export type Icon = keyof typeof icons;

// ============================================
// COMPONENT VARIANTS
// ============================================
export const variants = {
  // Container styles
  container: {
    plain: {},
    bordered: { border: `${borderWidth.thin} solid ${colors.border}` },
    card: {
      border: `${borderWidth.thin} solid ${colors.border}`,
      borderRadius: borderRadius.md,
      background: colors.bg,
    },
  },

  // Button styles
  button: {
    primary: {
      background: colors.button,
      color: colors.buttonText,
      border: 'none',
    },
    secondary: {
      background: 'transparent',
      color: colors.text,
      border: `${borderWidth.thin} solid ${colors.border}`,
    },
    ghost: {
      background: 'transparent',
      color: colors.text,
      border: 'none',
    },
    link: {
      background: 'transparent',
      color: colors.link,
      border: 'none',
      textDecoration: 'underline',
    },
  },

  // Text styles
  text: {
    default: { color: colors.text },
    muted: { color: colors.textMuted },
    success: { color: colors.success },
    error: { color: colors.error },
    warning: { color: colors.warning },
    info: { color: colors.info },
  },

  // Badge styles
  badge: {
    default: {
      background: colors.bgHover,
      color: colors.text,
      padding: `${spacing.xs} ${spacing.sm}`,
      borderRadius: borderRadius.sm,
    },
    success: {
      background: colors.success,
      color: colors.buttonText,
      padding: `${spacing.xs} ${spacing.sm}`,
      borderRadius: borderRadius.sm,
    },
    error: {
      background: colors.error,
      color: colors.buttonText,
      padding: `${spacing.xs} ${spacing.sm}`,
      borderRadius: borderRadius.sm,
    },
  },
} as const;

export type ContainerVariant = keyof typeof variants.container;
export type ButtonVariant = keyof typeof variants.button;
export type TextVariant = keyof typeof variants.text;
export type BadgeVariant = keyof typeof variants.badge;
