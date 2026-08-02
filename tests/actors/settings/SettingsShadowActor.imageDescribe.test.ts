/**
 * Settings popup — image-describe subagent picker.
 *
 * The list must contain only models that pass BOTH router gates —
 * `acceptsImages` AND `subagentRoles: ["image-describe"]`. Offering a model
 * that fails either one lets a user configure a combination the router then
 * refuses at route time, and the failure surfaces as a placeholder in chat,
 * far from the setting that caused it. That happened for real in dev-host
 * testing on 2026-08-02 with a model that had the capability but not the role.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsShadowActor } from '../../../media/actors/settings/SettingsShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

const MODELS = [
  { id: 'deepseek-chat', name: 'Chat (V3)', isCustom: false },
  { id: 'deepseek-reasoner', name: 'Reasoner (R1)', isCustom: false },
  { id: 'vl2', name: 'DeepSeek VL2', isCustom: true, acceptsImages: true, subagentRoles: ['image-describe'] },
  { id: 'gpt-vision', name: 'GPT Vision', isCustom: true, acceptsImages: true, subagentRoles: ['image-describe'] },
  { id: 'qwen-text', name: 'Qwen (text only)', isCustom: true, acceptsImages: false }
];

describe('SettingsShadowActor — image-describe picker', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: SettingsShadowActor;
  let mockVscode: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    document.body.appendChild(element);
    mockVscode = { postMessage: vi.fn() };
    ShadowActor.resetInstanceCount();
    actor = new SettingsShadowActor(manager, element, mockVscode as any);
    manager.publishDirect('settings.popup.open', true);
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  const html = () => element.shadowRoot?.innerHTML ?? '';
  const select = () => element.shadowRoot?.querySelector('[data-id="imageDescribeModel"]') as HTMLSelectElement | null;

  function publishModels(models: unknown[] = MODELS) {
    manager.publishDirect('model.list', models);
  }

  it('renders the section', () => {
    expect(html()).toContain('Image Description (Vision)');
  });

  it('lists only models that accept images', () => {
    publishModels();

    const options = Array.from(select()!.querySelectorAll('option')).map(o => o.getAttribute('value'));
    expect(options).toContain('vl2');
    expect(options).toContain('gpt-vision');
    expect(options).not.toContain('qwen-text');
    expect(options).not.toContain('deepseek-chat');
    expect(options).not.toContain('deepseek-reasoner');
  });

  it('offers an explicit off option', () => {
    publishModels();
    const off = select()!.querySelector('option[value=""]');
    expect(off?.textContent).toContain('Off');
  });

  it('explains the empty case instead of rendering an empty dropdown', () => {
    publishModels([
      { id: 'deepseek-chat', name: 'Chat (V3)', isCustom: false },
      { id: 'qwen-text', name: 'Qwen', isCustom: true, acceptsImages: false }
    ]);

    expect(select()).toBeNull();
    expect(html()).toContain('No vision-capable models registered');
    expect(html()).toContain('acceptsImages');
  });

  // Found in dev-host testing 2026-08-02: a model with acceptsImages but no
  // role declaration was offered by the picker and then refused by the router,
  // surfacing as a placeholder mid-conversation instead of at the setting.
  it('does not offer a vision model that lacks the image-describe role', () => {
    publishModels([
      { id: 'kimi-k3', name: 'Kimi (Moonshot)', isCustom: true, acceptsImages: true }
    ]);

    expect(select()).toBeNull();
  });

  it('names the model and the missing line rather than claiming none exist', () => {
    publishModels([
      { id: 'kimi-k3', name: 'Kimi (Moonshot)', isCustom: true, acceptsImages: true }
    ]);

    expect(html()).toContain('Kimi (Moonshot)');
    expect(html()).toContain('subagentRoles');
    expect(html()).not.toContain('No vision-capable models registered');
  });

  it('offers the eligible ones and diagnoses the rest', () => {
    publishModels([
      { id: 'vl2', name: 'DeepSeek VL2', isCustom: true, acceptsImages: true, subagentRoles: ['image-describe'] },
      { id: 'kimi-k3', name: 'Kimi (Moonshot)', isCustom: true, acceptsImages: true }
    ]);

    const options = Array.from(select()!.querySelectorAll('option')).map(o => o.getAttribute('value'));
    expect(options).toContain('vl2');
    expect(options).not.toContain('kimi-k3');
  });

  it('ignores a model declaring an unrelated subagent role', () => {
    publishModels([
      { id: 'x', name: 'X', isCustom: true, acceptsImages: true, subagentRoles: ['web-search-digest'] }
    ]);

    expect(select()).toBeNull();
  });

  it('preselects the configured model', () => {
    manager.publishDirect('settings.values', { imageDescribeModelId: 'gpt-vision' });
    publishModels();

    const selected = select()!.querySelector('option[selected]');
    expect(selected?.getAttribute('value')).toBe('gpt-vision');
  });

  it('selects Off when no model is configured', () => {
    manager.publishDirect('settings.values', { imageDescribeModelId: '' });
    publishModels();

    const selected = select()!.querySelector('option[selected]');
    expect(selected?.getAttribute('value')).toBe('');
  });

  it('writes the setting when a model is chosen', () => {
    publishModels();
    const el = select()!;
    el.value = 'vl2';
    el.dispatchEvent(new Event('change', { bubbles: true }));

    expect(mockVscode.postMessage).toHaveBeenCalledWith({
      type: 'setSubagentModel',
      role: 'image-describe',
      modelId: 'vl2'
    });
  });

  it('writes "off" rather than an empty string when turned off', () => {
    publishModels();
    const el = select()!;
    el.value = '';
    el.dispatchEvent(new Event('change', { bubbles: true }));

    expect(mockVscode.postMessage).toHaveBeenCalledWith({
      type: 'setSubagentModel',
      role: 'image-describe',
      modelId: 'off'
    });
  });

  it('does not disturb the flat-setting select path', () => {
    publishModels();
    const logSelect = element.shadowRoot?.querySelector('.settings-select[data-setting]') as HTMLSelectElement | null;
    if (!logSelect) return; // no flat selects rendered in this popup state

    logSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mockVscode.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setSubagentModel' })
    );
  });
});
