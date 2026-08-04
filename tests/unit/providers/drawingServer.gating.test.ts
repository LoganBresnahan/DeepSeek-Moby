/**
 * Freeform draw-mode gating on the drawing server (2026-08-04).
 *
 * The old compile-time IMAGE_MODE_ENABLED=false became an injected predicate
 * consulted PER REQUEST, so the phone pages track live config: the Draw Mode
 * button, the /draw route, /health's imageMode field, and — the backstop for
 * stale pages — the /upload image gate.
 *
 * Real http.Server on an ephemeral port; the predicate is a mutable flag the
 * tests flip between requests without restarting the server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DrawingServer } from '../../../src/providers/drawingServer';
import * as http from 'http';

function request(
  port: number,
  path: string,
  opts: { method?: string; body?: string } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json' } },
      res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('DrawingServer image-mode gating', () => {
  let server: DrawingServer;
  let port: number;
  let imageMode = false;

  beforeAll(async () => {
    server = new DrawingServer(0, { isImageModeAvailable: () => imageMode });
    const result = await server.start();
    port = result.port;
  });

  afterAll(async () => {
    await server.stop();
    server.dispose();
  });

  it('/health reports imageMode and tracks the live predicate', async () => {
    imageMode = false;
    let res = await request(port, '/health');
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', imageMode: false });

    imageMode = true;
    res = await request(port, '/health');
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', imageMode: true });
  });

  it('/draw serves the canvas page when available, redirects home when not', async () => {
    imageMode = true;
    let res = await request(port, '/draw');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Moby Drawing Pad');

    imageMode = false;
    res = await request(port, '/draw');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('ASCII page includes the Draw Mode button only while available (per request, not per start)', async () => {
    imageMode = true;
    let res = await request(port, '/');
    expect(res.body).toContain('title="Draw Mode"');
    expect(res.body).not.toContain('DRAW_MODE_BUTTON'); // marker never leaks

    imageMode = false;
    res = await request(port, '/');
    expect(res.body).not.toContain('title="Draw Mode"');
    expect(res.body).not.toContain('DRAW_MODE_BUTTON');
  });

  it('/upload refuses an image with a NAMED reason when unavailable (stale-page backstop)', async () => {
    imageMode = false;
    const res = await request(port, '/upload', {
      method: 'POST',
      body: JSON.stringify({ image: 'data:image/png;base64,abc' })
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/vision model/i);
  });

  it('/upload accepts an image and fires onImageReceived when available', async () => {
    imageMode = true;
    const received: string[] = [];
    server.onImageReceived(e => received.push(e.imageDataUrl));

    const res = await request(port, '/upload', {
      method: 'POST',
      body: JSON.stringify({ image: 'data:image/png;base64,abc' })
    });
    expect(res.status).toBe(200);
    expect(received).toEqual(['data:image/png;base64,abc']);
  });

  it('ASCII uploads are NOT gated — the ASCII editor works without a vision model', async () => {
    imageMode = false;
    const received: string[] = [];
    server.onAsciiReceived(e => received.push(e.text));

    const res = await request(port, '/upload', {
      method: 'POST',
      body: JSON.stringify({ type: 'ascii', text: '+--box--+' })
    });
    expect(res.status).toBe(200);
    expect(received).toEqual(['+--box--+']);
  });
});
