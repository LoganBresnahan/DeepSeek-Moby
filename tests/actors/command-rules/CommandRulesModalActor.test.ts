/**
 * Tests for CommandRulesModalActor
 *
 * Tests the Shadow DOM modal for command rules management including:
 * - Modal structure rendering
 * - Rules list display (allowed/blocked sections)
 * - Add rule form
 * - Delete rule button
 * - Reset to defaults
 * - Pub/sub integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRulesModalActor, CommandRule } from '../../../media/actors/command-rules/CommandRulesModalActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

const createMockVSCode = () => ({
  postMessage: vi.fn()
});

describe('CommandRulesModalActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: CommandRulesModalActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'rules-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  // ============================================
  // Shadow DOM creation
  // ============================================

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders modal structure', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      const modal = element.shadowRoot?.querySelector('.modal-container');
      const header = element.shadowRoot?.querySelector('.modal-header');
      const body = element.shadowRoot?.querySelector('.modal-body');
      const footer = element.shadowRoot?.querySelector('.modal-footer');

      expect(backdrop).toBeTruthy();
      expect(modal).toBeTruthy();
      expect(header).toBeTruthy();
      expect(body).toBeTruthy();
      expect(footer).toBeTruthy();
    });

    it('renders title with shield icon', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);

      const title = element.shadowRoot?.querySelector('.modal-title');
      expect(title?.textContent).toContain('Command Rules');
    });
  });

  // ============================================
  // Modal visibility
  // ============================================

  describe('Modal visibility', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      expect(backdrop?.classList.contains('visible')).toBe(false);
    });

    it('opens via pub/sub', () => {
      manager.publishDirect('rules.modal.open', true);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      expect(backdrop?.classList.contains('visible')).toBe(true);
    });

    it('closes via pub/sub', () => {
      manager.publishDirect('rules.modal.open', true);
      manager.publishDirect('rules.modal.open', false);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      expect(backdrop?.classList.contains('visible')).toBe(false);
    });

    it('requests rules on open', () => {
      manager.publishDirect('rules.modal.open', true);

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'getCommandRules' });
    });

    it('publishes visible state', () => {
      manager.publishDirect('rules.modal.open', true);
      expect(manager.getState('rules.modal.visible')).toBe(true);

      actor.close();
      expect(manager.getState('rules.modal.visible')).toBe(false);
    });
  });

  // ============================================
  // Rules list rendering
  // ============================================

  describe('Rules list rendering', () => {
    const sampleRules: CommandRule[] = [
      { id: 1, prefix: 'ls', type: 'allowed', source: 'default', created_at: 1000 },
      { id: 2, prefix: 'cat', type: 'allowed', source: 'default', created_at: 1000 },
      { id: 3, prefix: 'npm install', type: 'allowed', source: 'user', created_at: 2000 },
      { id: 4, prefix: 'rm -rf', type: 'blocked', source: 'default', created_at: 1000 },
      { id: 5, prefix: 'sudo', type: 'blocked', source: 'default', created_at: 1000 },
      { id: 6, prefix: 'curl', type: 'blocked', source: 'user', created_at: 2000 },
    ];

    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders allowed and blocked sections', () => {
      manager.publishDirect('rules.list', sampleRules);

      const sections = element.shadowRoot?.querySelectorAll('.rules-section');
      expect(sections?.length).toBe(2);
    });

    it('shows correct section headers with counts', () => {
      manager.publishDirect('rules.list', sampleRules);

      const headers = element.shadowRoot?.querySelectorAll('.rules-section-header');
      expect(headers?.[0]?.textContent).toContain('Allowed');
      expect(headers?.[0]?.textContent).toContain('3');
      expect(headers?.[1]?.textContent).toContain('Blocked');
      expect(headers?.[1]?.textContent).toContain('3');
    });

    it('renders rule items with prefix', () => {
      manager.publishDirect('rules.list', sampleRules);

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(6);

      const prefixes = Array.from(items!).map(i =>
        i.querySelector('.rule-prefix')?.textContent?.trim()
      );
      expect(prefixes).toContain('ls');
      expect(prefixes).toContain('npm install');
      expect(prefixes).toContain('rm -rf');
      expect(prefixes).toContain('curl');
    });

    it('shows source badges', () => {
      manager.publishDirect('rules.list', sampleRules);

      const badges = element.shadowRoot?.querySelectorAll('.source-badge');
      expect(badges?.length).toBe(6);

      const defaultBadges = element.shadowRoot?.querySelectorAll('.source-badge.default');
      const userBadges = element.shadowRoot?.querySelectorAll('.source-badge.user');
      expect(defaultBadges?.length).toBe(4);
      expect(userBadges?.length).toBe(2);
    });

    it('shows delete button only for user rules', () => {
      manager.publishDirect('rules.list', sampleRules);

      const deleteButtons = element.shadowRoot?.querySelectorAll('.rule-delete');
      expect(deleteButtons?.length).toBe(2); // Only npm install and curl

      // Verify they are in user rule items
      deleteButtons?.forEach(btn => {
        const item = btn.closest('.rule-item');
        expect(item?.getAttribute('data-source')).toBe('user');
      });
    });

    it('shows empty state when no rules in a section', () => {
      const onlyAllowed: CommandRule[] = [
        { id: 1, prefix: 'ls', type: 'allowed', source: 'default', created_at: 1000 },
      ];

      manager.publishDirect('rules.list', onlyAllowed);

      const empties = element.shadowRoot?.querySelectorAll('.rules-empty');
      // Blocked section should show empty state
      expect(empties?.length).toBe(1);
      expect(empties?.[0]?.textContent).toContain('No blocked rules');
    });

    it('shows both empty states when no rules at all', () => {
      manager.publishDirect('rules.list', []);

      const empties = element.shadowRoot?.querySelectorAll('.rules-empty');
      expect(empties?.length).toBe(2);
    });

    it('updates getRules() after receiving data', () => {
      manager.publishDirect('rules.list', sampleRules);

      const rules = actor.getRules();
      expect(rules.length).toBe(6);
      expect(rules[0].prefix).toBe('ls');
    });

    it('escapes HTML in rule prefixes', () => {
      const malicious: CommandRule[] = [
        { id: 1, prefix: '<script>alert(1)</script>', type: 'allowed', source: 'user', created_at: 1000 },
      ];

      manager.publishDirect('rules.list', malicious);

      const prefix = element.shadowRoot?.querySelector('.rule-prefix');
      expect(prefix?.innerHTML).not.toContain('<script>');
      expect(prefix?.textContent).toContain('<script>');
    });
  });

  // ============================================
  // Add rule form
  // ============================================

  describe('Add rule form', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders add rule form in footer', () => {
      const input = element.shadowRoot?.querySelector('[data-rule-input]') as HTMLInputElement;
      const select = element.shadowRoot?.querySelector('[data-rule-type]') as HTMLSelectElement;
      const addBtn = element.shadowRoot?.querySelector('[data-action="add-rule"]');

      expect(input).toBeTruthy();
      expect(select).toBeTruthy();
      expect(addBtn).toBeTruthy();
    });

    it('select has allowed and blocked options', () => {
      const select = element.shadowRoot?.querySelector('[data-rule-type]') as HTMLSelectElement;
      const options = Array.from(select.options).map(o => o.value);
      expect(options).toContain('allowed');
      expect(options).toContain('blocked');
    });

    it('clicking add button sends addCommandRule message', () => {
      const input = element.shadowRoot?.querySelector('[data-rule-input]') as HTMLInputElement;
      const select = element.shadowRoot?.querySelector('[data-rule-type]') as HTMLSelectElement;
      const addBtn = element.shadowRoot?.querySelector('[data-action="add-rule"]') as HTMLButtonElement;

      input.value = 'docker run';
      select.value = 'blocked';
      addBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'addCommandRule',
        prefix: 'docker run',
        ruleType: 'blocked',
      });
    });

    it('clears input after adding rule', () => {
      const input = element.shadowRoot?.querySelector('[data-rule-input]') as HTMLInputElement;
      const addBtn = element.shadowRoot?.querySelector('[data-action="add-rule"]') as HTMLButtonElement;

      input.value = 'git push';
      addBtn.click();

      expect(input.value).toBe('');
    });

    it('does not send message when input is empty', () => {
      const addBtn = element.shadowRoot?.querySelector('[data-action="add-rule"]') as HTMLButtonElement;
      mockVSCode.postMessage.mockClear();

      addBtn.click();

      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'addCommandRule' })
      );
    });

    it('enter key in input triggers add', () => {
      const input = element.shadowRoot?.querySelector('[data-rule-input]') as HTMLInputElement;
      input.value = 'npm test';

      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      input.dispatchEvent(event);

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'addCommandRule',
        prefix: 'npm test',
        ruleType: 'allowed', // default
      });
    });
  });

  // ============================================
  // Delete rule
  // ============================================

  describe('Delete rule', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('clicking delete sends removeCommandRule message', () => {
      const rules: CommandRule[] = [
        { id: 42, prefix: 'npm install', type: 'allowed', source: 'user', created_at: 1000 },
      ];
      manager.publishDirect('rules.list', rules);
      mockVSCode.postMessage.mockClear();

      const deleteBtn = element.shadowRoot?.querySelector('.rule-delete') as HTMLButtonElement;
      deleteBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'removeCommandRule',
        id: 42,
      });
    });
  });

  // ============================================
  // Reset to defaults
  // ============================================

  describe('Reset to defaults', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders reset button', () => {
      const resetBtn = element.shadowRoot?.querySelector('[data-action="reset-rules"]');
      expect(resetBtn).toBeTruthy();
      expect(resetBtn?.textContent).toContain('Reset');
    });

    it('clicking reset sends resetCommandRulesToDefaults message', () => {
      mockVSCode.postMessage.mockClear();

      const resetBtn = element.shadowRoot?.querySelector('[data-action="reset-rules"]') as HTMLButtonElement;
      resetBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'resetCommandRulesToDefaults',
      });
    });
  });

  // ============================================
  // Close behavior
  // ============================================

  describe('Close behavior', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('close button closes modal', () => {
      manager.publishDirect('rules.modal.open', true);

      const closeBtn = element.shadowRoot?.querySelector('[data-action="close"]') as HTMLButtonElement;
      closeBtn.click();

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      expect(backdrop?.classList.contains('visible')).toBe(false);
    });
  });
});
