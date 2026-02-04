/**
 * Shared Styles for Shadow DOM Actors
 *
 * These styles are parsed ONCE and shared across all shadow roots using
 * adoptedStyleSheets. This reduces memory usage and eliminates duplicate
 * CSS parsing when many shadow actors are instantiated.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CSSStyleSheet/adoptedStyleSheets
 */

/**
 * Base styles applied to ALL shadow actors.
 * Includes host display, box-sizing reset, and hidden state.
 */
export const shadowBaseStyles = `
  /* Base shadow actor styles */
  :host {
    display: block;
  }

  :host([hidden]) {
    display: none;
  }

  .shadow-content {
    display: contents;
  }

  /* Universal box-sizing reset */
  *, *::before, *::after {
    box-sizing: border-box;
  }
`;

/**
 * Base styles for interleaved (dynamic container) actors.
 * Includes host positioning and common animations.
 */
export const interleavedBaseStyles = `
  /* Base container styles */
  :host {
    display: block;
    position: relative;
  }

  :host([hidden]) {
    display: none;
  }

  .container {
    box-sizing: border-box;
  }

  /* Animation classes */
  :host(.anim-bubble-in) {
    animation: bubbleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
  }

  :host(.anim-fade-out) {
    animation: fadeOut 0.2s ease forwards;
  }

  @keyframes bubbleIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(-5px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @keyframes fadeOut {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }

  /* Jiggle animation for hover feedback */
  @keyframes jiggle {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
    20%, 40%, 60%, 80% { transform: translateX(2px); }
  }

  /* Universal box-sizing reset */
  *, *::before, *::after {
    box-sizing: border-box;
  }
`;

/**
 * Common button styles used across multiple actors.
 * Can be adopted by actors that need standard button styling.
 */
export const commonButtonStyles = `
  /* Common button base */
  .btn {
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    font-size: 12px;
    transition: background 0.15s ease;
  }

  .btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
`;

/**
 * Common scrollbar styles for scrollable containers.
 */
export const scrollbarStyles = `
  /* Scrollbar styling */
  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
  }

  ::-webkit-scrollbar-thumb:active {
    background: var(--vscode-scrollbarSlider-activeBackground);
  }
`;

/**
 * Common input/textarea styles.
 */
export const inputStyles = `
  /* Form input styling */
  input, textarea {
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    font-family: inherit;
    font-size: inherit;
  }

  input:focus, textarea:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }

  input::placeholder, textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
`;
