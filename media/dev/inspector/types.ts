/**
 * Inspector types
 */

export interface StyleProperty {
  name: string;
  cssProperty: string;
  value: number;
  defaultValue: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Preset keyword values (e.g., 'auto', '100%', 'inherit') */
  presets?: string[];
  /** Whether this is a color property (non-numeric value) */
  isColor?: boolean;
}

/**
 * Common presets by property type
 */
export const PRESETS = {
  sizing: ['auto', '100%', 'fit-content', 'min-content', 'max-content', 'inherit'],
  spacing: ['auto', '0', 'inherit'],
  margin: ['auto', '0', 'inherit'],
  padding: ['0', 'inherit'],
  gap: ['0', 'normal', 'inherit'],
  typography: ['inherit', 'initial', 'unset'],
  lineHeight: ['normal', 'inherit', 'initial'],
  fontWeight: ['normal', 'bold', 'lighter', 'bolder', 'inherit'],
  opacity: ['0', '0.5', '1', 'inherit'],
  borderRadius: ['0', '50%', 'inherit'],
  borderWidth: ['0', 'thin', 'medium', 'thick', 'inherit'],
} as const;

export interface StyleCategory {
  id: string;
  name: string;
  icon: string;
  properties: StyleProperty[];
}

export interface InspectedElement {
  /** The actual DOM element being inspected */
  element: HTMLElement;
  /** CSS path for display */
  path: string;
  /** Whether element is inside a shadow root */
  inShadowDOM: boolean;
  /** The shadow root if element is in shadow DOM */
  shadowRoot: ShadowRoot | null;
  /** Computed styles for all tracked properties */
  computedStyles: Map<string, number>;
}

export interface InspectorState {
  visible: boolean;
  inspectMode: boolean;
  selectedElement: InspectedElement | null;
  styleOverrides: Map<string, string>;
  expandedCategories: Set<string>;
  customProperties: StyleProperty[];
}

/**
 * Style categories with properties organized by type.
 */
export const STYLE_CATEGORIES: StyleCategory[] = [
  {
    id: 'spacing',
    name: 'Spacing',
    icon: '⬚',
    properties: [
      { name: 'Padding Top', cssProperty: 'padding-top', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 64, step: 1, presets: PRESETS.padding },
      { name: 'Padding Right', cssProperty: 'padding-right', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 64, step: 1, presets: PRESETS.padding },
      { name: 'Padding Bottom', cssProperty: 'padding-bottom', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 64, step: 1, presets: PRESETS.padding },
      { name: 'Padding Left', cssProperty: 'padding-left', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 64, step: 1, presets: PRESETS.padding },
      { name: 'Margin Top', cssProperty: 'margin-top', value: 0, defaultValue: 0, unit: 'px', min: -32, max: 64, step: 1, presets: PRESETS.margin },
      { name: 'Margin Right', cssProperty: 'margin-right', value: 0, defaultValue: 0, unit: 'px', min: -32, max: 64, step: 1, presets: PRESETS.margin },
      { name: 'Margin Bottom', cssProperty: 'margin-bottom', value: 0, defaultValue: 0, unit: 'px', min: -32, max: 64, step: 1, presets: PRESETS.margin },
      { name: 'Margin Left', cssProperty: 'margin-left', value: 0, defaultValue: 0, unit: 'px', min: -32, max: 64, step: 1, presets: PRESETS.margin },
      { name: 'Gap', cssProperty: 'gap', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 48, step: 1, presets: PRESETS.gap },
    ]
  },
  {
    id: 'sizing',
    name: 'Sizing',
    icon: '↔',
    properties: [
      { name: 'Width', cssProperty: 'width', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 800, step: 1, presets: PRESETS.sizing },
      { name: 'Min Width', cssProperty: 'min-width', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 500, step: 1, presets: PRESETS.sizing },
      { name: 'Max Width', cssProperty: 'max-width', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 1200, step: 1, presets: ['none', ...PRESETS.sizing] },
      { name: 'Height', cssProperty: 'height', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 800, step: 1, presets: PRESETS.sizing },
      { name: 'Min Height', cssProperty: 'min-height', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 500, step: 1, presets: PRESETS.sizing },
      { name: 'Max Height', cssProperty: 'max-height', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 1200, step: 1, presets: ['none', ...PRESETS.sizing] },
    ]
  },
  {
    id: 'typography',
    name: 'Typography',
    icon: 'T',
    properties: [
      { name: 'Font Size', cssProperty: 'font-size', value: 13, defaultValue: 13, unit: 'px', min: 8, max: 32, step: 1, presets: ['smaller', 'larger', 'inherit', 'initial'] },
      { name: 'Font Weight', cssProperty: 'font-weight', value: 400, defaultValue: 400, unit: '', min: 100, max: 900, step: 100, presets: PRESETS.fontWeight },
      { name: 'Line Height', cssProperty: 'line-height', value: 1.4, defaultValue: 1.4, unit: '', min: 0.8, max: 3, step: 0.1, presets: PRESETS.lineHeight },
      { name: 'Letter Spacing', cssProperty: 'letter-spacing', value: 0, defaultValue: 0, unit: 'px', min: -2, max: 10, step: 0.5, presets: ['normal', 'inherit'] },
      { name: 'Word Spacing', cssProperty: 'word-spacing', value: 0, defaultValue: 0, unit: 'px', min: -5, max: 20, step: 1, presets: ['normal', 'inherit'] },
    ]
  },
  {
    id: 'visual',
    name: 'Visual',
    icon: '◐',
    properties: [
      { name: 'Opacity', cssProperty: 'opacity', value: 1, defaultValue: 1, unit: '', min: 0, max: 1, step: 0.05, presets: PRESETS.opacity },
      { name: 'Border Radius', cssProperty: 'border-radius', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 50, step: 1, presets: PRESETS.borderRadius },
      { name: 'Border Width', cssProperty: 'border-width', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 10, step: 1, presets: PRESETS.borderWidth },
      { name: 'Outline Width', cssProperty: 'outline-width', value: 0, defaultValue: 0, unit: 'px', min: 0, max: 10, step: 1, presets: PRESETS.borderWidth },
      { name: 'Outline Offset', cssProperty: 'outline-offset', value: 0, defaultValue: 0, unit: 'px', min: -5, max: 20, step: 1, presets: ['0', 'inherit'] },
    ]
  },
];

/**
 * Get all properties from all categories as a flat list.
 * Used for reading computed styles.
 */
export function getAllStyleProperties(): StyleProperty[] {
  return STYLE_CATEGORIES.flatMap(cat => cat.properties);
}

/**
 * Legacy export for backwards compatibility.
 * @deprecated Use STYLE_CATEGORIES instead
 */
export const DEFAULT_STYLE_PROPERTIES: StyleProperty[] = getAllStyleProperties();
