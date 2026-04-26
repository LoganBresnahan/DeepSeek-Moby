/**
 * Tests for StatsModalActor.
 *
 * StatsModal is a read-only display — its only "logic" is the conditional
 * rendering of balance / Tavily credit cards based on what arrives via
 * the `stats.data` subscription. These tests pin:
 *
 *   - Construction wires up the shadow root + modal scaffold.
 *   - Loading state shows before any data arrives, then transitions to
 *     a content state once `stats.data` publishes.
 *   - Balance value-class thresholds: >$5 → balance, $1..$5 → warning,
 *     ≤$1 → error. Important — the user-visible color cue is what
 *     surfaces "you're about to run out of credit".
 *   - Tavily credit-percentage thresholds: >50% → balance, 20..50% →
 *     warning, ≤20% → error.
 *   - Null balance falls back to em-dash placeholder.
 *   - Null tavilyApiUsage shows "Not configured".
 *   - Re-opening clears prior data and returns to loading state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatsModalActor } from '../../../media/actors/stats/StatsModalActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

const createMockVSCode = () => ({ postMessage: vi.fn() });

const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('StatsModalActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: StatsModalActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'stats-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  /** Create the actor, wait for actor registration, then open it. */
  async function openModal(): Promise<void> {
    actor = new StatsModalActor(manager, element, mockVSCode);
    await waitForRegistration();
    actor.open();
  }

  /** Convenience: select-text helper across the shadow root. */
  function shadowText(selector: string): string {
    return element.shadowRoot?.querySelector(selector)?.textContent?.trim() ?? '';
  }

  function bodyHtml(): string {
    return element.shadowRoot?.querySelector('.modal-body')?.innerHTML ?? '';
  }

  describe('Shadow DOM construction', () => {
    it('creates a shadow root', async () => {
      actor = new StatsModalActor(manager, element, mockVSCode);
      await waitForRegistration();
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders the "Account Stats" title', async () => {
      actor = new StatsModalActor(manager, element, mockVSCode);
      await waitForRegistration();
      const title = element.shadowRoot?.querySelector('.modal-title');
      expect(title?.textContent).toContain('Account Stats');
    });

    it('starts hidden', async () => {
      actor = new StatsModalActor(manager, element, mockVSCode);
      await waitForRegistration();
      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Loading and data states', () => {
    it('renders the loading message before any data arrives', async () => {
      await openModal();
      expect(bodyHtml()).toContain('Loading account data');
    });

    it('replaces loading state with content once stats.data arrives', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        stats: { totalSessions: 7, totalMessages: 42, totalTokens: 100 },
        balance: { available: true, balance: '12.34', currency: 'USD' }
      });
      const html = bodyHtml();
      expect(html).not.toContain('Loading account data');
      expect(html).toContain('$12.34');
      expect(html).toContain('Sessions');
    });

    it('renders the failure placeholder when data is null after loading flag clears', () => {
      // Drive the actor through the same data path that the subscription would
      // — the handler nulls `_loading` then re-renders. Bypass it to simulate
      // a malformed payload (e.g. extension errored out and sent null).
      actor = new StatsModalActor(manager, element, mockVSCode);
      // Force the post-loading-but-null state by replaying the subscription
      // logic with an explicit null.
      (actor as any)._data = null;
      (actor as any)._loading = false;
      const html = (actor as any).renderModalContent() as string;
      expect(html).toContain('Failed to load stats data');
    });
  });

  describe('Balance card thresholds', () => {
    it('uses the "balance" green class when amount > $5', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: '50.00', currency: 'USD' }
      });
      const html = bodyHtml();
      expect(html).toMatch(/stats-card-value\s+balance">\$50\.00/);
    });

    it('uses the "warning" class when amount is between $1 and $5', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: '3.50', currency: 'USD' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+warning">\$3\.50/);
    });

    it('uses the "error" class when amount is at or below $1', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: '0.50', currency: 'USD' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+error">\$0\.50/);
    });

    it('treats unparseable balance strings as $0 (error class)', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: 'not-a-number', currency: 'USD' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+error">\$0\.00/);
    });

    it('falls back to em-dash placeholder when balance is null', async () => {
      await openModal();
      manager.publishDirect('stats.data', { balance: null });
      const html = bodyHtml();
      expect(html).toContain('Balance (unavailable)');
      expect(html).toContain('—');
    });

    it('shows the configured currency code', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: '10.00', currency: 'EUR' }
      });
      expect(bodyHtml()).toContain('Balance (EUR)');
    });
  });

  describe('Tavily credit thresholds', () => {
    it('uses the "balance" class when remaining > 50% of limit', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        tavilyApiUsage: { used: 100, limit: 1000, remaining: 800, plan: 'Pro' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+balance">800/);
    });

    it('uses the "warning" class for 20..50% remaining', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        tavilyApiUsage: { used: 700, limit: 1000, remaining: 300, plan: 'Pro' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+warning">300/);
    });

    it('uses the "error" class when ≤20% remaining', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        tavilyApiUsage: { used: 900, limit: 1000, remaining: 100, plan: 'Pro' }
      });
      expect(bodyHtml()).toMatch(/stats-card-value\s+error">100/);
    });

    it('renders "Not configured" placeholder when tavilyApiUsage is null', async () => {
      await openModal();
      manager.publishDirect('stats.data', { tavilyApiUsage: null });
      expect(bodyHtml()).toContain('Not configured');
    });

    it('skips the credits-remaining card when limit is missing or zero', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        tavilyApiUsage: { used: 5, limit: null, remaining: null, plan: 'Free' }
      });
      const html = bodyHtml();
      expect(html).not.toContain('Credits Remaining');
      expect(html).toContain('Credits Used');
      expect(html).toContain('Free');
    });

    it('renders session-search counts when tavilyStats present', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        tavilyStats: { totalSearches: 9, basicSearches: 6, advancedSearches: 3, totalCreditsUsed: 12 }
      });
      const html = bodyHtml();
      expect(html).toMatch(/9[\s\S]*Searches \(session\)/);
    });
  });

  describe('Re-open behavior', () => {
    it('clears prior data and returns to loading state on each open()', async () => {
      await openModal();
      manager.publishDirect('stats.data', {
        balance: { available: true, balance: '50.00', currency: 'USD' }
      });
      expect(bodyHtml()).toContain('$50.00');

      // Close and reopen — the modal should not show stale data.
      actor.close();
      actor.open();
      const reopenedHtml = bodyHtml();
      expect(reopenedHtml).toContain('Loading account data');
      expect(reopenedHtml).not.toContain('$50.00');
    });
  });
});
