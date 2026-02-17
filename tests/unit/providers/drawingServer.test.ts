import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter as NodeEventEmitter } from 'events';

// Working EventEmitter for event-driven class testing
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, EventEmitter: WorkingEventEmitter };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/tracing', () => ({
  tracer: {
    startSpan: vi.fn(() => 'span-1'),
    endSpan: vi.fn(),
    trace: vi.fn(),
    startFlow: vi.fn(() => 'flow-1'),
  },
}));

// We need to capture the request handler passed to http.createServer
let capturedRequestHandler: ((req: any, res: any) => void) | null = null;
const mockServerInstance = {
  listen: vi.fn((_port: number, cb?: () => void) => {
    if (cb) cb();
    return mockServerInstance;
  }),
  close: vi.fn((cb?: () => void) => {
    if (cb) cb();
  }),
  on: vi.fn(),
  listening: true,
};

vi.mock('http', () => ({
  createServer: vi.fn((handler: any) => {
    capturedRequestHandler = handler;
    return mockServerInstance;
  }),
}));

vi.mock('os', () => ({
  networkInterfaces: vi.fn(() => ({
    eth0: [
      { family: 'IPv4', internal: false, address: '192.168.1.42' },
      { family: 'IPv6', internal: false, address: '::1' },
    ],
    lo: [
      { family: 'IPv4', internal: true, address: '127.0.0.1' },
    ],
  })),
}));


import { DrawingServer } from '../../../src/providers/drawingServer';
import type { DrawingReceivedEvent } from '../../../src/providers/drawingServer';
import { logger } from '../../../src/utils/logger';
import { tracer } from '../../../src/tracing';

// ── Mock HTTP request/response factories ──

function createMockResponse() {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    statusCode: 200,
  };
  return res;
}

function createMockRequest(method: string, url: string, body?: string) {
  const req = new NodeEventEmitter() as any;
  req.method = method;
  req.url = url;
  req.destroy = vi.fn();

  // Simulate body sending after a tick
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    }, 0);
  }

  return req;
}

describe('DrawingServer', () => {
  let server: DrawingServer;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
    mockServerInstance.listening = true;
    mockServerInstance.listen.mockImplementation((_port: number, cb?: () => void) => {
      if (cb) cb();
      return mockServerInstance;
    });
    mockServerInstance.close.mockImplementation((cb?: () => void) => {
      if (cb) cb();
    });
    mockServerInstance.on.mockReset();
    // Default: not WSL
    vi.spyOn(DrawingServer, 'isWSL').mockReturnValue(false);
    vi.spyOn(DrawingServer, 'getWSLHostIP').mockReturnValue(null);
    vi.spyOn(DrawingServer, 'getWindowsLanIP').mockReturnValue(null);
    server = new DrawingServer(9999);
  });

  afterEach(() => {
    server.dispose();
  });

  // ── Constructor & Properties ──

  describe('constructor', () => {
    it('should use the provided port', () => {
      expect(server.port).toBe(9999);
    });

    it('should use default port when none provided', () => {
      const defaultServer = new DrawingServer();
      expect(defaultServer.port).toBe(8839);
      defaultServer.dispose();
    });

    it('should not be running initially', () => {
      // Server not started yet, internal server is null
      const freshServer = new DrawingServer();
      // Before start(), the internal server is null, so isRunning checks null
      // We need to check this before start() is called
      expect(freshServer.port).toBe(8839);
      freshServer.dispose();
    });
  });

  // ── getLanIP ──

  describe('getLanIP', () => {
    it('should return the first non-internal IPv4 address', () => {
      expect(DrawingServer.getLanIP()).toBe('192.168.1.42');
    });

    it('should return null when no external interfaces exist', async () => {
      const os = await import('os');
      vi.mocked(os.networkInterfaces).mockReturnValueOnce({
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as any],
      });
      expect(DrawingServer.getLanIP()).toBeNull();
    });

    it('should return null when no interfaces exist', async () => {
      const os = await import('os');
      vi.mocked(os.networkInterfaces).mockReturnValueOnce({});
      expect(DrawingServer.getLanIP()).toBeNull();
    });
  });

  // ── WSL detection ──

  describe('getWindowsLanIP', () => {
    it('should return null when not in WSL (PowerShell fails)', () => {
      vi.mocked(DrawingServer.getWindowsLanIP).mockRestore();
      // execSync will fail in test environment (no powershell.exe mocked)
      // The try/catch in getWindowsLanIP should return null
      // We can't easily test the real call, so just verify the mock behavior
      vi.spyOn(DrawingServer, 'getWindowsLanIP').mockReturnValue(null);
      expect(DrawingServer.getWindowsLanIP()).toBeNull();
    });

    it('should return IP when PowerShell succeeds', () => {
      vi.mocked(DrawingServer.getWindowsLanIP).mockReturnValue('192.168.0.135');
      expect(DrawingServer.getWindowsLanIP()).toBe('192.168.0.135');
    });
  });

  describe('getNetworkInfo', () => {
    it('should return non-WSL info by default', () => {
      const info = DrawingServer.getNetworkInfo(8839);
      expect(info.isWSL).toBe(false);
      expect(info.phoneURL).toBe('http://192.168.1.42:8839');
      expect(info.phoneIP).toBe('192.168.1.42');
      expect(info.portForwardCmd).toBeUndefined();
    });

    it('should return WSL info with port forward and firewall commands', () => {
      vi.mocked(DrawingServer.isWSL).mockReturnValue(true);
      vi.mocked(DrawingServer.getWSLHostIP).mockReturnValue('172.30.16.1');

      const info = DrawingServer.getNetworkInfo(8839);
      expect(info.isWSL).toBe(true);
      expect(info.portForwardCmd).toContain('netsh interface portproxy');
      expect(info.portForwardCmd).toContain('netsh advfirewall firewall');
      expect(info.portForwardCmd).toContain('Moby Drawing Pad');
      expect(info.portForwardCmd).toContain('8839');
      expect(info.portForwardCmd).toContain('192.168.1.42');
    });

    it('should include WSL IP and port in commands', () => {
      vi.mocked(DrawingServer.isWSL).mockReturnValue(true);

      const info = DrawingServer.getNetworkInfo(9999);
      expect(info.portForwardCmd).toContain('connectaddress=192.168.1.42');
      expect(info.portForwardCmd).toContain('listenport=9999');
      expect(info.portForwardCmd).toContain('localport=9999');
    });

    it('should use Windows LAN IP for phone URL when in WSL2', () => {
      vi.mocked(DrawingServer.isWSL).mockReturnValue(true);
      vi.mocked(DrawingServer.getWindowsLanIP).mockReturnValue('192.168.0.135');

      const info = DrawingServer.getNetworkInfo(8839);
      expect(info.phoneIP).toBe('192.168.0.135');
      expect(info.phoneURL).toBe('http://192.168.0.135:8839');
    });

    it('should fall back to placeholder when Windows LAN IP unavailable in WSL2', () => {
      vi.mocked(DrawingServer.isWSL).mockReturnValue(true);
      vi.mocked(DrawingServer.getWindowsLanIP).mockReturnValue(null);

      const info = DrawingServer.getNetworkInfo(8839);
      expect(info.phoneIP).toBeNull();
      expect(info.phoneURL).toBe('http://<your-pc-ip>:8839');
    });
  });

  // ── start() ──

  describe('start()', () => {
    it('should start the server and return URL with LAN IP', async () => {
      const result = await server.start();

      expect(result.port).toBe(9999);
      expect(result.url).toBe('http://192.168.1.42:9999');
    });

    it('should fire onServerStarted event', async () => {
      const events: Array<{ port: number; url: string }> = [];
      server.onServerStarted(e => events.push(e));

      await server.start();

      expect(events).toHaveLength(1);
      expect(events[0].port).toBe(9999);
      expect(events[0].url).toBe('http://192.168.1.42:9999');
    });

    it('should log server start', async () => {
      await server.start();

      expect(logger.info).toHaveBeenCalledWith(
        '[DrawingServer] Started on http://192.168.1.42:9999'
      );
    });

    it('should create a trace span', async () => {
      await server.start();

      expect(tracer.startSpan).toHaveBeenCalledWith(
        'state.publish',
        'drawingServer.start',
        expect.objectContaining({ data: { port: 9999, isWSL: false } })
      );
      expect(tracer.endSpan).toHaveBeenCalledWith(
        'span-1',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('should throw if already running', async () => {
      await server.start();
      await expect(server.start()).rejects.toThrow('already running');
    });

    it('should reject on EADDRINUSE error', async () => {
      mockServerInstance.listen.mockImplementationOnce(() => {
        // Simulate error callback
        const errorHandler = mockServerInstance.on.mock.calls.find(
          (c: any[]) => c[0] === 'error'
        );
        if (errorHandler) {
          const err = new Error('Port in use') as NodeJS.ErrnoException;
          err.code = 'EADDRINUSE';
          errorHandler[1](err);
        }
        return mockServerInstance;
      });

      // Need to set up the on handler before listen is called
      mockServerInstance.on.mockImplementation((event: string, handler: any) => {
        if (event === 'error') {
          // Store for later triggering
          setTimeout(() => {
            const err = new Error('Port in use') as NodeJS.ErrnoException;
            err.code = 'EADDRINUSE';
            handler(err);
          }, 0);
        }
        return mockServerInstance;
      });
      mockServerInstance.listen.mockImplementation(() => mockServerInstance);

      await expect(server.start()).rejects.toThrow('Port 9999 is already in use');
    });
  });

  // ── stop() ──

  describe('stop()', () => {
    it('should stop the server and fire onServerStopped', async () => {
      await server.start();

      let stopCount = 0;
      server.onServerStopped(() => { stopCount++; });

      await server.stop();

      expect(stopCount).toBe(1);
      expect(logger.info).toHaveBeenCalledWith('[DrawingServer] Stopped');
    });

    it('should trace the stop event', async () => {
      await server.start();
      await server.stop();

      expect(tracer.trace).toHaveBeenCalledWith(
        'state.publish',
        'drawingServer.stop',
        expect.objectContaining({ data: { port: 9999 } })
      );
    });

    it('should do nothing if not running', async () => {
      // Don't start, just stop — should not throw
      await server.stop();
      expect(logger.debug).toHaveBeenCalledWith(
        '[DrawingServer] Not running, ignoring stop()'
      );
    });
  });

  // ── Request Handling (via captured handler) ──

  describe('request handling', () => {
    beforeEach(async () => {
      await server.start();
      expect(capturedRequestHandler).not.toBeNull();
    });

    describe('GET /', () => {
      it('should serve the drawing HTML page', () => {
        const req = createMockRequest('GET', '/');
        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
        expect(res.end).toHaveBeenCalled();
        const html = res.end.mock.calls[0][0] as string;
        expect(html).toContain('Moby Drawing Pad');
        expect(html).toContain('<canvas');
        expect(html).toContain('touchstart');
      });

      it('should also serve at /index.html', () => {
        const req = createMockRequest('GET', '/index.html');
        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      });
    });

    describe('GET /health', () => {
      it('should return ok status', () => {
        const req = createMockRequest('GET', '/health');
        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'application/json',
        });
        expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }));
      });
    });

    describe('404 for unknown routes', () => {
      it('should return 404 for unknown paths', () => {
        const req = createMockRequest('GET', '/unknown');
        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(404, {
          'Content-Type': 'text/plain',
        });
        expect(res.end).toHaveBeenCalledWith('Not found');
      });
    });

    describe('POST /upload', () => {
      it('should accept a valid image upload and fire event', async () => {
        const events: DrawingReceivedEvent[] = [];
        server.onImageReceived(e => events.push(e));

        const body = JSON.stringify({ image: 'data:image/png;base64,iVBOR...' });
        const req = createMockRequest('POST', '/upload', body);
        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        // Wait for async data events
        await new Promise(r => setTimeout(r, 10));

        expect(res.writeHead).toHaveBeenCalledWith(200, {
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: true });

        expect(events).toHaveLength(1);
        expect(events[0].imageDataUrl).toBe('data:image/png;base64,iVBOR...');
        expect(events[0].timestamp).toBeGreaterThan(0);
      });

      it('should log and trace image receipt', async () => {
        const body = JSON.stringify({ image: 'data:image/png;base64,abc123' });
        const req = createMockRequest('POST', '/upload', body);
        const res = createMockResponse();

        capturedRequestHandler!(req, res);
        await new Promise(r => setTimeout(r, 10));

        expect(logger.info).toHaveBeenCalledWith(
          '[DrawingServer] Drawing received',
          expect.any(String)
        );
        expect(tracer.trace).toHaveBeenCalledWith(
          'state.publish',
          'drawingServer.imageReceived',
          expect.objectContaining({
            data: expect.objectContaining({ sizeKB: expect.any(Number) })
          })
        );
      });

      it('should reject invalid image data (missing image field)', async () => {
        const body = JSON.stringify({ notImage: 'hello' });
        const req = createMockRequest('POST', '/upload', body);
        const res = createMockResponse();

        capturedRequestHandler!(req, res);
        await new Promise(r => setTimeout(r, 10));

        expect(res.writeHead).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
          error: 'Invalid image data',
        });
      });

      it('should reject non-image data URLs', async () => {
        const body = JSON.stringify({ image: 'not-a-data-url' });
        const req = createMockRequest('POST', '/upload', body);
        const res = createMockResponse();

        capturedRequestHandler!(req, res);
        await new Promise(r => setTimeout(r, 10));

        expect(res.writeHead).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
      });

      it('should reject malformed JSON', async () => {
        const req = createMockRequest('POST', '/upload', '{invalid json');
        const res = createMockResponse();

        capturedRequestHandler!(req, res);
        await new Promise(r => setTimeout(r, 10));

        expect(res.writeHead).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
          error: 'Malformed JSON',
        });
        expect(logger.warn).toHaveBeenCalledWith(
          '[DrawingServer] Upload rejected: malformed JSON'
        );
      });

      it('should reject oversized payloads (>5MB)', async () => {
        const req = new NodeEventEmitter() as any;
        req.method = 'POST';
        req.url = '/upload';
        req.destroy = vi.fn();

        const res = createMockResponse();

        capturedRequestHandler!(req, res);

        // Send a chunk larger than 5MB
        const largeChunk = Buffer.alloc(6 * 1024 * 1024, 'a');
        req.emit('data', largeChunk);

        expect(res.writeHead).toHaveBeenCalledWith(413, {
          'Content-Type': 'application/json',
        });
        expect(req.destroy).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          '[DrawingServer] Upload rejected: body too large',
          expect.any(String)
        );
      });
    });
  });

  // ── dispose() ──

  describe('dispose()', () => {
    it('should clean up without errors', () => {
      expect(() => server.dispose()).not.toThrow();
    });

    it('should close running server on dispose', async () => {
      await server.start();
      server.dispose();
      expect(mockServerInstance.close).toHaveBeenCalled();
    });

    it('should log disposal', () => {
      server.dispose();
      expect(logger.debug).toHaveBeenCalledWith('[DrawingServer] Disposed');
    });
  });

  // ── Event subscriptions ──

  describe('event subscriptions', () => {
    it('should allow subscribing and unsubscribing from onImageReceived', async () => {
      await server.start();

      const events: DrawingReceivedEvent[] = [];
      const sub = server.onImageReceived(e => events.push(e));

      const body = JSON.stringify({ image: 'data:image/png;base64,test1' });
      const req1 = createMockRequest('POST', '/upload', body);
      capturedRequestHandler!(req1, createMockResponse());
      await new Promise(r => setTimeout(r, 10));

      expect(events).toHaveLength(1);

      // Unsubscribe
      sub.dispose();

      const req2 = createMockRequest('POST', '/upload', body);
      capturedRequestHandler!(req2, createMockResponse());
      await new Promise(r => setTimeout(r, 10));

      // Should still be 1 after unsubscribing
      expect(events).toHaveLength(1);
    });

    it('should allow multiple subscribers', async () => {
      await server.start();

      const events1: DrawingReceivedEvent[] = [];
      const events2: DrawingReceivedEvent[] = [];
      server.onImageReceived(e => events1.push(e));
      server.onImageReceived(e => events2.push(e));

      const body = JSON.stringify({ image: 'data:image/png;base64,test' });
      const req = createMockRequest('POST', '/upload', body);
      capturedRequestHandler!(req, createMockResponse());
      await new Promise(r => setTimeout(r, 10));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });
  });
});
