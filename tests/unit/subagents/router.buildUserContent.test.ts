/**
 * SubagentRouter — the multimodal `buildUserContent` hook (image-describe Phase 1).
 *
 * The hook is optional: text roles keep returning a string from
 * buildUserMessage and must be completely unaffected. When a role does supply
 * it, the content array must reach the transport verbatim, and the trace's
 * inputBytes must measure the array rather than reading `.length` off it
 * (which would report the number of parts — 2 — instead of the payload size).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChat, mockGetConfiguration, mockGetCapabilities, mockTracer, mockLogger } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockGetConfiguration: vi.fn(),
  mockGetCapabilities: vi.fn(),
  mockTracer: {
    startSpan: vi.fn(() => 'span-id'),
    endSpan: vi.fn(),
    trace: vi.fn(() => 'trace-id')
  },
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }
}));

vi.mock('vscode', () => ({ workspace: { getConfiguration: mockGetConfiguration } }));
vi.mock('../../../src/deepseekClient', () => ({
  DeepSeekClient: vi.fn().mockImplementation(() => ({ chat: mockChat, setModel: vi.fn() }))
}));
vi.mock('../../../src/tracing', () => ({ tracer: mockTracer }));
vi.mock('../../../src/utils/logger', () => ({ logger: mockLogger }));
vi.mock('../../../src/models/registry', () => ({ getCapabilities: mockGetCapabilities }));

import { SubagentRouter } from '../../../src/subagents/router';
import type { SubagentRole, SubagentMessageContent } from '../../../src/subagents/types';

const DATA_URI = `data:image/webp;base64,${'A'.repeat(400)}`;

function imageRole(
  overrides?: Partial<SubagentRole<{ dataUri: string }, { description: string }>>
): SubagentRole<{ dataUri: string }, { description: string }> {
  return {
    name: 'image-describe',
    shouldRoute: () => true,
    buildSystemPrompt: () => 'describe the image',
    buildUserMessage: () => 'FALLBACK-STRING',
    requiresImageSupport: true,
    buildUserContent: (input): SubagentMessageContent => [
      { type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: input.dataUri } }
    ],
    parse: (raw): { description: string } | null => {
      const o = raw as Record<string, unknown>;
      return o && typeof o.description === 'string' ? { description: o.description } : null;
    },
    formatForMain: out => `digest: ${out.description}`,
    ...overrides
  };
}

function createContext() {
  return { secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() }, subscriptions: [] } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfiguration.mockReturnValue({
    get: (key: string) => (key === 'subagents' ? { 'image-describe': 'vision-model' } : undefined)
  });
  mockGetCapabilities.mockReturnValue({ subagentRoles: ['image-describe'], acceptsImages: true });
  mockChat.mockResolvedValue({ content: JSON.stringify({ description: 'a whale' }) });
});

describe('SubagentRouter — buildUserContent hook', () => {
  it('sends the content array verbatim when the role supplies one', async () => {
    const router = new SubagentRouter(createContext());
    const result = await router.route(imageRole(), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    expect(result).toEqual({ routed: true, digest: 'digest: a whale' });
    const [messages] = mockChat.mock.calls[0];
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: DATA_URI } }
    ]);
  });

  it('prefers buildUserContent over buildUserMessage', async () => {
    const buildUserMessage = vi.fn(() => 'FALLBACK-STRING');
    const router = new SubagentRouter(createContext());
    await router.route(imageRole({ buildUserMessage }), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    const [messages] = mockChat.mock.calls[0];
    expect(messages[0].content).not.toBe('FALLBACK-STRING');
  });

  it('falls back to buildUserMessage when the hook is absent (text roles unchanged)', async () => {
    const role = imageRole();
    delete (role as any).buildUserContent;

    const router = new SubagentRouter(createContext());
    await router.route(role, { dataUri: DATA_URI }, { recentUserPrompt: '' });

    const [messages] = mockChat.mock.calls[0];
    expect(messages[0].content).toBe('FALLBACK-STRING');
  });

  it('measures inputBytes across content parts, not array length', async () => {
    const router = new SubagentRouter(createContext());
    await router.route(imageRole(), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    const [, payload] = mockTracer.endSpan.mock.calls[0];
    // 'Describe this.' (14) + the data URI — decidedly not 2.
    expect(payload.data.inputBytes).toBe(14 + DATA_URI.length);
  });

  it('reports array inputBytes on the failure paths too', async () => {
    mockChat.mockRejectedValueOnce(new Error('boom'));
    const router = new SubagentRouter(createContext());
    const result = await router.route(imageRole(), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    expect(result).toEqual({ routed: false, reason: 'sub-error' });
    const [, payload] = mockTracer.endSpan.mock.calls[0];
    expect(payload.data.inputBytes).toBe(14 + DATA_URI.length);
  });

  it('refuses a model that declares the role but not acceptsImages', async () => {
    mockGetCapabilities.mockReturnValue({ subagentRoles: ['image-describe'], acceptsImages: false });

    const router = new SubagentRouter(createContext());
    const result = await router.route(imageRole(), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    // Would 400 on the image_url block rather than degrade — never send it.
    expect(result).toEqual({ routed: false, reason: 'no-model' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('acceptsImages'));
  });

  it('does not require acceptsImages for text roles', async () => {
    mockGetCapabilities.mockReturnValue({ subagentRoles: ['image-describe'] });
    const role = imageRole();
    delete (role as any).buildUserContent;
    delete (role as any).requiresImageSupport;

    const router = new SubagentRouter(createContext());
    const result = await router.route(role, { dataUri: DATA_URI }, { recentUserPrompt: '' });

    expect(result).toEqual({ routed: true, digest: 'digest: a whale' });
  });

  it('accepts a fenced JSON response from a VL backend', async () => {
    mockChat.mockResolvedValue({ content: '```json\n{"description":"a whale"}\n```' });

    const router = new SubagentRouter(createContext());
    const result = await router.route(imageRole(), { dataUri: DATA_URI }, { recentUserPrompt: '' });

    expect(result).toEqual({ routed: true, digest: 'digest: a whale' });
  });

  it('still measures a plain string body as its length', async () => {
    const role = imageRole();
    delete (role as any).buildUserContent;

    const router = new SubagentRouter(createContext());
    await router.route(role, { dataUri: DATA_URI }, { recentUserPrompt: '' });

    const [, payload] = mockTracer.endSpan.mock.calls[0];
    expect(payload.data.inputBytes).toBe('FALLBACK-STRING'.length);
  });
});
