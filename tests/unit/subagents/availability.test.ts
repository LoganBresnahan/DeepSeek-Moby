/**
 * isImageDescribeAvailable — the double gate (setting names a model AND that
 * model declares acceptsImages + the role) as a pure predicate. The drawing
 * server consults it per request; the QR popup shows it via
 * drawingServerState.imageMode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockConfigValues } = vi.hoisted(() => ({
  mockConfigValues: new Map<string, unknown>()
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

import { isImageDescribeAvailable } from '../../../src/subagents/availability';
import { registerCustomModels, __resetCustomModelsForTests } from '../../../src/models/registry';

function registerVisionModel(extra: Record<string, unknown> = {}) {
  registerCustomModels([{
    id: 'vl-test', name: 'VL Test',
    toolCalling: 'native', reasoningTokens: 'none',
    editProtocol: ['native-tool'], shellProtocol: 'none',
    supportsTemperature: true, maxOutputTokens: 4096,
    maxTokensConfigKey: 'customModels.vl-test.maxOutputTokens',
    streaming: true, apiEndpoint: 'https://example.test/v1',
    requestFormat: 'openai',
    acceptsImages: true, subagentRoles: ['image-describe'],
    ...extra
  }]);
}

describe('isImageDescribeAvailable', () => {
  beforeEach(() => mockConfigValues.clear());
  afterEach(() => __resetCustomModelsForTests());

  it('true when the setting names a model passing both gates', () => {
    registerVisionModel();
    mockConfigValues.set('subagents', { 'image-describe': 'vl-test' });
    expect(isImageDescribeAvailable()).toBe(true);
  });

  it('false when the setting is absent or off', () => {
    registerVisionModel();
    expect(isImageDescribeAvailable()).toBe(false);
    mockConfigValues.set('subagents', { 'image-describe': 'off' });
    expect(isImageDescribeAvailable()).toBe(false);
  });

  it('false when the model lacks acceptsImages', () => {
    registerVisionModel({ acceptsImages: false });
    mockConfigValues.set('subagents', { 'image-describe': 'vl-test' });
    expect(isImageDescribeAvailable()).toBe(false);
  });

  it('false when the model does not declare the role', () => {
    registerVisionModel({ subagentRoles: [] });
    mockConfigValues.set('subagents', { 'image-describe': 'vl-test' });
    expect(isImageDescribeAvailable()).toBe(false);
  });

  it('false for a stale id — the registry fallback declares neither gate', () => {
    mockConfigValues.set('subagents', { 'image-describe': 'model-that-was-removed' });
    expect(isImageDescribeAvailable()).toBe(false);
  });

  it('tracks live config — flipping the setting flips the answer with no restart', () => {
    registerVisionModel();
    mockConfigValues.set('subagents', { 'image-describe': 'vl-test' });
    expect(isImageDescribeAvailable()).toBe(true);
    mockConfigValues.set('subagents', { 'image-describe': 'off' });
    expect(isImageDescribeAvailable()).toBe(false);
  });
});
