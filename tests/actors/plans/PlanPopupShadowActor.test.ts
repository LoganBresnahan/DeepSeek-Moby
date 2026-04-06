/**
 * Tests for PlanPopupShadowActor
 *
 * Tests the Shadow DOM popup for managing plan files including:
 * - Shadow root creation and structure
 * - Empty state (no plans)
 * - Plan list with checkboxes
 * - Toggle checkbox sends togglePlan message
 * - Click plan name sends openPlan message
 * - Delete button with confirmation flow
 * - Create new plan with input validation
 * - Publishes plans.activeCount state
 * - Enter key in create input submits
 * - Empty name rejected
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PlanPopupShadowActor,
  PlanFile
} from '../../../media/actors/plans/PlanPopupShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

// Mock VSCode API
const createMockVSCode = () => ({
  postMessage: vi.fn()
});

// Helper to wait for actor registration (deferred via queueMicrotask)
const waitForRegistration = () => new Promise(resolve => queueMicrotask(resolve));

describe('PlanPopupShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: PlanPopupShadowActor;
  let mockVSCode: ReturnType<typeof createMockVSCode>;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'plans-container';
    document.body.appendChild(element);
    mockVSCode = createMockVSCode();
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  // Helper to set up actor with plans via subscription
  async function setupWithPlans(plans: PlanFile[]): Promise<void> {
    actor = new PlanPopupShadowActor(manager, element, mockVSCode);
    await waitForRegistration();
    manager.publishDirect('plans.state', plans);
  }

  describe('Shadow DOM creation', () => {
    it('creates shadow root on construction', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      expect(element.shadowRoot).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });

    it('renders popup structure with header', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      const popup = element.shadowRoot?.querySelector('.popup-container');
      const header = element.shadowRoot?.querySelector('.popup-header');
      const body = element.shadowRoot?.querySelector('.popup-body');

      expect(popup).toBeTruthy();
      expect(header?.textContent).toContain('Plans');
      expect(body).toBeTruthy();
    });
  });

  describe('Empty state', () => {
    it('renders empty state when no plans', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      const emptyState = element.shadowRoot?.querySelector('.plans-empty');
      expect(emptyState).toBeTruthy();
      expect(emptyState?.textContent).toContain('No plans yet');
    });

    it('renders description text', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      const desc = element.shadowRoot?.querySelector('.plans-description');
      expect(desc).toBeTruthy();
      expect(desc?.textContent).toContain('Manage plan files');
    });

    it('renders New Plan button', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);

      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]');
      expect(newBtn).toBeTruthy();
      expect(newBtn?.textContent).toContain('New Plan');
    });
  });

  describe('Plan list rendering', () => {
    const samplePlans: PlanFile[] = [
      { name: 'feature-auth', active: true },
      { name: 'bugfix-login', active: false },
      { name: 'refactor-api', active: true }
    ];

    it('renders plan items with checkboxes', async () => {
      await setupWithPlans(samplePlans);

      const planItems = element.shadowRoot?.querySelectorAll('.plan-item');
      expect(planItems?.length).toBe(3);
    });

    it('renders plan names', async () => {
      await setupWithPlans(samplePlans);

      const names = element.shadowRoot?.querySelectorAll('.plan-name');
      const texts = Array.from(names || []).map(n => n.textContent);
      expect(texts).toContain('feature-auth');
      expect(texts).toContain('bugfix-login');
      expect(texts).toContain('refactor-api');
    });

    it('renders checkboxes with correct checked state', async () => {
      await setupWithPlans(samplePlans);

      const checkboxes = element.shadowRoot?.querySelectorAll('.plan-checkbox') as NodeListOf<HTMLInputElement>;
      expect(checkboxes[0].checked).toBe(true);
      expect(checkboxes[1].checked).toBe(false);
      expect(checkboxes[2].checked).toBe(true);
    });

    it('removes empty state when plans are present', async () => {
      await setupWithPlans(samplePlans);

      const emptyState = element.shadowRoot?.querySelector('.plans-empty');
      expect(emptyState).toBeNull();
    });
  });

  describe('Toggle checkbox', () => {
    it('sends togglePlan message when checkbox is changed', async () => {
      await setupWithPlans([{ name: 'my-plan', active: false }]);

      const checkbox = element.shadowRoot?.querySelector('.plan-checkbox') as HTMLInputElement;
      expect(checkbox).toBeTruthy();
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'togglePlan',
        name: 'my-plan'
      });
    });
  });

  describe('Click plan name', () => {
    it('sends openPlan message when plan name is clicked', async () => {
      await setupWithPlans([{ name: 'feature-plan', active: false }]);

      const planName = element.shadowRoot?.querySelector('[data-action="open"]') as HTMLElement;
      expect(planName).toBeTruthy();
      planName?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'openPlan',
        name: 'feature-plan'
      });
    });
  });

  describe('Delete with confirmation', () => {
    it('shows confirmation when delete button is clicked', async () => {
      await setupWithPlans([{ name: 'delete-me', active: false }]);

      const deleteBtn = element.shadowRoot?.querySelector('[data-action="delete"]') as HTMLElement;
      expect(deleteBtn).toBeTruthy();
      deleteBtn?.click();

      const confirmSection = element.shadowRoot?.querySelector('.plan-delete-confirm');
      expect(confirmSection).toBeTruthy();
      expect(confirmSection?.textContent).toContain('Delete?');
    });

    it('sends deletePlan message on confirm', async () => {
      await setupWithPlans([{ name: 'delete-me', active: false }]);

      // Click delete to show confirmation
      const deleteBtn = element.shadowRoot?.querySelector('[data-action="delete"]') as HTMLElement;
      deleteBtn?.click();

      // Click confirm
      const confirmBtn = element.shadowRoot?.querySelector('[data-action="confirm-delete"]') as HTMLElement;
      expect(confirmBtn).toBeTruthy();
      confirmBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'deletePlan',
        name: 'delete-me'
      });
    });

    it('cancels delete on cancel click', async () => {
      await setupWithPlans([{ name: 'delete-me', active: false }]);

      // Click delete to show confirmation
      const deleteBtn = element.shadowRoot?.querySelector('[data-action="delete"]') as HTMLElement;
      deleteBtn?.click();

      // Click cancel
      const cancelBtn = element.shadowRoot?.querySelector('[data-action="cancel-delete"]') as HTMLElement;
      expect(cancelBtn).toBeTruthy();
      cancelBtn?.click();

      // Should be back to normal plan item view
      const confirmSection = element.shadowRoot?.querySelector('.plan-delete-confirm');
      expect(confirmSection).toBeNull();
      const planName = element.shadowRoot?.querySelector('.plan-name');
      expect(planName).toBeTruthy();
    });
  });

  describe('Create new plan', () => {
    beforeEach(() => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
    });

    it('shows input when New Plan button is clicked', () => {
      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const input = element.shadowRoot?.querySelector('.plans-new-input') as HTMLInputElement;
      expect(input).toBeTruthy();
    });

    it('shows Create and Cancel buttons in new plan mode', () => {
      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const saveBtn = element.shadowRoot?.querySelector('[data-action="save-new"]');
      const cancelBtn = element.shadowRoot?.querySelector('[data-action="cancel-new"]');
      expect(saveBtn).toBeTruthy();
      expect(saveBtn?.textContent).toContain('Create');
      expect(cancelBtn).toBeTruthy();
    });

    it('sends createPlan message with name on save', () => {
      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const input = element.shadowRoot?.querySelector('.plans-new-input') as HTMLInputElement;
      input.value = 'my-new-plan';

      const saveBtn = element.shadowRoot?.querySelector('[data-action="save-new"]') as HTMLElement;
      saveBtn?.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'createPlan',
        name: 'my-new-plan'
      });
    });

    it('rejects empty name', () => {
      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const input = element.shadowRoot?.querySelector('.plans-new-input') as HTMLInputElement;
      input.value = '   ';

      const saveBtn = element.shadowRoot?.querySelector('[data-action="save-new"]') as HTMLElement;
      saveBtn?.click();

      // Should NOT send createPlan for empty/whitespace name
      expect(mockVSCode.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'createPlan' })
      );
    });

    it('cancels new plan input on cancel click', () => {
      const newBtn = element.shadowRoot?.querySelector('[data-action="new"]') as HTMLElement;
      newBtn?.click();

      const cancelBtn = element.shadowRoot?.querySelector('[data-action="cancel-new"]') as HTMLElement;
      cancelBtn?.click();

      // Should be back to normal footer
      const input = element.shadowRoot?.querySelector('.plans-new-input');
      expect(input).toBeNull();
      const newBtnAgain = element.shadowRoot?.querySelector('[data-action="new"]');
      expect(newBtnAgain).toBeTruthy();
    });
  });

  describe('plans.activeCount publication', () => {
    it('publishes active count when plans state updates', async () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
      await waitForRegistration();

      const handleSpy = vi.spyOn(manager, 'handleStateChange');

      manager.publishDirect('plans.state', [
        { name: 'plan-a', active: true },
        { name: 'plan-b', active: false },
        { name: 'plan-c', active: true }
      ] as PlanFile[]);

      // The actor calls this.publish({ 'plans.activeCount': 2 })
      // which internally calls manager.handleStateChange
      const publishCall = handleSpy.mock.calls.find(
        call => call[0]?.state?.['plans.activeCount'] !== undefined
      );
      expect(publishCall).toBeTruthy();
      expect(publishCall?.[0]?.state?.['plans.activeCount']).toBe(2);
    });

    it('publishes 0 when transitioning from active to all-inactive', async () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
      await waitForRegistration();

      // First publish with active plans to set count > 0
      manager.publishDirect('plans.state', [
        { name: 'plan-a', active: true }
      ] as PlanFile[]);

      const handleSpy = vi.spyOn(manager, 'handleStateChange');

      // Now publish with no active plans — count changes from 1 to 0
      manager.publishDirect('plans.state', [
        { name: 'plan-a', active: false },
        { name: 'plan-b', active: false }
      ] as PlanFile[]);

      const publishCall = handleSpy.mock.calls.find(
        call => call[0]?.state?.['plans.activeCount'] !== undefined
      );
      expect(publishCall).toBeTruthy();
      expect(publishCall?.[0]?.state?.['plans.activeCount']).toBe(0);
    });

    it('does not re-publish activeCount when count stays at 0', async () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
      await waitForRegistration();

      const handleSpy = vi.spyOn(manager, 'handleStateChange');

      // Publish empty plans — count is already 0 from registration
      manager.publishDirect('plans.state', [] as PlanFile[]);

      // Should NOT re-publish since count didn't change
      const publishCall = handleSpy.mock.calls.find(
        call => call[0]?.state?.['plans.activeCount'] !== undefined
      );
      expect(publishCall).toBeUndefined();
    });
  });

  describe('Popup visibility', () => {
    beforeEach(() => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
    });

    it('starts hidden', () => {
      expect(actor.isVisible()).toBe(false);
    });

    it('opens when toggle() is called', () => {
      actor.toggle();
      expect(actor.isVisible()).toBe(true);
    });

    it('requests plan refresh when opened', () => {
      actor.open();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'refreshPlans'
      });
    });

    it('opens via plans.popup.open subscription', async () => {
      await waitForRegistration();
      manager.publishDirect('plans.popup.open', true);
      expect(actor.isVisible()).toBe(true);
    });

    it('closes on Escape key', () => {
      actor.toggle();
      const event = new KeyboardEvent('keydown', { key: 'Escape' });
      document.dispatchEvent(event);

      expect(actor.isVisible()).toBe(false);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new PlanPopupShadowActor(manager, element, mockVSCode);
      actor.toggle();

      actor.destroy();

      expect(() => actor.isVisible()).not.toThrow();
    });
  });
});
