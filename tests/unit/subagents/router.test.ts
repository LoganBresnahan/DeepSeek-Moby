/**
 * Unit tests for SubagentRouter.
 *
 * Covers: setting resolution, threshold gating, model-eligibility check,
 * JSON-mode call shape, parse/schema/sub-error fallback paths, per-modelId
 * client cache, task-context propagation, trace event shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockChat, mockSetModel, mockClientConstructor, mockGetConfiguration, mockGetCapabilities, mockTracer, mockLogger } = vi.hoisted(() => {
  const mockChat = vi.fn();
  const mockSetModel = vi.fn();
  const mockClientConstructor = vi.fn();
  return {
    mockChat,
    mockSetModel,
    mockClientConstructor,
    mockGetConfiguration: vi.fn(),
    mockGetCapabilities: vi.fn(),
    mockTracer: {
      startSpan: vi.fn(() => 'span-id'),
      endSpan: vi.fn(),
      trace: vi.fn(() => 'trace-id')
    },
    mockLogger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    }
  };
});

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: mockGetConfiguration
  }
}));

vi.mock('../../../src/deepseekClient', () => ({
  DeepSeekClient: vi.fn().mockImplementation((ctx: unknown) => {
    mockClientConstructor(ctx);
    return {
      chat: mockChat,
      setModel: mockSetModel
    };
  })
}));

vi.mock('../../../src/tracing', () => ({
  tracer: mockTracer
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mockLogger
}));

vi.mock('../../../src/models/registry', () => ({
  getCapabilities: mockGetCapabilities
}));

import { SubagentRouter } from '../../../src/subagents/router';
import type { SubagentRole, SubagentTaskContext } from '../../../src/subagents/types';

// ── Test fixtures ──────────────────────────────────────────────────

interface FixtureInput {
  size: number;
  payload: string;
}

interface FixtureOutput {
  summary: string;
}

function buildFixtureRole(overrides?: Partial<SubagentRole<FixtureInput, FixtureOutput>>): SubagentRole<FixtureInput, FixtureOutput> {
  return {
    name: 'web-search-digest',
    shouldRoute: vi.fn((input) => input.size > 5),
    buildSystemPrompt: vi.fn((ctx: SubagentTaskContext) => `system: ${ctx.recentUserPrompt}`),
    buildUserMessage: vi.fn((input) => `user: ${input.payload}`),
    parse: vi.fn((raw): FixtureOutput | null => {
      if (!raw || typeof raw !== 'object') return null;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.summary !== 'string') return null;
      return { summary: obj.summary };
    }),
    formatForMain: vi.fn((output) => `digest: ${output.summary}`),
    ...overrides
  };
}

function createContext() {
  return {
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn()
    },
    subscriptions: []
  } as any;
}

function setSubagentSetting(modelId: string | undefined): void {
  mockGetConfiguration.mockReturnValue({
    get: vi.fn((key: string) => {
      if (key === 'subagents') {
        return modelId === undefined ? undefined : { 'web-search-digest': modelId };
      }
      return undefined;
    })
  });
}

function setModelCapabilities(roles: string[] | undefined): void {
  mockGetCapabilities.mockReturnValue({ subagentRoles: roles });
}

beforeEach(() => {
  vi.clearAllMocks();
  setSubagentSetting('deepseek-v4-flash-thinking');
  setModelCapabilities(['web-search-digest']);
});

// ── Tests ──────────────────────────────────────────────────────────

describe('SubagentRouter', () => {
  describe('setting resolution', () => {
    it('returns routed:false reason "off" when setting absent', async () => {
      setSubagentSetting(undefined);
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'big' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'off' });
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('returns routed:false reason "off" when setting is "off"', async () => {
      setSubagentSetting('off');
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'big' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'off' });
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('threshold gating', () => {
    it('skips sub when shouldRoute returns false', async () => {
      const router = new SubagentRouter(createContext());
      const role = buildFixtureRole();
      const result = await router.route(role, { size: 1, payload: 'tiny' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'below-threshold' });
      expect(role.shouldRoute).toHaveBeenCalled();
      expect(mockChat).not.toHaveBeenCalled();
    });
  });

  describe('model eligibility', () => {
    it('returns routed:false reason "no-model" when configured model is not declared for the role', async () => {
      setModelCapabilities([]); // model serves no roles
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'x' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'no-model' });
      expect(mockChat).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not declared for role'));
    });

    it('returns routed:false reason "no-model" when subagentRoles is undefined', async () => {
      setModelCapabilities(undefined);
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'x' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'no-model' });
    });
  });

  describe('successful route', () => {
    it('returns routed:true with formatted digest on valid JSON output', async () => {
      mockChat.mockResolvedValue({ content: '{"summary":"ok"}' });
      const router = new SubagentRouter(createContext());
      const role = buildFixtureRole();
      const result = await router.route(role, { size: 100, payload: 'data' }, { recentUserPrompt: 'fix the auth bug' });
      expect(result).toEqual({ routed: true, digest: 'digest: ok' });
      expect(role.formatForMain).toHaveBeenCalled();
    });

    it('calls chat with jsonMode:true, thinkingMode:disabled, and the role-built prompt + user message', async () => {
      mockChat.mockResolvedValue({ content: '{"summary":"ok"}' });
      const router = new SubagentRouter(createContext());
      const role = buildFixtureRole();
      await router.route(role, { size: 100, payload: 'data' }, { recentUserPrompt: 'task here' });
      expect(mockChat).toHaveBeenCalledWith(
        [{ role: 'user', content: 'user: data' }],
        'system: task here',
        { jsonMode: true, thinkingMode: 'disabled' }
      );
    });
  });

  describe('failure paths', () => {
    it('returns parse-fail when sub returns non-JSON content', async () => {
      mockChat.mockResolvedValue({ content: 'this is not json' });
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'x' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'parse-fail' });
      expect(mockTracer.endSpan).toHaveBeenCalledWith('span-id', expect.objectContaining({
        status: 'failed',
        data: expect.objectContaining({ validationResult: 'parse-fail' })
      }));
    });

    it('returns schema-fail when JSON parses but role.parse returns null', async () => {
      mockChat.mockResolvedValue({ content: '{"unexpected":"shape"}' });
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'x' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'schema-fail' });
      expect(mockTracer.endSpan).toHaveBeenCalledWith('span-id', expect.objectContaining({
        status: 'failed',
        data: expect.objectContaining({ validationResult: 'schema-fail' })
      }));
    });

    it('returns sub-error when chat throws', async () => {
      mockChat.mockRejectedValue(new Error('network down'));
      const router = new SubagentRouter(createContext());
      const result = await router.route(buildFixtureRole(), { size: 100, payload: 'x' }, { recentUserPrompt: '' });
      expect(result).toEqual({ routed: false, reason: 'sub-error' });
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
      expect(mockTracer.endSpan).toHaveBeenCalledWith('span-id', expect.objectContaining({
        status: 'failed',
        error: 'network down',
        data: expect.objectContaining({ validationResult: 'sub-error' })
      }));
    });
  });

  describe('per-modelId client cache', () => {
    it('constructs DeepSeekClient once per modelId across multiple routes', async () => {
      mockChat.mockResolvedValue({ content: '{"summary":"ok"}' });
      const router = new SubagentRouter(createContext());
      const role = buildFixtureRole();
      await router.route(role, { size: 100, payload: 'a' }, { recentUserPrompt: '' });
      await router.route(role, { size: 100, payload: 'b' }, { recentUserPrompt: '' });
      expect(mockClientConstructor).toHaveBeenCalledTimes(1);
      expect(mockSetModel).toHaveBeenCalledTimes(1);
      expect(mockSetModel).toHaveBeenCalledWith('deepseek-v4-flash-thinking');
    });
  });

  describe('task context propagation', () => {
    it('passes user prompt verbatim to the role buildSystemPrompt', async () => {
      mockChat.mockResolvedValue({ content: '{"summary":"ok"}' });
      const router = new SubagentRouter(createContext());
      const role = buildFixtureRole();
      await router.route(role, { size: 100, payload: 'x' }, { recentUserPrompt: 'pinpoint user task' });
      expect(role.buildSystemPrompt).toHaveBeenCalledWith({ recentUserPrompt: 'pinpoint user task' });
    });
  });

  describe('trace event shape', () => {
    it('emits a started + completed pair with role, modelId, and byte counts on success', async () => {
      mockChat.mockResolvedValue({ content: '{"summary":"ok"}' });
      const router = new SubagentRouter(createContext());
      await router.route(buildFixtureRole(), { size: 100, payload: 'data' }, { recentUserPrompt: '' });
      expect(mockTracer.startSpan).toHaveBeenCalledWith('subagent.route', 'web-search-digest', expect.objectContaining({
        executionMode: 'async',
        data: expect.objectContaining({ role: 'web-search-digest', modelId: 'deepseek-v4-flash-thinking' })
      }));
      expect(mockTracer.endSpan).toHaveBeenCalledWith('span-id', expect.objectContaining({
        status: 'completed',
        data: expect.objectContaining({
          role: 'web-search-digest',
          modelId: 'deepseek-v4-flash-thinking',
          validationResult: 'ok',
          inputBytes: expect.any(Number),
          outputBytes: expect.any(Number),
          digestBytes: expect.any(Number),
          durationMs: expect.any(Number)
        })
      }));
    });
  });
});
