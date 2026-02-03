/**
 * Dev Tools Entry Point
 *
 * This file is only loaded in development mode.
 * It initializes the inspector and other dev tools.
 */

import { Inspector } from './inspector/Inspector';

let inspector: Inspector | null = null;

/**
 * Initialize dev tools
 */
export function initDevTools(): void {
  console.log('[DevTools] Initializing...');

  // Inject inspector styles
  injectStyles();

  // Create inspector (starts hidden)
  inspector = new Inspector();

  console.log('[DevTools] Ready. Access via: window.devTools.inspector or window.devTools.toggle()');
}

/**
 * Toggle inspector visibility
 */
function toggleInspector(): void {
  const el = document.querySelector('.dev-inspector') as HTMLElement;
  if (el) {
    el.style.display = el.style.display === 'none' ? 'flex' : 'none';
  }
}

/**
 * Inject CSS for dev tools
 */
function injectStyles(): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'dev/inspector/styles.css';
  document.head.appendChild(link);
}

/**
 * Cleanup dev tools
 */
export function destroyDevTools(): void {
  inspector?.destroy();
  inspector = null;
}

// Export for manual access
(window as unknown as { devTools: { inspector: Inspector | null; toggle: () => void } }).devTools = {
  get inspector() { return inspector; },
  toggle: toggleInspector
};
