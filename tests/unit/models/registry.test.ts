import { describe, it, expect, beforeEach } from 'vitest';
import {
  MODEL_REGISTRY,
  DEFAULT_MODEL_ID,
  getCapabilities,
  getRegisteredModelIds,
  getAllRegisteredModels,
  isReasonerModel,
  supportsManualMode,
  registerCustomModels,
  validateCustomModelEntry,
  __resetCustomModelsForTests,
} from '../../../src/models/registry';

describe('model registry', () => {
  describe('MODEL_REGISTRY', () => {
    it('registers deepseek-chat with native tool calling and native-tool shell protocol', () => {
      const caps = MODEL_REGISTRY['deepseek-chat'];
      expect(caps.toolCalling).toBe('native');
      expect(caps.reasoningTokens).toBe('none');
      // Phase 3.75 — V3 chat opted into the run_shell tool path. R1 stays
      // on 'xml-shell'; native-tool models flip to 'native-tool'.
      expect(caps.shellProtocol).toBe('native-tool');
      expect(caps.supportsTemperature).toBe(true);
      expect(caps.maxOutputTokens).toBe(8192);
      expect(caps.maxTokensConfigKey).toBe('maxTokensChatModel');
    });

    it('registers deepseek-reasoner with inline reasoning and xml-shell', () => {
      const caps = MODEL_REGISTRY['deepseek-reasoner'];
      expect(caps.toolCalling).toBe('none');
      expect(caps.reasoningTokens).toBe('inline');
      expect(caps.shellProtocol).toBe('xml-shell');
      expect(caps.supportsTemperature).toBe(false);
      expect(caps.maxOutputTokens).toBe(65536);
      expect(caps.maxTokensConfigKey).toBe('maxTokensReasonerModel');
    });

    // V4 family regression locks. V4 always reasons — the upstream model
    // emits `reasoning_content` regardless of the `thinking` flag, so a
    // separate non-thinking SKU was misleading and 400'd on iter 2 when we
    // didn't echo it back. Lineup is now flash-thinking + pro-thinking only;
    // the "(Thinking)" qualifier is dropped from display labels.
    it('does not register V4 non-thinking entries (dropped — V4 always reasons)', () => {
      expect(MODEL_REGISTRY['deepseek-v4-flash']).toBeUndefined();
      expect(MODEL_REGISTRY['deepseek-v4-pro']).toBeUndefined();
    });

    it('registers V4-flash-thinking with thinking flags + minimal promptStyle + high reasoning effort', () => {
      const caps = MODEL_REGISTRY['deepseek-v4-flash-thinking'];
      expect(caps).toBeDefined();
      expect(caps.toolCalling).toBe('native');
      expect(caps.reasoningTokens).toBe('inline');
      expect(caps.shellProtocol).toBe('native-tool');
      // Thinking mode rejects sampling params.
      expect(caps.supportsTemperature).toBe(false);
      // Wire-format flags driven by the V4-thinking transform.
      expect(caps.sendThinkingParam).toBe(true);
      expect(caps.reasoningEcho).toBe('required');
      expect(caps.reasoningEffort).toBe('high');
      // Phase 3.5 — V4-thinking uses the minimal prompt template.
      expect(caps.promptStyle).toBe('minimal');
      // Phase 4.5 — opted into the streaming-tool-calls pipeline.
      expect(caps.streamingToolCalls).toBe(true);
    });

    it('registers V4-pro-thinking identically to flash-thinking but with max reasoning effort default', () => {
      const caps = MODEL_REGISTRY['deepseek-v4-pro-thinking'];
      expect(caps).toBeDefined();
      expect(caps.sendThinkingParam).toBe(true);
      expect(caps.reasoningEcho).toBe('required');
      expect(caps.reasoningEffort).toBe('max'); // pro defaults to max
      expect(caps.promptStyle).toBe('minimal');
      expect(caps.supportsTemperature).toBe(false);
      // Phase 4.5 — opted into the streaming-tool-calls pipeline.
      expect(caps.streamingToolCalls).toBe(true);
    });

    it('keeps streamingToolCalls off on V3 chat (interleaved content+tool_calls cause render-order issues; retiring 2026-07-24)', () => {
      expect(MODEL_REGISTRY['deepseek-chat'].streamingToolCalls).toBe(false);
      expect(MODEL_REGISTRY['deepseek-reasoner'].streamingToolCalls).toBeUndefined();
    });
  });

  describe('getCapabilities', () => {
    it('returns registered capabilities for known models', () => {
      expect(getCapabilities('deepseek-chat').toolCalling).toBe('native');
      expect(getCapabilities('deepseek-reasoner').toolCalling).toBe('none');
    });

    it('falls back to the default model for unknown IDs', () => {
      const unknown = getCapabilities('some-unknown-model');
      const defaults = getCapabilities(DEFAULT_MODEL_ID);
      expect(unknown).toEqual(defaults);
    });
  });

  describe('getRegisteredModelIds', () => {
    it('returns all registered model IDs', () => {
      const ids = getRegisteredModelIds();
      expect(ids).toContain('deepseek-chat');
      expect(ids).toContain('deepseek-reasoner');
    });
  });

  describe('isReasonerModel', () => {
    it('returns true for deepseek-reasoner', () => {
      expect(isReasonerModel('deepseek-reasoner')).toBe(true);
    });

    it('returns false for deepseek-chat', () => {
      expect(isReasonerModel('deepseek-chat')).toBe(false);
    });

    it('returns false for unknown models (fallback is chat-like)', () => {
      expect(isReasonerModel('unknown-model')).toBe(false);
    });
  });

  describe('DEFAULT_MODEL_ID', () => {
    it('points to a registered model', () => {
      expect(MODEL_REGISTRY[DEFAULT_MODEL_ID]).toBeDefined();
    });
  });

  describe('apiEndpoint', () => {
    it('deepseek models use the official DeepSeek base URL (no /v1 suffix)', () => {
      // DeepSeek docs specify base URL without /v1. Keep consistent with
      // working code + /user/balance path compatibility.
      expect(MODEL_REGISTRY['deepseek-chat'].apiEndpoint).toBe('https://api.deepseek.com');
      expect(MODEL_REGISTRY['deepseek-reasoner'].apiEndpoint).toBe('https://api.deepseek.com');
    });

    it('apiKey is optional on capabilities (falls back to secret storage when absent)', () => {
      // Built-in entries don't declare an apiKey — the global secret is used.
      expect(MODEL_REGISTRY['deepseek-chat'].apiKey).toBeUndefined();
      expect(MODEL_REGISTRY['deepseek-reasoner'].apiKey).toBeUndefined();
    });
  });

  describe('supportsManualMode', () => {
    const baseEntry = {
      name: 'Test',
      toolCalling: 'none' as const,
      reasoningTokens: 'none' as const,
      shellProtocol: 'none' as const,
      supportsTemperature: true,
      maxOutputTokens: 4096,
      maxTokensConfigKey: 'maxTokensTest',
      streaming: true,
      apiEndpoint: 'http://localhost/v1',
      requestFormat: 'openai' as const,
    };

    beforeEach(() => __resetCustomModelsForTests());

    it('blocks manual for built-in Chat (primary edit protocol is native-tool)', () => {
      // deepseek-chat declares ['native-tool', 'search-replace']
      expect(supportsManualMode('deepseek-chat')).toBe(false);
    });

    it('allows manual for built-in R1 (search-replace only)', () => {
      expect(supportsManualMode('deepseek-reasoner')).toBe(true);
    });

    it('blocks manual when editProtocol[0] is native-tool', () => {
      registerCustomModels([{
        id: 'custom-native-only',
        editProtocol: ['native-tool'],
        toolCalling: 'native' as const,
        ...baseEntry
      }]);
      expect(supportsManualMode('custom-native-only')).toBe(false);
    });

    it('allows manual when editProtocol[0] is search-replace', () => {
      registerCustomModels([{
        id: 'custom-sr-only',
        editProtocol: ['search-replace'],
        ...baseEntry
      }]);
      expect(supportsManualMode('custom-sr-only')).toBe(true);
    });

    it('blocks manual when both are listed with native-tool first', () => {
      registerCustomModels([{
        id: 'custom-native-first',
        editProtocol: ['native-tool', 'search-replace'],
        toolCalling: 'native' as const,
        ...baseEntry
      }]);
      expect(supportsManualMode('custom-native-first')).toBe(false);
    });

    it('allows manual when both are listed with search-replace first', () => {
      registerCustomModels([{
        id: 'custom-sr-first',
        editProtocol: ['search-replace', 'native-tool'],
        toolCalling: 'native' as const,
        ...baseEntry
      }]);
      expect(supportsManualMode('custom-sr-first')).toBe(true);
    });

    it('allows manual when editProtocol is empty (reference-code-only model)', () => {
      registerCustomModels([{
        id: 'custom-reference-only',
        editProtocol: [],
        ...baseEntry
      }]);
      expect(supportsManualMode('custom-reference-only')).toBe(true);
    });
  });

  describe('tokenizer', () => {
    it('deepseek models declare the deepseek-v3 tokenizer (for exact WASM counting)', () => {
      expect(MODEL_REGISTRY['deepseek-chat'].tokenizer).toBe('deepseek-v3');
      expect(MODEL_REGISTRY['deepseek-reasoner'].tokenizer).toBe('deepseek-v3');
    });

    it('tokenizer is optional — unknown models get undefined (estimation fallback)', () => {
      const unknown = getCapabilities('some-unknown-model');
      // Falls back to DEFAULT_MODEL_ID which is deepseek-v4-pro-thinking, so has tokenizer.
      // But the field itself is optional for custom registrations.
      expect(unknown.tokenizer).toBe('deepseek-v3'); // inherited from fallback
    });
  });

  describe('custom models', () => {
    const validEntry = {
      id: 'qwen2.5-coder-local',
      name: 'Qwen 2.5 Coder (Ollama)',
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool'],
      shellProtocol: 'none',
      supportsTemperature: true,
      maxOutputTokens: 8192,
      maxTokensConfigKey: 'maxTokensCustomQwen',
      streaming: true,
      apiEndpoint: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      requestFormat: 'openai',
    };

    beforeEach(() => {
      __resetCustomModelsForTests();
    });

    describe('validateCustomModelEntry', () => {
      it('accepts a valid entry', () => {
        expect(validateCustomModelEntry(validEntry)).toEqual({ ok: true });
      });

      it('rejects an entry without id', () => {
        const { id, ...rest } = validEntry;
        const result = validateCustomModelEntry(rest);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/id/);
      });

      it('rejects an entry whose id collides with a built-in', () => {
        const result = validateCustomModelEntry({ ...validEntry, id: 'deepseek-chat' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/conflicts with a built-in/);
      });

      it('rejects invalid enum values (toolCalling)', () => {
        const result = validateCustomModelEntry({ ...validEntry, toolCalling: 'invalid' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/toolCalling/);
      });

      it('rejects editProtocol array with unknown protocol', () => {
        const result = validateCustomModelEntry({ ...validEntry, editProtocol: ['bogus-protocol'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/editProtocol/);
      });

      it('rejects maxOutputTokens below minimum', () => {
        const result = validateCustomModelEntry({ ...validEntry, maxOutputTokens: 10 });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/maxOutputTokens/);
      });

      it('accepts tokenizer omitted (estimation fallback)', () => {
        const { tokenizer, ...rest } = validEntry as typeof validEntry & { tokenizer?: string };
        expect(validateCustomModelEntry(rest)).toEqual({ ok: true });
      });

      it('rejects unknown tokenizer', () => {
        const result = validateCustomModelEntry({ ...validEntry, tokenizer: 'gpt-4' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/tokenizer/);
      });
    });

    describe('registerCustomModels', () => {
      it('registers a valid entry and exposes it via getCapabilities', () => {
        const result = registerCustomModels([validEntry]);
        expect(result.loaded).toBe(1);
        expect(result.errors).toEqual([]);

        const caps = getCapabilities('qwen2.5-coder-local');
        expect(caps.apiEndpoint).toBe('http://localhost:11434/v1');
        expect(caps.apiKey).toBe('ollama');
        expect(caps.toolCalling).toBe('native');
      });

      it('rejects invalid entries but keeps valid ones', () => {
        const invalid = { ...validEntry, id: 'deepseek-chat' }; // collision
        const result = registerCustomModels([validEntry, invalid]);
        expect(result.loaded).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/deepseek-chat/);
        expect(result.errors[0]).toMatch(/conflicts/);
      });

      it('replaces previously registered custom models on reload', () => {
        registerCustomModels([validEntry]);
        expect(getCapabilities('qwen2.5-coder-local').apiEndpoint).toBe('http://localhost:11434/v1');

        // Reload with a different entry — old one should be gone.
        const other = { ...validEntry, id: 'lmstudio-local', apiEndpoint: 'http://localhost:1234/v1' };
        registerCustomModels([other]);

        // Previous entry falls through to the fallback (not found)
        expect(getCapabilities('qwen2.5-coder-local')).toEqual(getCapabilities(DEFAULT_MODEL_ID));
        // New entry is active
        expect(getCapabilities('lmstudio-local').apiEndpoint).toBe('http://localhost:1234/v1');
      });

      it('custom models appear in getRegisteredModelIds after built-ins', () => {
        registerCustomModels([validEntry]);
        const ids = getRegisteredModelIds();
        expect(ids).toContain('deepseek-chat');
        expect(ids).toContain('qwen2.5-coder-local');
        // Built-ins first
        expect(ids.indexOf('deepseek-chat')).toBeLessThan(ids.indexOf('qwen2.5-coder-local'));
      });

      it('getAllRegisteredModels returns display info for built-ins and custom entries', () => {
        registerCustomModels([validEntry]);
        const all = getAllRegisteredModels();
        const qwen = all.find(m => m.id === 'qwen2.5-coder-local');
        const chat = all.find(m => m.id === 'deepseek-chat');
        expect(qwen).toBeDefined();
        expect(qwen?.isCustom).toBe(true);
        expect(qwen?.name).toBe('Qwen 2.5 Coder (Ollama)');
        expect(chat?.isCustom).toBe(false);
        // Display name carries a retirement hint since V3 chat/reasoner
        // are scheduled for removal 2026-07-24 (replaced by V4 variants).
        expect(chat?.name).toContain('DeepSeek Chat (V3');
      });

      it('empty input clears existing custom models', () => {
        registerCustomModels([validEntry]);
        expect(getRegisteredModelIds()).toContain('qwen2.5-coder-local');
        registerCustomModels([]);
        expect(getRegisteredModelIds()).not.toContain('qwen2.5-coder-local');
      });
    });
  });
});
