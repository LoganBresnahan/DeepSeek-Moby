# Phone Drawing Pad — Technical Research

## Concept

Use a phone's touchscreen as a drawing input for the extension. The extension starts a lightweight HTTP server, the phone opens the URL in its browser, the user draws on an HTML5 canvas, and sends the image back to the extension where it appears **inline in the chat stream**.

```
Phone Browser (HTML5 canvas + touch events)
  ↓ HTTP POST (base64 image data)
VS Code Extension (Node.js http server)
  ↓ postMessage
Webview (displays drawing inline in chat)
```

---

## Key Decision: Do You Even Need WebSocket?

**For sending a completed drawing: NO.** HTTP POST is sufficient.

| Use Case | Protocol | Complexity |
|----------|----------|------------|
| Draw on phone, tap "Send", image appears in extension | HTTP POST | ~50 lines server code |
| Real-time stroke streaming (see drawing live on PC) | WebSocket | ~200-300 lines + frame parsing |
| Collaborative editing (both sides draw) | WebSocket | ~400+ lines |

**Recommendation:** Start with HTTP POST. It covers the core use case. WebSocket can be added later if real-time preview becomes important.

---

## Node.js Built-in `http` Module (Zero Dependencies)

The `http` module is all you need. No Express, no Fastify. A complete server that serves an HTML drawing page and receives image uploads is roughly **50-80 lines**.

### Minimal Server Skeleton

```typescript
import * as http from 'http';
import * as os from 'os';

const DRAWING_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; touch-action: none; }
    canvas { width: 100vw; height: 80vh; display: block; background: white; }
    button { width: 100%; height: 20vh; font-size: 2em; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <button onclick="send()">Send Drawing</button>
  <script>
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    c.width = c.offsetWidth; c.height = c.offsetHeight;
    let drawing = false;

    c.addEventListener('touchstart', e => {
      drawing = true;
      const t = e.touches[0];
      ctx.beginPath();
      ctx.moveTo(t.clientX, t.clientY);
      e.preventDefault();
    });
    c.addEventListener('touchmove', e => {
      if (!drawing) return;
      const t = e.touches[0];
      ctx.lineTo(t.clientX, t.clientY);
      ctx.stroke();
      e.preventDefault();
    });
    c.addEventListener('touchend', () => drawing = false);

    function send() {
      fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: c.toDataURL('image/png') })
      }).then(() => {
        ctx.clearRect(0, 0, c.width, c.height);
        document.querySelector('button').textContent = 'Sent!';
        setTimeout(() => document.querySelector('button').textContent = 'Send Drawing', 1500);
      });
    }
  </script>
</body>
</html>`;

function createDrawingServer(onImage: (base64: string) => void): http.Server {
  return http.createServer((req, res) => {
    // Serve the drawing page
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DRAWING_HTML);
      return;
    }

    // Receive the image
    if (req.method === 'POST' && req.url === '/upload') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { image } = JSON.parse(body);
          onImage(image); // base64 PNG data URL
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch {
          res.writeHead(400);
          res.end('Bad request');
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}
```

### What About CORS?

Since the phone browser navigates directly to `http://192.168.x.x:PORT`, the drawing page is served **from the same origin** as the POST endpoint. **No CORS headers needed.** CORS only matters for cross-origin requests (e.g., if the phone page was hosted somewhere else).

---

## WebSocket From Scratch (If Needed Later)

If real-time stroke streaming becomes a goal, here's what a from-scratch WebSocket server involves:

**Handshake** (~20 lines): Upgrade HTTP connection using SHA-1 hash of `Sec-WebSocket-Key` + magic GUID.

**Frame parsing** (~100 lines): Read opcode, payload length (7-bit, 16-bit, or 64-bit), unmask client frames (XOR with 4-byte mask), handle text/binary/close/ping/pong opcodes.

**Total complexity:** ~200-300 lines for a working implementation. The main pitfalls are:
- Fragmented messages (large payloads split across frames)
- Proper close handshake
- Ping/pong keepalive
- Buffer boundary edge cases

**Alternative:** The `ws` package is ~4KB gzipped, battle-tested, and handles all edge cases. If WebSocket is needed, using `ws` is pragmatic and still lightweight.

**Node.js v22+ note:** Node.js now has a built-in WebSocket **client** API (via Undici), but still no built-in WebSocket **server**. So the server side always needs either a library or custom code.

---

## HTTPS: Not Needed for LAN

For same-WiFi communication between phone and PC:

- **WPA2/WPA3 already encrypts** the WiFi traffic at the network layer
- **No domain name** means you can't get a real TLS certificate anyway
- Self-signed certs would work but cause browser warnings on the phone
- **Plain HTTP on LAN is fine** for drawing data (not credentials or financial data)

If the user is on a public/untrusted network, they shouldn't be using this feature anyway.

---

## Discovery: How the Phone Finds the Server

### Option A: Just Show the URL (Start Here)

Display `http://192.168.1.42:PORT` in the extension UI. User types it on their phone. Zero dependencies, zero complexity. Works fine when you're the only user.

**Getting the LAN IP:**
```typescript
import * as os from 'os';

function getLanIP(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address; // e.g., "192.168.1.42"
      }
    }
  }
  return null;
}
```

### Option B: QR Code (Later)

Extension generates a QR code containing `http://192.168.x.x:PORT`, displays it in the webview. User scans with phone camera. Simple, explicit, works everywhere.

**Implementation:** QR code can be generated with pure TypeScript (~200 lines for a basic encoder) or the `qrcode` npm package.

### Option C: mDNS / Bonjour (Probably Overkill)

Advertise a `_drawing._tcp` service on the LAN. Phone discovers it automatically. Requires `multicast-dns` or `mdns-js` package. More "magic" but adds dependency and complexity. Probably overkill for a single-user dev tool.

---

## Extension Integration Pattern

Following the existing manager pattern in the codebase:

```
src/providers/
  drawingServer.ts      # HTTP server lifecycle + image handling

media/actors/drawing/
  DrawingPadShadowActor.ts  # Display received drawings inline in chat
```

**Lifecycle** (follows existing patterns in `src/extension.ts`):
```typescript
// In activate():
const drawingServer = new DrawingServer();
context.subscriptions.push({ dispose: () => drawingServer.stop() });

// Server starts on-demand via command, not at activation
// "Moby: Start Drawing Server" command
```

**Server -> Webview flow:**
1. Phone POSTs image to DrawingServer
2. DrawingServer fires `vscode.EventEmitter<string>` with base64 data
3. ChatProvider subscribes, forwards to webview via `postMessage`
4. Webview displays image inline in chat stream (like an image attachment)

---

## Existing Codebase Connections

| Reference | Location | Relevance |
|-----------|----------|-----------|
| Item M5 | REMINDER.md line 202 | "Phone as wireless drawing pad" — exploratory item |
| Item 27 | REMINDER.md line 189 | "Drawing/diagram attachment" — "Paint station" modal |
| Schematic Visualization | PLAN/schematic-visualization.md | Visual communication research, canvas libraries, gesture input |
| HTTP Client | src/utils/httpClient.ts | Lightweight fetch wrapper — similar patterns |
| Extension lifecycle | src/extension.ts | activate/deactivate + subscriptions disposal pattern |

**Currently missing from codebase:** HTTP server, WebSocket, QR code, canvas/drawing code.

---

## Complexity Assessment

| Component | Lines of Code | Dependencies | Difficulty |
|-----------|--------------|--------------|------------|
| HTTP server (serve HTML + receive POST) | ~60 | None (built-in `http`) | Easy |
| Drawing HTML/JS page (canvas + touch) | ~50 | None (vanilla JS) | Easy |
| LAN IP detection | ~10 | None (built-in `os`) | Trivial |
| Extension integration (lifecycle, events) | ~80 | None | Easy |
| QR code generation | ~20 (with pkg) or ~200 (from scratch) | Optional `qrcode` | Easy/Medium |
| WebSocket server (if real-time wanted) | ~250 | None or `ws` (~4KB) | Medium |
| Drawing display in chat (actor) | ~150 | None | Medium |

**MVP total: ~200 lines of new code, zero new dependencies.**

---

## Suggested Phasing

### Phase 1: Proof of Concept — COMPLETE
- [x] `DrawingServer` class with built-in `http` module (`src/providers/drawingServer.ts`)
- [x] Inline HTML string with touch canvas, color picker, stroke size
- [x] Commands: `deepseek.startDrawingServer` / `deepseek.stopDrawingServer`
- [x] Shows URL in notification with "Copy URL" action
- [x] VS Code notification on image receipt
- [x] Logging (`[DrawingServer]` tag) and tracing (`state.publish` category)
- [x] 5 MB payload size limit
- [x] Health check endpoint (`/health`)
- [x] 30 unit tests (`tests/unit/providers/drawingServer.test.ts`)

### Phase 2: Chat Integration + ASCII Editor — COMPLETE
- [x] Header popup button with start/stop server + QR code display
- [x] QR code generation via vendored nayuki qrcodegen (zero dependencies)
- [x] WSL2 real IP detection via `powershell.exe` for correct phone URL
- [x] Drawings displayed inline in the chat stream as `<img>` elements
- [x] Right-click "Save Drawing As..." context menu on inline images
- [x] White background on drawings for visibility in dark themes
- [x] `DrawingServerShadowActor` popup (extends `PopupShadowActor`)
- [x] Full message pipeline: DrawingServer → ChatProvider → Gateway → VirtualList → MessageTurnActor
- [x] ASCII art editor at `/` with box, arrow, text, and move tools
- [x] Shape registry: undo/redo (50 entries), layer operations, duplicate, delete, resize handles
- [x] Single top toolbar layout with icon-only buttons, modifier buttons visible in Move mode
- [x] Tool-specific cursors (crosshair, text, grab) and hand icon for Move
- [x] Dynamic grid sizing (16px font, fills container)
- [x] Color drawing page redesigned: single top toolbar, undo/redo via ImageData (15 entries)
- [x] Navigation between modes: ✎ (ASCII→Draw) and A (Draw→ASCII)
- [x] 70 tests in drawingServer.test.ts (server + HTML content coverage)

### Phase 3: Real-Time (Optional, Future)
- WebSocket for live stroke streaming
- Preview canvas in extension showing strokes as they happen
- Connects with Paint Station (Item 27) and schematic visualization concepts

---

## Design Decisions

- **Drawings are ephemeral** — not stored in the database or on disk. They exist only in memory for the current session.
- **Single device** — one phone at a time. No multi-device support needed.
- **Port** — default 8839, any open port works.
- **Two modes** — ASCII editor (default, outputs plain text) and color drawing (outputs PNG).
- **ASCII editor** — shape registry with undo/redo, box/arrow/text tools, move/resize, layer operations.
- **Drawing tools** — freehand with 7-color picker, adjustable stroke size, undo/redo via ImageData snapshots.
- **Image format** — PNG via `canvas.toDataURL('image/png')`.
- **Size limits** — 5 MB max POST body (`MAX_BODY_SIZE`).
- **No text resizing** — text shapes are single-line, move and edit only.
- **No circles** — boxes + arrows + text covers 90% of diagram use cases.

---

## Sources

- [Node.js HTTP server without framework (MDN)](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/Node_server_without_framework)
- [Implementing WebSocket from scratch (Erick Wendel)](https://blog.erickwendel.com.br/implementing-the-websocket-protocol-from-scratch-using-nodejs)
- [Node.js WebSocket guide](https://nodejs.org/en/learn/getting-started/websocket)
- [RFC 6455 — The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [Build a minimal HTTP server with Node](https://tannerdolby.com/writing/build-a-minimal-http-server-with-node/)
- [Node.js static file server (30 Seconds of Code)](https://www.30secondsofcode.org/js/s/nodejs-static-file-server/)
