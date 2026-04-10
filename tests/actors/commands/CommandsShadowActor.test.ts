/**
 * Tests for CommandsShadowActor
 *
 * Tests the Shadow DOM popup for commands dropdown including:
 * - Popup open/close behavior
 * - Command rendering by section
 * - Command execution
 * - History command special handling
 * - Pub/sub integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandsShadowActor, CommandItem } from '../../../media/actors/commands/CommandsShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

describe('CommandsShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: CommandsShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'commands-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure', () => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const header = element.shadowRoot?.querySelector('.popup-header');
      const body = element.shadowRoot?.querySelector('.popup-body');

      expect(popup).toBeTruthy();
      expect(header).toBeTruthy();
      expect(body).toBeTruthy();
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when toggle() is called while closed', () => {
      actor.toggle();

      expect(actor.isVisible()).toBe(true);
    });

    it('closes when toggle() is called while open', () => {
      actor.toggle(); // open
      actor.toggle(); // close

      expect(actor.isVisible()).toBe(false);
    });

    it('opens when commands.popup.open is published', () => {
      manager.publishDirect('commands.popup.open', true);

      expect(actor.isVisible()).toBe(true);
    });

    it('closes when commands.popup.open false is published', () => {
      actor.toggle(); // open
      manager.publishDirect('commands.popup.open', false);

      expect(actor.isVisible()).toBe(false);
    });

    it('closes on Escape key', () => {
      actor.toggle();

      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Command rendering', () => {
    beforeEach(() => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);
    });

    it('renders default commands', () => {
      actor.toggle();

      const commandItems = element.shadowRoot?.querySelectorAll('.command-item');
      expect(commandItems?.length).toBeGreaterThan(0);
    });

    it('groups commands by section', () => {
      actor.toggle();

      const sections = element.shadowRoot?.querySelectorAll('.commands-section-title');
      expect(sections?.length).toBeGreaterThanOrEqual(1);
    });

    it('renders command name and description', () => {
      actor.toggle();

      const commandName = element.shadowRoot?.querySelector('.command-name');
      const commandDesc = element.shadowRoot?.querySelector('.command-desc');

      expect(commandName).toBeTruthy();
      expect(commandDesc).toBeTruthy();
    });

    it('renders command icon', () => {
      actor.toggle();

      const icon = element.shadowRoot?.querySelector('.command-icon');
      expect(icon).toBeTruthy();
    });
  });

  describe('Command execution', () => {
    beforeEach(() => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);
      actor.toggle();
      mockVSCode.postMessage.mockClear();
    });

    it('sends executeCommand message when command is clicked', () => {
      const commandItem = element.shadowRoot?.querySelector('.command-item[data-command="moby.exportChatHistory"]') as HTMLElement;
      commandItem?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'executeCommand',
        command: 'moby.exportChatHistory'
      });
    });

    it('closes popup after command execution', () => {
      const commandItem = element.shadowRoot?.querySelector('.command-item[data-command="moby.exportChatHistory"]') as HTMLElement;
      commandItem?.click();

      expect(actor.isVisible()).toBe(false);
    });

    it('calls custom command handler if set', () => {
      const handler = vi.fn();
      actor.onCommand(handler);

      const commandItem = element.shadowRoot?.querySelector('.command-item[data-command="moby.exportChatHistory"]') as HTMLElement;
      commandItem?.click();

      expect(handler).toHaveBeenCalledWith('moby.exportChatHistory');
    });
  });

  describe('Public API', () => {
    beforeEach(() => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);
    });

    it('setCommands() updates displayed commands', () => {
      const customCommands: CommandItem[] = [
        { id: 'custom.test', name: 'Test Command', description: 'A test', icon: '🧪', section: 'Test' }
      ];

      actor.setCommands(customCommands);
      actor.toggle();

      const commandItem = element.shadowRoot?.querySelector('.command-item[data-command="custom.test"]');
      expect(commandItem).toBeTruthy();
    });

    it('addCommand() adds a new command', () => {
      actor.addCommand({
        id: 'custom.added',
        name: 'Added Command',
        description: 'Newly added',
        icon: '➕',
        section: 'Custom'
      });

      actor.toggle();

      const commandItem = element.shadowRoot?.querySelector('.command-item[data-command="custom.added"]');
      expect(commandItem).toBeTruthy();
    });

    it('getCommands() returns copy of commands', () => {
      const commands = actor.getCommands();

      expect(commands.length).toBeGreaterThan(0);
      expect(commands).not.toBe((actor as any)._commands); // Should be a copy
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new CommandsShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      // Should not throw when destroyed
      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
