/**
 * Tests for CommandRulesModalActor
 *
 * Tests the Shadow DOM modal for command rules management including:
 * - Modal structure rendering
 * - Allow-all toggle switch
 * - Filter chips (All / Approved / Blocked)
 * - Search filtering
 * - Unified rules list with checkboxes and delete buttons
 * - Add rule form
 * - Reset to defaults
 * - Pub/sub integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandRulesModalActor, CommandRule } from '../../../media/actors/command-rules/CommandRulesModalActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

const createMockVSCode = () => ({
  postMessage: vi.fn()
});

const sampleRules: CommandRule[] = [
  { id: 1, prefix: 'ls', type: 'allowed', source: 'default', created_at: 1000 },
  { id: 2, prefix: 'cat', type: 'allowed', source: 'default', created_at: 1000 },
  { id: 3, prefix: 'npm install', type: 'allowed', source: 'user', created_at: 2000 },
  { id: 4, prefix: 'rm -rf', type: 'blocked', source: 'default', created_at: 1000 },
  { id: 5, prefix: 'sudo', type: 'blocked', source: 'default', created_at: 1000 },
  { id: 6, prefix: 'curl', type: 'blocked', source: 'user', created_at: 2000 },
];

/** Helper: publish rules and return the items */
function publishAndGetItems(manager: EventStateManager, element: HTMLElement, rules: CommandRule[] = sampleRules) {
  manager.publishDirect('rules.list', rules);
  return element.shadowRoot?.querySelectorAll('.rule-item');
}

describe('CommandRulesModalActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: CommandRulesModalActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
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

    it('renders modal structure with search', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);

      const backdrop = element.shadowRoot?.querySelector('.modal-backdrop');
      const modal = element.shadowRoot?.querySelector('.modal-container');
      const header = element.shadowRoot?.querySelector('.modal-header');
      const body = element.shadowRoot?.querySelector('.modal-body');
      const footer = element.shadowRoot?.querySelector('.modal-footer');
      const search = element.shadowRoot?.querySelector('.modal-search');

      expect(backdrop).toBeTruthy();
      expect(modal).toBeTruthy();
      expect(header).toBeTruthy();
      expect(body).toBeTruthy();
      expect(footer).toBeTruthy();
      expect(search).toBeTruthy();
    });

    it('renders title with shield icon', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);

      const title = element.shadowRoot?.querySelector('.modal-title');
      expect(title?.textContent).toContain('Command Rules');
    });

    it('renders allow-all bar, filter row, and rules list in body', () => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);

      expect(element.shadowRoot?.querySelector('.allow-all-bar')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.filter-row')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.rules-list')).toBeTruthy();
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

    it('opens without requesting rules (rules sent by extension before open)', () => {
      manager.publishDirect('rules.modal.open', true);

      // Rules are already sent by the extension before the modal opens,
      // so no getCommandRules request is needed
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith({ type: 'getCommandRules' });
    });

    it('publishes visible state', () => {
      manager.publishDirect('rules.modal.open', true);
      expect(manager.getState('rules.modal.visible')).toBe(true);

      actor.close();
      expect(manager.getState('rules.modal.visible')).toBe(false);
    });
  });

  // ============================================
  // Allow-all toggle
  // ============================================

  describe('Allow-all toggle', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders allow-all toggle bar', () => {
      const bar = element.shadowRoot?.querySelector('.allow-all-bar');
      const toggle = element.shadowRoot?.querySelector('[data-allow-all]') as HTMLInputElement;

      expect(bar).toBeTruthy();
      expect(toggle).toBeTruthy();
      expect(toggle?.type).toBe('checkbox');
    });

    it('toggle is unchecked by default', () => {
      const toggle = element.shadowRoot?.querySelector('[data-allow-all]') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
    });

    it('sends setAllowAllCommands message when toggled on', () => {
      const toggle = element.shadowRoot?.querySelector('[data-allow-all]') as HTMLInputElement;
      mockVSCode.postMessage.mockClear();

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setAllowAllCommands',
        enabled: true,
      });
    });

    it('sends setAllowAllCommands message when toggled off', () => {
      // First enable
      manager.publishDirect('rules.allowAll', true);
      mockVSCode.postMessage.mockClear();

      const toggle = element.shadowRoot?.querySelector('[data-allow-all]') as HTMLInputElement;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'setAllowAllCommands',
        enabled: false,
      });
    });

    it('updates toggle state when receiving rules.allowAll', () => {
      manager.publishDirect('rules.allowAll', true);

      const toggle = element.shadowRoot?.querySelector('[data-allow-all]') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      expect(actor.getAllowAll()).toBe(true);
    });

    it('applies rules-disabled class to container when allow-all is enabled', () => {
      manager.publishDirect('rules.allowAll', true);

      const container = element.shadowRoot?.querySelector('.modal-container');
      expect(container?.classList.contains('rules-disabled')).toBe(true);
    });

    it('removes rules-disabled class when allow-all is disabled', () => {
      manager.publishDirect('rules.allowAll', true);
      manager.publishDirect('rules.allowAll', false);

      const container = element.shadowRoot?.querySelector('.modal-container');
      expect(container?.classList.contains('rules-disabled')).toBe(false);
    });
  });

  // ============================================
  // Rules list rendering
  // ============================================

  describe('Rules list rendering', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders rules in a single unified list', () => {
      const items = publishAndGetItems(manager, element);
      expect(items?.length).toBe(6);
    });

    it('sorts rules alphabetically by prefix', () => {
      const items = publishAndGetItems(manager, element);
      const prefixes = Array.from(items!).map(i => i.querySelector('.rule-prefix')?.textContent?.trim());

      // cat, curl, ls, npm install, rm -rf, sudo
      expect(prefixes).toEqual(['cat', 'curl', 'ls', 'npm install', 'rm -rf', 'sudo']);
    });

    it('renders checkbox for each rule (checked = allowed)', () => {
      publishAndGetItems(manager, element);

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      const checkedMap: Record<string, boolean> = {};
      items?.forEach(item => {
        const prefix = item.querySelector('.rule-prefix')?.textContent?.trim() || '';
        const cb = item.querySelector('.rule-checkbox') as HTMLInputElement;
        checkedMap[prefix] = cb.checked;
      });

      expect(checkedMap['ls']).toBe(true);
      expect(checkedMap['cat']).toBe(true);
      expect(checkedMap['npm install']).toBe(true);
      expect(checkedMap['rm -rf']).toBe(false);
      expect(checkedMap['sudo']).toBe(false);
      expect(checkedMap['curl']).toBe(false);
    });

    it('renders delete button for ALL rules', () => {
      publishAndGetItems(manager, element);

      const deleteButtons = element.shadowRoot?.querySelectorAll('.rule-delete');
      expect(deleteButtons?.length).toBe(6);
    });

    it('shows source badges', () => {
      publishAndGetItems(manager, element);

      const badges = element.shadowRoot?.querySelectorAll('.source-badge');
      expect(badges?.length).toBe(6);

      const defaultBadges = element.shadowRoot?.querySelectorAll('.source-badge.default');
      const userBadges = element.shadowRoot?.querySelectorAll('.source-badge.user');
      expect(defaultBadges?.length).toBe(4);
      expect(userBadges?.length).toBe(2);
    });

    it('shows empty state when no rules', () => {
      manager.publishDirect('rules.list', []);

      const empties = element.shadowRoot?.querySelectorAll('.rules-empty');
      expect(empties?.length).toBe(1);
      expect(empties?.[0]?.textContent).toContain('No command rules');
    });

    it('updates getRules() after receiving data', () => {
      publishAndGetItems(manager, element);

      const rules = actor.getRules();
      expect(rules.length).toBe(6);
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
  // Filter chips
  // ============================================

  describe('Filter chips', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders three filter chips (All, Approved, Blocked)', () => {
      const chips = element.shadowRoot?.querySelectorAll('.filter-chip');
      expect(chips?.length).toBe(3);
    });

    it('shows correct counts after receiving rules', () => {
      publishAndGetItems(manager, element);

      const allChip = element.shadowRoot?.querySelector('[data-filter="all"]');
      const approvedChip = element.shadowRoot?.querySelector('[data-filter="allowed"]');
      const blockedChip = element.shadowRoot?.querySelector('[data-filter="blocked"]');

      expect(allChip?.textContent).toContain('(6)');
      expect(approvedChip?.textContent).toContain('(3)');
      expect(blockedChip?.textContent).toContain('(3)');
    });

    it('"All" chip is active after receiving rules', () => {
      publishAndGetItems(manager, element);

      const allChip = element.shadowRoot?.querySelector('[data-filter="all"]');
      expect(allChip?.classList.contains('active')).toBe(true);
    });

    it('clicking "Approved" chip filters to allowed rules only', () => {
      publishAndGetItems(manager, element);

      const approvedChip = element.shadowRoot?.querySelector('[data-filter="allowed"]') as HTMLElement;
      approvedChip.click();

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(3);

      const prefixes = Array.from(items!).map(i => i.querySelector('.rule-prefix')?.textContent?.trim());
      expect(prefixes).toContain('ls');
      expect(prefixes).toContain('cat');
      expect(prefixes).toContain('npm install');
      expect(prefixes).not.toContain('rm -rf');
    });

    it('clicking "Blocked" chip filters to blocked rules only', () => {
      publishAndGetItems(manager, element);

      const blockedChip = element.shadowRoot?.querySelector('[data-filter="blocked"]') as HTMLElement;
      blockedChip.click();

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(3);

      const prefixes = Array.from(items!).map(i => i.querySelector('.rule-prefix')?.textContent?.trim());
      expect(prefixes).toContain('rm -rf');
      expect(prefixes).toContain('sudo');
      expect(prefixes).toContain('curl');
    });

    it('clicking "All" chip shows all rules again', () => {
      publishAndGetItems(manager, element);

      // First filter to blocked
      const blockedChip = element.shadowRoot?.querySelector('[data-filter="blocked"]') as HTMLElement;
      blockedChip.click();

      // Back to all
      const allChip = element.shadowRoot?.querySelector('[data-filter="all"]') as HTMLElement;
      allChip.click();

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(6);
    });

    it('getFilter() reflects current filter', () => {
      expect(actor.getFilter()).toBe('all');

      publishAndGetItems(manager, element);

      const approvedChip = element.shadowRoot?.querySelector('[data-filter="allowed"]') as HTMLElement;
      approvedChip.click();
      expect(actor.getFilter()).toBe('allowed');
    });
  });

  // ============================================
  // Search
  // ============================================

  describe('Search', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('renders search input', () => {
      const search = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      expect(search).toBeTruthy();
      expect(search.placeholder).toContain('Search');
    });

    it('filters rules by search query', () => {
      publishAndGetItems(manager, element);

      const search = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      search.value = 'npm';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(1);
      expect(items?.[0]?.querySelector('.rule-prefix')?.textContent?.trim()).toBe('npm install');
    });

    it('search is case-insensitive', () => {
      publishAndGetItems(manager, element);

      const search = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      search.value = 'LS';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(1);
    });

    it('shows empty state for no matches', () => {
      publishAndGetItems(manager, element);

      const search = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      search.value = 'nonexistent';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      const empty = element.shadowRoot?.querySelector('.rules-empty');
      expect(empty?.textContent).toContain('No commands match');
    });

    it('clearing search shows all rules again', () => {
      publishAndGetItems(manager, element);

      const search = element.shadowRoot?.querySelector('[data-search-input]') as HTMLInputElement;
      search.value = 'npm';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      expect(items?.length).toBe(6);
    });
  });

  // ============================================
  // Checkbox toggle (change rule type)
  // ============================================

  describe('Checkbox toggle', () => {
    beforeEach(() => {
      actor = new CommandRulesModalActor(manager, element, mockVSCode);
    });

    it('toggling checkbox sends remove + add messages to change type', () => {
      publishAndGetItems(manager, element);
      mockVSCode.postMessage.mockClear();

      // Find the "sudo" rule (blocked, id=5) — sorted alphabetically it's the last item
      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      const sudoItem = Array.from(items!).find(
        item => item.querySelector('.rule-prefix')?.textContent?.trim() === 'sudo'
      );
      expect(sudoItem).toBeTruthy();

      const cb = sudoItem!.querySelector('.rule-checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(false);

      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'removeCommandRule',
        id: 5,
      });
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'addCommandRule',
        prefix: 'sudo',
        ruleType: 'allowed',
      });
    });

    it('unchecking a checked rule changes type to blocked', () => {
      publishAndGetItems(manager, element);
      mockVSCode.postMessage.mockClear();

      // Find the "ls" rule (allowed, id=1)
      const items = element.shadowRoot?.querySelectorAll('.rule-item');
      const lsItem = Array.from(items!).find(
        item => item.querySelector('.rule-prefix')?.textContent?.trim() === 'ls'
      );
      expect(lsItem).toBeTruthy();

      const cb = lsItem!.querySelector('.rule-checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(true);

      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'removeCommandRule',
        id: 1,
      });
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'addCommandRule',
        prefix: 'ls',
        ruleType: 'blocked',
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

    it('can delete default rules too', () => {
      const rules: CommandRule[] = [
        { id: 99, prefix: 'ls', type: 'allowed', source: 'default', created_at: 1000 },
      ];
      manager.publishDirect('rules.list', rules);
      mockVSCode.postMessage.mockClear();

      const deleteBtn = element.shadowRoot?.querySelector('.rule-delete') as HTMLButtonElement;
      deleteBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'removeCommandRule',
        id: 99,
      });
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

    it('select defaults to "allowed" (Approved)', () => {
      const select = element.shadowRoot?.querySelector('[data-rule-type]') as HTMLSelectElement;
      expect(select.value).toBe('allowed');
    });

    it('select has Approved and Blocked options', () => {
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
