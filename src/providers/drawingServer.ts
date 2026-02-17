import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';

/** Data emitted when a drawing is received from the phone */
export interface DrawingReceivedEvent {
  /** Base64-encoded PNG data URL (data:image/png;base64,...) */
  imageDataUrl: string;
  /** Timestamp when the image was received */
  timestamp: number;
}

/** Result from starting the drawing server */
export interface StartResult {
  port: number;
  url: string;
  /** The IP the phone should connect to (real LAN IP, even on WSL2) */
  phoneIP: string | null;
  /** Whether the server is running inside WSL2 (needs port forwarding) */
  isWSL: boolean;
  /** netsh commands for port forwarding + firewall rule (WSL2 only) */
  portForwardCmd?: string;
}

/** Maximum allowed POST body size (5 MB) */
const MAX_BODY_SIZE = 5 * 1024 * 1024;

/** Default port for the drawing server */
const DEFAULT_PORT = 8839;

/**
 * HTML page served to the phone browser.
 * Provides a full-screen canvas with touch drawing and a send button.
 */
const DRAWING_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Moby Drawing Pad</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; overflow: hidden; touch-action: none; display: flex; flex-direction: column; height: 100vh; height: 100dvh; font-family: -apple-system, system-ui, sans-serif; }
    canvas { flex: 1; background: #fff; display: block; cursor: crosshair; }
    .toolbar { display: flex; gap: 8px; padding: 6px 8px; background: #252526; flex-shrink: 0; }
    .toolbar button { flex: 1; padding: 12px; font-size: 1.1em; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .btn-clear { background: #3c3c3c; color: #ccc; }
    .btn-send { background: #0e639c; color: #fff; }
    .btn-send:active { background: #1177bb; }
    .btn-send.sent { background: #16825d; }
    .color-row { display: flex; gap: 4px; padding: 6px 8px; background: #252526; flex-shrink: 0; }
    .color-swatch { width: 32px; height: 32px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
    .color-swatch.active { border-color: #fff; }
    .stroke-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; background: #252526; flex-shrink: 0; }
    .stroke-row label { color: #ccc; font-size: 0.85em; }
    .stroke-row input { flex: 1; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="color-row" id="colors"></div>
  <div class="stroke-row">
    <label>Size</label>
    <input type="range" id="strokeSize" min="1" max="20" value="3">
  </div>
  <div class="toolbar">
    <button class="btn-clear" onclick="clearCanvas()">Clear</button>
    <button class="btn-send" id="sendBtn" onclick="send()">Send</button>
  </div>
  <script>
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const sendBtn = document.getElementById('sendBtn');
    const strokeInput = document.getElementById('strokeSize');
    let drawing = false;
    let strokeColor = '#000000';

    const COLORS = ['#000000','#ff0000','#0066ff','#00aa00','#ff8800','#8800cc','#ffffff'];
    const colorsEl = document.getElementById('colors');
    COLORS.forEach((color, i) => {
      const el = document.createElement('div');
      el.className = 'color-swatch' + (i === 0 ? ' active' : '');
      el.style.background = color;
      if (color === '#ffffff') el.style.border = '2px solid #666';
      el.onclick = () => {
        strokeColor = color;
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        el.classList.add('active');
      };
      colorsEl.appendChild(el);
    });

    // Fix mobile viewport: 100vh includes browser chrome, innerHeight doesn't
    function fixViewport() {
      document.body.style.height = window.innerHeight + 'px';
    }
    fixViewport();
    window.addEventListener('resize', fixViewport);

    function resizeCanvas() {
      const rect = c.getBoundingClientRect();
      c.width = rect.width * devicePixelRatio;
      c.height = rect.height * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function getPos(e) {
      const rect = c.getBoundingClientRect();
      const touch = e.touches ? e.touches[0] : e;
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }

    function startDraw(e) {
      drawing = true;
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = parseInt(strokeInput.value);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      e.preventDefault();
    }
    function moveDraw(e) {
      if (!drawing) return;
      const pos = getPos(e);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      e.preventDefault();
    }
    function endDraw() { drawing = false; }

    c.addEventListener('touchstart', startDraw);
    c.addEventListener('touchmove', moveDraw);
    c.addEventListener('touchend', endDraw);
    c.addEventListener('mousedown', startDraw);
    c.addEventListener('mousemove', moveDraw);
    c.addEventListener('mouseup', endDraw);
    c.addEventListener('mouseleave', endDraw);

    function clearCanvas() {
      ctx.clearRect(0, 0, c.width / devicePixelRatio, c.height / devicePixelRatio);
    }

    function send() {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: c.toDataURL('image/png') })
      })
      .then(r => r.json())
      .then(() => {
        sendBtn.textContent = 'Sent!';
        sendBtn.classList.add('sent');
        setTimeout(() => {
          sendBtn.textContent = 'Send';
          sendBtn.classList.remove('sent');
          sendBtn.disabled = false;
        }, 1500);
      })
      .catch(() => {
        sendBtn.textContent = 'Failed';
        setTimeout(() => {
          sendBtn.textContent = 'Send';
          sendBtn.disabled = false;
        }, 2000);
      });
    }
  </script>
</body>
</html>`;

/**
 * DrawingServer — Lightweight HTTP server for receiving drawings from a phone.
 *
 * Serves a touch-friendly HTML canvas page and receives PNG images via POST.
 * Uses only the built-in Node.js `http` module (zero dependencies).
 *
 * Lifecycle: start on-demand via command, stop on command or extension deactivation.
 */
export class DrawingServer {
  private server: http.Server | null = null;
  private _port: number;

  // ── Events ──
  private readonly _onImageReceived = new vscode.EventEmitter<DrawingReceivedEvent>();
  private readonly _onServerStarted = new vscode.EventEmitter<{ port: number; url: string }>();
  private readonly _onServerStopped = new vscode.EventEmitter<void>();

  readonly onImageReceived = this._onImageReceived.event;
  readonly onServerStarted = this._onServerStarted.event;
  readonly onServerStopped = this._onServerStopped.event;

  constructor(port: number = DEFAULT_PORT) {
    this._port = port;
  }

  /** Whether the server is currently listening */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** The port the server is listening on (or configured for) */
  get port(): number {
    return this._port;
  }

  /**
   * Get the first non-internal IPv4 address on the LAN.
   * Returns null if no suitable interface is found (e.g., no WiFi).
   */
  static getLanIP(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]!) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return null;
  }

  /** Detect if running inside WSL2 */
  static isWSL(): boolean {
    try {
      const version = fs.readFileSync('/proc/version', 'utf-8');
      return /microsoft|wsl/i.test(version);
    } catch {
      return false;
    }
  }

  /**
   * Get the Windows host IP from inside WSL2.
   * Reads the nameserver from /etc/resolv.conf which points to the Windows host.
   */
  static getWSLHostIP(): string | null {
    try {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Get the Windows host's real LAN IP from inside WSL2.
   * Shells out to powershell.exe to query DHCP-assigned IPv4 addresses,
   * filtering out Loopback and vEthernet (WSL/Hyper-V) adapters.
   * Returns null if the query fails or no suitable address is found.
   */
  static getWindowsLanIP(): string | null {
    try {
      // Single quotes around the PowerShell command prevent bash from
      // interpreting $_ as a shell variable. PowerShell strings inside
      // use double quotes instead.
      const result = execSync(
        "powershell.exe -NoProfile -Command " +
        "'(Get-NetIPAddress -AddressFamily IPv4 | " +
        'Where-Object { $_.InterfaceAlias -notmatch "Loopback|vEthernet" -and $_.PrefixOrigin -eq "Dhcp" }).IPAddress' +
        "'",
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      // May return multiple lines if multiple adapters; take the first
      const firstIP = result.split('\n')[0]?.trim();
      return firstIP || null;
    } catch {
      logger.debug('[DrawingServer] Failed to get Windows LAN IP via PowerShell');
      return null;
    }
  }

  /**
   * Get network info for display purposes.
   * In WSL2, returns the Windows host IP and a port-forwarding command.
   * On native systems, returns the LAN IP directly.
   */
  static getNetworkInfo(port: number): {
    /** The IP to bind/listen on (always the local machine) */
    listenIP: string | null;
    /** The IP the phone should connect to */
    phoneIP: string | null;
    /** Full URL for the phone */
    phoneURL: string;
    /** Whether WSL2 port forwarding is needed */
    isWSL: boolean;
    /** netsh commands to set up port forwarding + firewall rule (WSL2 only) */
    portForwardCmd?: string;
  } {
    const lanIP = DrawingServer.getLanIP();
    const wsl = DrawingServer.isWSL();

    if (wsl) {
      const wslIP = lanIP;  // The WSL2 internal IP (172.x.x.x)
      const windowsIP = DrawingServer.getWindowsLanIP();
      // The phone needs to reach the Windows host, not the WSL2 VM
      const connectAddr = wslIP || '$(wsl hostname -I | awk \'{print $1}\')';
      const phoneHost = windowsIP || '<your-pc-ip>';
      return {
        listenIP: wslIP,
        phoneIP: windowsIP,
        phoneURL: `http://${phoneHost}:${port}`,
        isWSL: true,
        portForwardCmd:
          `netsh interface portproxy add v4tov4 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=${connectAddr}; ` +
          `netsh advfirewall firewall add rule name="Moby Drawing Pad" dir=in action=allow protocol=TCP localport=${port}`,
      };
    }

    const host = lanIP || 'localhost';
    return {
      listenIP: lanIP,
      phoneIP: lanIP,
      phoneURL: `http://${host}:${port}`,
      isWSL: false,
    };
  }

  /**
   * Start the HTTP server.
   * Serves the drawing page at GET / and accepts image uploads at POST /upload.
   */
  async start(): Promise<StartResult> {
    if (this.isRunning) {
      logger.debug('[DrawingServer] Already running, ignoring start()');
      throw new Error('Drawing server is already running');
    }

    const networkInfo = DrawingServer.getNetworkInfo(this._port);
    const spanId = tracer.startSpan('state.publish', 'drawingServer.start', {
      executionMode: 'async',
      data: { port: this._port, isWSL: networkInfo.isWSL }
    });

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        tracer.endSpan(spanId, { status: 'failed', error: err.message });

        if (err.code === 'EADDRINUSE') {
          logger.warn(`[DrawingServer] Port ${this._port} in use`);
          reject(new Error(`Port ${this._port} is already in use. Try a different port.`));
        } else {
          logger.error('[DrawingServer] Server error', err.message);
          reject(err);
        }
        this.server = null;
      });

      this.server.listen(this._port, () => {
        const lanIP = DrawingServer.getLanIP();
        const host = lanIP || 'localhost';
        const localUrl = `http://${host}:${this._port}`;

        if (networkInfo.isWSL) {
          logger.info(`[DrawingServer] Started on ${localUrl} (WSL2 — port forwarding required)`);
        } else {
          logger.info(`[DrawingServer] Started on ${localUrl}`);
        }

        tracer.endSpan(spanId, {
          status: 'completed',
          data: { localUrl, lanIP: lanIP || 'none', isWSL: networkInfo.isWSL }
        });

        this._onServerStarted.fire({ port: this._port, url: localUrl });
        resolve({
          port: this._port,
          url: localUrl,
          phoneIP: networkInfo.phoneIP,
          isWSL: networkInfo.isWSL,
          portForwardCmd: networkInfo.portForwardCmd,
        });
      });
    });
  }

  /**
   * Stop the HTTP server gracefully.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      logger.debug('[DrawingServer] Not running, ignoring stop()');
      return;
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info('[DrawingServer] Stopped');
        tracer.trace('state.publish', 'drawingServer.stop', {
          data: { port: this._port }
        });
        this.server = null;
        this._onServerStopped.fire();
        resolve();
      });
    });
  }

  /**
   * Route incoming HTTP requests.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      this.serveDrawingPage(res);
      return;
    }

    if (req.method === 'POST' && req.url === '/upload') {
      this.handleImageUpload(req, res);
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  /**
   * Serve the HTML drawing page.
   */
  private serveDrawingPage(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DRAWING_HTML);
    logger.debug('[DrawingServer] Served drawing page');
  }

  /**
   * Handle an image upload from the phone.
   * Expects JSON body: { image: "data:image/png;base64,..." }
   */
  private handleImageUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        logger.warn('[DrawingServer] Upload rejected: body too large', `${bodySize} bytes`);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const imageDataUrl = parsed.image;

        if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
          logger.warn('[DrawingServer] Upload rejected: invalid image data');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid image data' }));
          return;
        }

        const sizeKB = Math.round(body.length / 1024);
        logger.info('[DrawingServer] Drawing received', `${sizeKB} KB`);
        tracer.trace('state.publish', 'drawingServer.imageReceived', {
          data: { sizeKB }
        });

        this._onImageReceived.fire({
          imageDataUrl,
          timestamp: Date.now()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        logger.warn('[DrawingServer] Upload rejected: malformed JSON');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON' }));
      }
    });

    req.on('error', (err) => {
      logger.error('[DrawingServer] Upload error', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    });
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this._onImageReceived.dispose();
    this._onServerStarted.dispose();
    this._onServerStopped.dispose();
    logger.debug('[DrawingServer] Disposed');
  }
}
