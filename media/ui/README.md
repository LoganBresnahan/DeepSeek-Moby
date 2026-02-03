# UI Framework

A declarative, constraint-based UI framework optimized for LLM collaboration.

## Design Principles

1. **Declarative** - Describe WHAT, not HOW
2. **Constrained** - Finite choices (tokens), not infinite (raw CSS)
3. **Composable** - Small primitives that combine predictably
4. **Explicit** - No magic, all state visible
5. **Typed** - Full TypeScript support

## Quick Start

```typescript
import { ui, render, renderToShadow, bindEvents } from './ui';

// Define a component
const myComponent = ui.dropdown(
  ui.dropdownHeader('Tools', { expanded: false, icon: 'tools', badge: '[3]' }),
  ui.list([
    ui.toolRow('Read', { status: 'success', detail: 'file.ts' }),
    ui.toolRow('Write', { status: 'running' }),
  ]),
  { expanded: false, onToggle: 'handleToggle' }
);

// Render to Shadow DOM
renderToShadow(shadowRoot, myComponent, customStyles);

// Bind events
bindEvents(shadowRoot, {
  handleToggle: () => this.toggleExpanded()
});
```

## Architecture

```
media/ui/
├── tokens.ts      # Design tokens (spacing, colors, icons)
├── types.ts       # TypeScript types
├── primitives.ts  # Base components (box, text, row, etc.)
├── components.ts  # Composite components (dropdown, list, card)
├── render.ts      # Converts UINode → HTML
├── UIActor.ts     # Base class for actor integration
└── index.ts       # Main exports
```

## Tokens

Use tokens instead of raw CSS values. This ensures consistency and makes it easy for LLMs to generate correct code.

### Spacing

```typescript
// ✅ Good - use token names
ui.box(content, { p: 'md', m: 'lg' })

// ❌ Bad - raw pixels
ui.box(content, { style: { padding: '8px' } })
```

Available: `none`, `xs`, `sm`, `md`, `lg`, `xl`, `xxl`

### Colors

```typescript
// ✅ Good - semantic color names
ui.text('Error', { variant: 'error' })
ui.icon('check', { color: 'success' })

// ❌ Bad - raw colors
ui.text('Error', { style: { color: 'red' } })
```

Available: `text`, `textMuted`, `success`, `error`, `warning`, `info`, etc.

### Icons

```typescript
// ✅ Good - icon names
ui.icon('success')  // → ✓
ui.icon('tools')    // → 🔧
ui.icon('treeBranch') // → ├─
```

Available: See `tokens.ts` for full list.

## Primitives

### box
Container element with layout and spacing.

```typescript
ui.box([child1, child2], {
  p: 'md',
  flex: 'row',
  gap: 'sm',
  bg: 'bgHover',
})
```

### text
Text content with typography options.

```typescript
ui.text('Hello World', {
  variant: 'muted',
  size: 'sm',
  weight: 'bold',
  truncate: true,
})
```

### icon
Display an icon.

```typescript
ui.icon('success', { color: 'success', spin: false })
```

### button
Interactive button.

```typescript
ui.button({
  label: 'Accept',
  icon: 'check',
  variant: 'primary',
  onClick: 'handleAccept',
})
```

### row / stack
Flexbox containers.

```typescript
// Horizontal
ui.row([ui.icon('file'), ui.text('filename.ts')], { gap: 'sm' })

// Vertical
ui.stack([ui.text('Line 1'), ui.text('Line 2')], { gap: 'xs' })
```

## Composite Components

### dropdown
Expandable container with header and body.

```typescript
ui.dropdown(
  ui.dropdownHeader('Title', { expanded: false, icon: 'tools' }),
  ui.list(items),
  { expanded: false, onToggle: 'toggle' }
)
```

### list
Renders array of items.

```typescript
ui.list([item1, item2, item3], { gap: 'sm', dividers: true })
```

### tree
Hierarchical list with branch characters.

```typescript
ui.tree([
  ui.treeItem(ui.text('Parent'), {
    children: [
      ui.treeItem(ui.text('Child 1')),
      ui.treeItem(ui.text('Child 2'), { isLast: true }),
    ]
  })
])
```

## Specialized Components

```typescript
// Status row with icon
ui.statusRow('success', 'Operation complete')

// File row
ui.fileRow('config.ts', { status: 'applied', treeBranch: 'end' })

// Command row
ui.commandRow('npm test', { status: 'running' })

// Tool row
ui.toolRow('Read', { status: 'success', detail: 'file.ts' })
```

## UIActor Base Class

Extend `UIActor` for full actor integration:

```typescript
class MyActor extends UIActor<MyState> {
  constructor(manager: EventStateManager, element: HTMLElement) {
    super(manager, element, 'my-actor', { expanded: false, items: [] });
  }

  // Define the view declaratively
  protected getView(): UINode {
    return ui.dropdown(
      ui.dropdownHeader('My Component', { expanded: this.state.expanded }),
      ui.list(this.state.items.map(item => ui.text(item))),
      { expanded: this.state.expanded, onToggle: 'toggle' }
    );
  }

  // Add custom styles
  protected getStyles(): string {
    return `.dropdown { margin: 8px 0; }`;
  }

  // Define event handlers
  protected getHandlers() {
    return {
      toggle: () => this.setState({ expanded: !this.state.expanded })
    };
  }

  // Pub/sub integration
  protected getPublicationKeys() { return ['myactor.expanded']; }
  protected getSubscriptionKeys() { return ['streaming.*']; }
}
```

## LLM Collaboration Tips

### Do's

1. **Use token names** - `p: 'md'` not `padding: '8px'`
2. **Use semantic variants** - `variant: 'error'` not `color: 'red'`
3. **Use icon names** - `icon: 'success'` not literal `✓`
4. **Use composable helpers** - `ui.each()`, `ui.when()`, `ui.hidden()`

### Don'ts

1. **Don't use raw CSS values** - They're error-prone
2. **Don't guess icon characters** - Use the named icons
3. **Don't manually write HTML** - Use the primitives
4. **Don't hardcode colors** - Use VS Code CSS variables via tokens

### Example: Converting Imperative to Declarative

```typescript
// ❌ Imperative (error-prone, verbose)
container.innerHTML = `
  <div class="header" style="display: flex; align-items: center; gap: 8px;">
    <span class="toggle">${expanded ? '-' : '+'}</span>
    <span class="icon">🔧</span>
    <span class="label">Tools</span>
    <span class="count">[${count}]</span>
  </div>
`;

// ✅ Declarative (clear, composable, type-safe)
ui.row([
  ui.icon(expanded ? 'collapseMinus' : 'expandPlus', { className: 'toggle' }),
  ui.icon('tools'),
  ui.text('Tools', { className: 'label' }),
  ui.text(`[${count}]`, { className: 'count' }),
], { align: 'center', gap: 'sm', className: 'header' })
```

## File Reference

| File | Purpose |
|------|---------|
| `tokens.ts` | Design tokens - spacing, colors, icons |
| `types.ts` | TypeScript type definitions |
| `primitives.ts` | Base components: box, text, icon, row, stack |
| `components.ts` | Composite: dropdown, list, tree, card |
| `render.ts` | Converts UINode to HTML string |
| `UIActor.ts` | Base class for actor integration |
| `index.ts` | Main exports and `ui` namespace |
