import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenService } from '../../../src/services/tokenService';

// Mock the WASM module
const mockTokenizer = {
  count_tokens: vi.fn((text: string) => Math.ceil(text.length * 0.3)),
  encode: vi.fn((_text: string, _add: boolean) => new Uint32Array([1, 2, 3])),
  decode: vi.fn((_ids: Uint32Array, _skip: boolean) => 'decoded text'),
  vocab_size: vi.fn(() => 128000),
  free: vi.fn(),
};

const MockDeepSeekTokenizer = vi.fn(() => mockTokenizer);

vi.mock('deepseek-moby-wasm', () => ({
  DeepSeekTokenizer: MockDeepSeekTokenizer,
}));

// Mock fs and zlib for the compressed vocab loading
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => Buffer.from('compressed-data')),
}));

vi.mock('zlib', () => ({
  brotliDecompressSync: vi.fn(() => Buffer.from('{"mock": "tokenizer json"}')),
}));

describe('TokenService', () => {
  beforeEach(() => {
    TokenService.resetInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    TokenService.resetInstance();
  });

  it('should be a singleton', () => {
    const a = TokenService.getInstance('/fake/path');
    const b = TokenService.getInstance();
    expect(a).toBe(b);
  });

  it('should throw if getInstance called without extensionPath on first call', () => {
    expect(() => TokenService.getInstance()).toThrow('requires extensionPath');
  });

  it('should not be ready before initialization', () => {
    const service = TokenService.getInstance('/fake/path');
    expect(service.isReady).toBe(false);
    expect(service.isExact).toBe(true);
  });

  it('should initialize the WASM tokenizer', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    expect(service.isReady).toBe(true);
    expect(MockDeepSeekTokenizer).toHaveBeenCalledOnce();
  });

  it('should deduplicate concurrent initialize calls', async () => {
    const service = TokenService.getInstance('/fake/path');

    // Call initialize() three times concurrently
    await Promise.all([
      service.initialize(),
      service.initialize(),
      service.initialize(),
    ]);

    // Constructor should only be called once
    expect(MockDeepSeekTokenizer).toHaveBeenCalledOnce();
  });

  it('should not re-initialize if already initialized', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();
    await service.initialize();

    expect(MockDeepSeekTokenizer).toHaveBeenCalledOnce();
  });

  it('should count tokens after initialization', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    const count = service.count('Hello world');
    expect(mockTokenizer.count_tokens).toHaveBeenCalledWith('Hello world');
    expect(typeof count).toBe('number');
  });

  it('should throw if count called before initialization', () => {
    const service = TokenService.getInstance('/fake/path');
    expect(() => service.count('test')).toThrow('not initialized');
  });

  it('should count message with overhead', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    mockTokenizer.count_tokens.mockReturnValueOnce(10);
    const userTokens = service.countMessage('user', 'Hello');
    expect(userTokens).toBe(14); // 10 + 4 overhead

    mockTokenizer.count_tokens.mockReturnValueOnce(10);
    const systemTokens = service.countMessage('system', 'Hello');
    expect(systemTokens).toBe(18); // 10 + 8 system overhead
  });

  it('should encode text', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    const ids = service.encode('test');
    expect(mockTokenizer.encode).toHaveBeenCalledWith('test', false);
    expect(ids).toBeInstanceOf(Uint32Array);
  });

  it('should throw if encode called before initialization', () => {
    const service = TokenService.getInstance('/fake/path');
    expect(() => service.encode('test')).toThrow('not initialized');
  });

  it('should decode token IDs', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    const text = service.decode(new Uint32Array([1, 2, 3]));
    expect(mockTokenizer.decode).toHaveBeenCalled();
    expect(text).toBe('decoded text');
  });

  it('should throw if decode called before initialization', () => {
    const service = TokenService.getInstance('/fake/path');
    expect(() => service.decode(new Uint32Array([1]))).toThrow('not initialized');
  });

  it('should get vocab size', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    expect(service.vocabSize).toBe(128000);
  });

  it('should throw if vocabSize accessed before initialization', () => {
    const service = TokenService.getInstance('/fake/path');
    expect(() => service.vocabSize).toThrow('not initialized');
  });

  it('should dispose and release WASM memory', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();
    expect(service.isReady).toBe(true);

    service.dispose();
    expect(mockTokenizer.free).toHaveBeenCalledOnce();
    expect(service.isReady).toBe(false);
  });

  it('should allow retry after failed initialization', async () => {
    const service = TokenService.getInstance('/fake/path');

    // First call fails
    MockDeepSeekTokenizer.mockImplementationOnce(() => {
      throw new Error('WASM load failed');
    });
    await expect(service.initialize()).rejects.toThrow('WASM tokenizer failed to load');

    // Second call succeeds (initPromise was reset)
    MockDeepSeekTokenizer.mockImplementationOnce(() => mockTokenizer);
    await service.initialize();
    expect(service.isReady).toBe(true);
  });

  it('should implement TokenCounter interface', async () => {
    const service = TokenService.getInstance('/fake/path');
    await service.initialize();

    // These are the methods required by TokenCounter
    expect(typeof service.count).toBe('function');
    expect(typeof service.countMessage).toBe('function');
    expect(service.isExact).toBe(true);
  });
});
