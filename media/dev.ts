/**
 * Dev Tools Entry Point (Standalone)
 *
 * This file is built as a SEPARATE bundle (dev.js) and is only
 * loaded when devMode is enabled. It's not part of the production chat.js.
 *
 * The extension injects a <script src="dev.js"> tag when devMode is true.
 *
 * Uses its own EventStateManager since it's a separate bundle from the main app.
 * The inspector actor doesn't need to communicate with other actors.
 */

import { EventStateManager } from './state/EventStateManager';
import { InspectorShadowActor } from './dev/inspector/InspectorShadowActor';

// Initialize immediately when loaded
(function initDevTools() {
  console.log('[DevTools] Initializing actor-based dev tools...');

  // Create a dedicated manager for dev tools
  // (Separate from main app since this is a standalone bundle)
  const devManager = new EventStateManager();

  // Create inspector host element
  const inspectorHost = document.createElement('div');
  inspectorHost.id = 'dev-inspector-host';
  inspectorHost.style.cssText = `
    position: fixed;
    top: 0;
    right: 0;
    z-index: 999999;
    pointer-events: none;
  `;
  document.body.appendChild(inspectorHost);

  // Create inspector actor
  const inspector = new InspectorShadowActor(devManager, inspectorHost);

  // Toggle function for console access
  function toggle() {
    inspector.toggle();
  }

  // Expose for console access
  (window as unknown as {
    devTools: {
      inspector: InspectorShadowActor;
      toggle: () => void;
      manager: EventStateManager;
    }
  }).devTools = {
    inspector,
    toggle,
    manager: devManager
  };

  console.log('[DevTools] Ready! Access via: window.devTools.inspector or window.devTools.toggle()');
})();
