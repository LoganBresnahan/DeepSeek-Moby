/**
 * Snapshot tests for MessageActor
 * Captures DOM output for visual regression detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { MessageActor } from '../../../media/actors/message/MessageActor';

/**
 * Helper to normalize dynamic IDs in HTML for consistent snapshots
 */
function normalizeIds(html: string): string {
  return html.replace(/msg-(user|assistant)-\d+/g, 'msg-$1-X');
}

describe('MessageActor Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageActor;

  beforeEach(() => {
    MessageActor.resetStylesInjected();

    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-messages';
    document.body.appendChild(element);

    actor = new MessageActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('user messages', () => {
    it('renders simple user message', () => {
      actor.addUserMessage('Hello, can you help me?');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders user message with files', () => {
      actor.addUserMessage('Please review this code', ['main.ts', 'utils.ts']);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders user message with special characters', () => {
      actor.addUserMessage('Test <b>bold</b> and &amp; entities');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('assistant messages', () => {
    it('renders simple assistant message', () => {
      actor.addAssistantMessage('I can help you with that!');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders assistant message with thinking', () => {
      actor.addAssistantMessage('The answer is 42.', {
        thinking: 'Let me analyze this problem...\nStep 1: Consider the input.\nStep 2: Apply logic.'
      });
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders assistant message with multiline content', () => {
      actor.addAssistantMessage('Here are the steps:\n1. First step\n2. Second step\n3. Third step');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('conversation flow', () => {
    it('renders multiple messages in sequence', () => {
      actor.addUserMessage('What is TypeScript?');
      actor.addAssistantMessage('TypeScript is a typed superset of JavaScript.');
      actor.addUserMessage('Can you show an example?');
      actor.addAssistantMessage('Here is a simple example:\n\nconst x: number = 42;');
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });
  });

  describe('injected styles', () => {
    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="message"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toMatchSnapshot();
    });
  });
});

describe('MessageActor State Snapshots', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageActor;

  beforeEach(() => {
    MessageActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-messages';
    document.body.appendChild(element);
    actor = new MessageActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  it('captures initial state', () => {
    expect(actor.getState()).toMatchSnapshot();
  });

  it('captures state after adding messages', () => {
    actor.addUserMessage('Hello');
    actor.addAssistantMessage('Hi there!');
    const state = actor.getState();
    // Normalize dynamic lastId for consistent snapshots
    if (state.lastId) {
      state.lastId = state.lastId.replace(/msg-(user|assistant)-\d+/, 'msg-$1-X');
    }
    expect(state).toMatchSnapshot();
  });

  it('captures state after clear', () => {
    actor.addUserMessage('Test');
    actor.clear();
    expect(actor.getState()).toMatchSnapshot();
  });
});

describe('MessageActor Edit Mode and Code Block Collapse', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageActor;

  beforeEach(() => {
    MessageActor.resetStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-messages';
    document.body.appendChild(element);
    actor = new MessageActor(manager, element);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('setEditMode', () => {
    it('defaults to manual mode', () => {
      expect(actor.getEditMode()).toBe('manual');
    });

    it('sets edit mode to ask', () => {
      actor.setEditMode('ask');
      expect(actor.getEditMode()).toBe('ask');
    });

    it('sets edit mode to auto', () => {
      actor.setEditMode('auto');
      expect(actor.getEditMode()).toBe('auto');
    });
  });

  describe('code block collapse in different modes', () => {
    const codeBlockContent = 'Here is code:\n```typescript\nconst x = 1;\nconst y = 2;\n```';

    it('renders code block expanded in manual mode', () => {
      actor.setEditMode('manual');
      actor.addAssistantMessage(codeBlockContent);

      const codeBlock = element.querySelector('.code-block');
      expect(codeBlock?.classList.contains('collapsed')).toBe(false);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders code block collapsed in ask mode', () => {
      actor.setEditMode('ask');
      actor.addAssistantMessage(codeBlockContent);

      const codeBlock = element.querySelector('.code-block');
      expect(codeBlock?.classList.contains('collapsed')).toBe(true);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('renders code block collapsed in auto mode', () => {
      actor.setEditMode('auto');
      actor.addAssistantMessage(codeBlockContent);

      const codeBlock = element.querySelector('.code-block');
      expect(codeBlock?.classList.contains('collapsed')).toBe(true);
      expect(normalizeIds(element.innerHTML)).toMatchSnapshot();
    });

    it('includes collapse toggle button', () => {
      actor.addAssistantMessage(codeBlockContent);

      const toggleBtn = element.querySelector('.collapse-toggle-btn');
      expect(toggleBtn).toBeTruthy();
    });

    it('toggles collapse state on button click', () => {
      actor.setEditMode('auto');
      actor.addAssistantMessage(codeBlockContent);

      const codeBlock = element.querySelector('.code-block');
      const toggleBtn = element.querySelector('.collapse-toggle-btn') as HTMLButtonElement;

      // Initially collapsed in auto mode
      expect(codeBlock?.classList.contains('collapsed')).toBe(true);
      expect(toggleBtn?.textContent).toBe('▶');

      // Click to expand
      toggleBtn?.click();
      expect(codeBlock?.classList.contains('collapsed')).toBe(false);
      expect(toggleBtn?.textContent).toBe('▼');

      // Click to collapse again
      toggleBtn?.click();
      expect(codeBlock?.classList.contains('collapsed')).toBe(true);
      expect(toggleBtn?.textContent).toBe('▶');
    });
  });
});
