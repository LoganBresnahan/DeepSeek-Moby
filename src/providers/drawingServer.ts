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

/** Data emitted when an ASCII diagram is received from the phone */
export interface AsciiReceivedEvent {
  /** The ASCII art text */
  text: string;
  /** Timestamp when the text was received */
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

/** Default port for the drawing server (0 = OS assigns a free port) */
const DEFAULT_PORT = 0;

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
    .tool-bar { display: flex; gap: 4px; padding: 6px 8px; background: #252526; flex-shrink: 0; align-items: center; }
    .tool-bar button { padding: 8px 12px; font-size: 1.1em; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; background: #3c3c3c; color: #ccc; min-width: 36px; text-align: center; }
    .tool-bar button.btn-send { background: #0e639c; color: #fff; }
    .tool-bar button.btn-send:active { background: #1177bb; }
    .tool-bar button.btn-send.sent { background: #16825d; }
    #colors { display: flex; gap: 4px; align-items: center; }
    .color-swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; flex-shrink: 0; }
    .color-swatch.active { border-color: #fff; }
    #strokeSize { width: 80px; flex-shrink: 0; margin-left: 4px; }
    .spacer { flex: 1; }
    canvas { flex: 1; min-height: 0; background: #fff; display: block; cursor: crosshair; }
  </style>
</head>
<body>
  <div class="tool-bar">
    <span id="colors"></span>
    <input type="range" id="strokeSize" min="1" max="20" value="3" title="Brush Size">
    <span class="spacer"></span>
    <button onclick="undo()" title="Undo">&#8617;</button>
    <button onclick="redo()" title="Redo">&#8618;</button>
    <button onclick="clearCanvas()" title="Clear All">&#10006;</button>
    <button onclick="location.href='/'" title="ASCII Mode">A</button>
    <button class="btn-send" id="sendBtn" onclick="send()" title="Send">&#9654;</button>
  </div>
  <canvas id="c"></canvas>
  <script>
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');
    const sendBtn = document.getElementById('sendBtn');
    const strokeInput = document.getElementById('strokeSize');
    let drawing = false;
    let strokeColor = '#000000';
    let undoStack = [];
    let redoStack = [];
    const MAX_UNDO = 15;

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
      undoStack = [];
      redoStack = [];
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function getPos(e) {
      const rect = c.getBoundingClientRect();
      const touch = e.touches ? e.touches[0] : e;
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    }

    function startDraw(e) {
      undoStack.push(ctx.getImageData(0, 0, c.width, c.height));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
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

    function undo() {
      if (undoStack.length === 0) return;
      redoStack.push(ctx.getImageData(0, 0, c.width, c.height));
      ctx.putImageData(undoStack.pop(), 0, 0);
    }
    function redo() {
      if (redoStack.length === 0) return;
      undoStack.push(ctx.getImageData(0, 0, c.width, c.height));
      ctx.putImageData(redoStack.pop(), 0, 0);
    }
    function clearCanvas() {
      undoStack.push(ctx.getImageData(0, 0, c.width, c.height));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
      ctx.clearRect(0, 0, c.width / devicePixelRatio, c.height / devicePixelRatio);
    }

    function send() {
      sendBtn.disabled = true;
      sendBtn.innerHTML = '&#8943;';
      fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: c.toDataURL('image/png') })
      })
      .then(r => r.json())
      .then(() => {
        sendBtn.innerHTML = '&#10003;';
        sendBtn.classList.add('sent');
        setTimeout(() => {
          sendBtn.innerHTML = '&#9654;';
          sendBtn.classList.remove('sent');
          sendBtn.disabled = false;
        }, 1500);
      })
      .catch(() => {
        sendBtn.innerHTML = '!';
        setTimeout(() => {
          sendBtn.innerHTML = '&#9654;';
          sendBtn.disabled = false;
        }, 2000);
      });
    }
  </script>
</body>
</html>`;

/**
 * HTML page for the ASCII art editor.
 * Provides a monospace grid with box, arrow, and text tools.
 * Output is plain text sent via POST to /upload.
 */
const ASCII_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Moby ASCII Editor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1e1e1e; overflow: hidden; touch-action: none; display: flex; flex-direction: column; height: 100vh; height: 100dvh; font-family: -apple-system, system-ui, sans-serif; }
    .tool-bar { display: flex; gap: 4px; padding: 6px 8px; background: #252526; flex-shrink: 0; align-items: center; }
    .tool-bar button { padding: 8px 12px; font-size: 1.1em; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; background: #3c3c3c; color: #ccc; min-width: 36px; text-align: center; }
    .tool-bar button.active { background: #0e639c; color: #fff; }
    .tool-bar button:disabled { opacity: 0.3; cursor: default; }
    .tool-bar button.btn-del { background: #a1260d; color: #fff; }
    .tool-bar button.btn-send { background: #0e639c; color: #fff; }
    .tool-bar button.btn-send:active { background: #1177bb; }
    .tool-bar button.btn-send.sent { background: #16825d; }
    .mod-group { display: none; gap: 4px; margin-left: 4px; }
    .spacer { flex: 1; }
    .grid-wrap { flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #181818; position: relative; }
    #gridCanvas { cursor: crosshair; border: 1px solid #444; background: #1e1e1e; }
    .text-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); z-index: 10; }
    .text-overlay.visible { display: flex; }
    .text-box { background: #2d2d2d; border: 1px solid #555; border-radius: 8px; padding: 16px; width: 80%; max-width: 300px; }
    .text-box input { width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: 16px; background: #1e1e1e; color: #d4d4d4; border: 1px solid #555; border-radius: 4px; }
    .text-box .tactions { display: flex; gap: 8px; margin-top: 8px; }
    .text-box .tactions button { flex: 1; padding: 8px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; }
    .tok { background: #0e639c; color: #fff; }
    .tcancel { background: #3c3c3c; color: #ccc; }
  </style>
</head>
<body>
  <div class="tool-bar">
    <button id="toolBox" class="active" onclick="setTool('box')" title="Box">&#9633;</button>
    <button id="toolArrow" onclick="setTool('arrow')" title="Arrow">&#8599;</button>
    <button id="toolText" onclick="setTool('text')" title="Text">A</button>
    <button id="toolMove" onclick="setTool('move')" title="Move">&#9995;</button>
    <span class="mod-group" id="modGroup">
      <button class="btn-mod" onclick="layerFront()" title="To Front" disabled>&#9650;</button>
      <button class="btn-mod" onclick="layerUp()" title="Up" disabled>&#9651;</button>
      <button class="btn-mod" onclick="layerDown()" title="Down" disabled>&#9661;</button>
      <button class="btn-mod" onclick="layerBack()" title="To Back" disabled>&#9660;</button>
      <button class="btn-mod" onclick="dupShape()" title="Duplicate" disabled>&#8853;</button>
      <button class="btn-mod btn-del" onclick="delShape()" title="Delete" disabled>&#10005;</button>
    </span>
    <span class="spacer"></span>
    <button onclick="undo()" title="Undo">&#8617;</button>
    <button onclick="redo()" title="Redo">&#8618;</button>
    <button onclick="clearGrid()" title="Clear All">&#10006;</button>
    <button onclick="location.href='/draw'" title="Draw Mode">&#9998;</button>
    <button class="btn-send" id="sendBtn" onclick="send()" title="Send">&#9654;</button>
  </div>
  <div class="grid-wrap" id="gridWrap">
    <canvas id="gridCanvas"></canvas>
    <div class="text-overlay" id="textOverlay">
      <div class="text-box">
        <input type="text" id="textInput" placeholder="Type text..." autocomplete="off" />
        <div class="tactions">
          <button class="tcancel" onclick="cancelText()">Cancel</button>
          <button class="tok" onclick="confirmText()">Place</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    // ── State ──
    var COLS, ROWS;
    var shapes = [];
    var nextId = 1;
    var undoStack = [];
    var redoStack = [];
    var curTool = 'box';
    var dragStart = null;
    var textPos = null;
    var selectedId = null;
    var moveOffset = null;
    var resizeHandle = -1;
    var dragUndoPushed = false;
    var editingTextId = null;

    // ── Grid Helpers ──
    function makeGrid(w, h) {
      return Array.from({ length: h }, function() { return Array(w).fill(' '); });
    }
    function gridStr(g) {
      return g.map(function(r) { return r.join(''); }).join('\\n');
    }

    // ── Shape Registry ──
    function rebuildGrid() {
      var g = makeGrid(COLS, ROWS);
      for (var i = 0; i < shapes.length; i++) {
        var s = shapes[i];
        if (s.type === 'box') drawBox(g, s.r1, s.c1, s.r2, s.c2);
        else if (s.type === 'arrow') drawArrow(g, s.r1, s.c1, s.r2, s.c2);
        else if (s.type === 'text') placeText(g, s);
      }
      return g;
    }
    function pushUndo() {
      undoStack.push(JSON.parse(JSON.stringify(shapes)));
      if (undoStack.length > 50) undoStack.shift();
      redoStack = [];
    }

    // ── Drawing Functions ──
    function drawBox(g, r1, c1, r2, c2) {
      var minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
      var minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      if (maxR - minR < 1 || maxC - minC < 1) return;
      g[minR][minC] = '\\u250c'; g[minR][maxC] = '\\u2510';
      g[maxR][minC] = '\\u2514'; g[maxR][maxC] = '\\u2518';
      for (var c = minC + 1; c < maxC; c++) { g[minR][c] = '\\u2500'; g[maxR][c] = '\\u2500'; }
      for (var r = minR + 1; r < maxR; r++) { g[r][minC] = '\\u2502'; g[r][maxC] = '\\u2502'; }
    }
    function drawArrow(g, r1, c1, r2, c2) {
      if (r1 === r2 && c1 === c2) return;
      var dh = c2 > c1 ? 1 : c2 < c1 ? -1 : 0;
      var dv = r2 > r1 ? 1 : r2 < r1 ? -1 : 0;
      if (r1 === r2) {
        for (var c = c1; c !== c2; c += dh) g[r1][c] = '\\u2500';
        g[r2][c2] = dh > 0 ? '>' : '<';
      } else if (c1 === c2) {
        for (var r = r1; r !== r2; r += dv) g[r][c1] = '\\u2502';
        g[r2][c2] = dv > 0 ? 'v' : '^';
      } else {
        for (var c = c1; c !== c2; c += dh) g[r1][c] = '\\u2500';
        if (dh > 0 && dv > 0) g[r1][c2] = '\\u2510';
        else if (dh > 0 && dv < 0) g[r1][c2] = '\\u2518';
        else if (dh < 0 && dv > 0) g[r1][c2] = '\\u250c';
        else g[r1][c2] = '\\u2514';
        for (var r = r1 + dv; r !== r2; r += dv) g[r][c2] = '\\u2502';
        g[r2][c2] = dv > 0 ? 'v' : '^';
      }
    }
    function placeText(g, s) {
      for (var i = 0; i < s.text.length && s.col + i < COLS; i++) {
        if (s.row < ROWS) g[s.row][s.col + i] = s.text[i];
      }
    }

    // ── Canvas ──
    var cv = document.getElementById('gridCanvas');
    var ctx = cv.getContext('2d');
    var wrap = document.getElementById('gridWrap');
    var cellW = 1, cellH = 1, fontSize = 12;
    var FONT = '"Courier New", Courier, monospace';

    function render(g) {
      var data = g || rebuildGrid();
      var dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
      ctx.font = fontSize + 'px ' + FONT;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#d4d4d4';
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var ch = data[r][c];
          if (ch !== ' ') ctx.fillText(ch, c * cellW, r * cellH);
        }
      }
      // Selection highlight + handles
      if (selectedId !== null) {
        var sel = findShape(selectedId);
        if (sel) {
          var b = shapeBounds(sel);
          ctx.strokeStyle = '#0e639c';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(b.minC * cellW, b.minR * cellH,
            (b.maxC - b.minC + 1) * cellW, (b.maxR - b.minR + 1) * cellH);
          ctx.setLineDash([]);
          var handles = getHandlePositions(sel);
          var hs = Math.max(4, Math.min(8, cellW * 0.4));
          ctx.fillStyle = '#fff';
          for (var hi = 0; hi < handles.length; hi++) {
            ctx.fillRect(handles[hi].x - hs / 2, handles[hi].y - hs / 2, hs, hs);
          }
        }
      }
      // Layer number badges (Move mode only, drawn last so they superimpose)
      if (curTool === 'move' && shapes.length > 0) {
        var badgeFont = Math.max(8, Math.round(fontSize * 0.55));
        ctx.font = badgeFont + 'px sans-serif';
        ctx.textBaseline = 'top';
        for (var si = 0; si < shapes.length; si++) {
          var sb = shapeBounds(shapes[si]);
          var label = '' + (si + 1);
          var tw = ctx.measureText(label).width;
          var bx = sb.minC * cellW + 1;
          var by = shapes[si].type === 'text' ? sb.minR * cellH - badgeFont - 2 : sb.minR * cellH + 1;
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.fillRect(bx - 1, by - 1, tw + 5, badgeFont + 3);
          ctx.fillStyle = shapes[si].id === selectedId ? '#4fc3f7' : '#fff';
          ctx.fillText(label, bx + 1, by);
        }
      }
    }

    function sizeGrid() {
      fontSize = 16;
      ctx.font = fontSize + 'px ' + FONT;
      cellW = ctx.measureText('M').width;
      cellH = fontSize;
      COLS = Math.max(10, Math.floor(wrap.clientWidth / cellW));
      ROWS = Math.max(5, Math.floor(wrap.clientHeight / cellH));
      var dpr = window.devicePixelRatio || 1;
      var gridW = cellW * COLS;
      var gridH = cellH * ROWS;
      cv.width = gridW * dpr;
      cv.height = gridH * dpr;
      cv.style.width = gridW + 'px';
      cv.style.height = gridH + 'px';
      render();
    }

    function fixVP() { document.body.style.height = window.innerHeight + 'px'; }
    fixVP();
    window.addEventListener('resize', function() { fixVP(); sizeGrid(); });
    sizeGrid();

    // ── Input Helpers ──
    function toCell(e) {
      var t = e.touches ? e.touches[0] : e;
      var rect = cv.getBoundingClientRect();
      return {
        col: Math.max(0, Math.min(COLS - 1, Math.floor((t.clientX - rect.left) / cellW))),
        row: Math.max(0, Math.min(ROWS - 1, Math.floor((t.clientY - rect.top) / cellH)))
      };
    }
    function toPx(e) {
      var t = e.touches ? e.touches[0] : e;
      var rect = cv.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }

    function setTool(tool) {
      curTool = tool;
      if (tool !== 'move') selectedId = null;
      updateModButtons();
      var cursors = { box: 'crosshair', arrow: 'crosshair', text: 'text', move: 'grab' };
      cv.style.cursor = cursors[tool] || 'crosshair';
      document.querySelectorAll('#toolBox,#toolArrow,#toolText,#toolMove').forEach(function(b) { b.classList.remove('active'); });
      document.getElementById('tool' + tool.charAt(0).toUpperCase() + tool.slice(1)).classList.add('active');
      render();
    }

    // ── Shape Helpers ──
    function findShape(id) {
      for (var i = 0; i < shapes.length; i++) { if (shapes[i].id === id) return shapes[i]; }
      return null;
    }
    function shapeIndex(id) {
      for (var i = 0; i < shapes.length; i++) { if (shapes[i].id === id) return i; }
      return -1;
    }
    function shapeBounds(s) {
      if (s.type === 'text') {
        return { minR: s.row, maxR: s.row, minC: s.col, maxC: s.col + s.text.length - 1 };
      }
      return { minR: Math.min(s.r1, s.r2), maxR: Math.max(s.r1, s.r2),
               minC: Math.min(s.c1, s.c2), maxC: Math.max(s.c1, s.c2) };
    }
    function hitTest(row, col) {
      for (var i = shapes.length - 1; i >= 0; i--) {
        var b = shapeBounds(shapes[i]);
        if (row >= b.minR && row <= b.maxR && col >= b.minC && col <= b.maxC) return shapes[i].id;
      }
      return null;
    }
    function getHandlePositions(s) {
      if (s.type === 'arrow') {
        return [
          { x: s.c1 * cellW + cellW / 2, y: s.r1 * cellH + cellH / 2 },
          { x: s.c2 * cellW + cellW / 2, y: s.r2 * cellH + cellH / 2 }
        ];
      }
      var b = shapeBounds(s);
      if (s.type === 'text') return [];
      return [
        { x: b.minC * cellW, y: b.minR * cellH },
        { x: (b.maxC + 1) * cellW, y: b.minR * cellH },
        { x: b.minC * cellW, y: (b.maxR + 1) * cellH },
        { x: (b.maxC + 1) * cellW, y: (b.maxR + 1) * cellH }
      ];
    }
    function hitTestHandlePx(px, py) {
      if (selectedId === null) return -1;
      var s = findShape(selectedId);
      if (!s) return -1;
      var handles = getHandlePositions(s);
      var thr = Math.max(cellW, cellH) * 0.5;
      for (var i = 0; i < handles.length; i++) {
        var dx = px - handles[i].x, dy = py - handles[i].y;
        if (dx * dx + dy * dy < thr * thr) return i;
      }
      return -1;
    }
    function applyResize(s, idx, row, col) {
      row = Math.max(0, Math.min(ROWS - 1, row));
      col = Math.max(0, Math.min(COLS - 1, col));
      if (s.type === 'arrow') {
        if (idx === 0) { s.r1 = row; s.c1 = col; }
        else { s.r2 = row; s.c2 = col; }
        return;
      }
      var b = shapeBounds(s);
      var fixR, fixC;
      if (idx === 0) { fixR = b.maxR; fixC = b.maxC; }
      else if (idx === 1) { fixR = b.maxR; fixC = b.minC; }
      else if (idx === 2) { fixR = b.minR; fixC = b.maxC; }
      else { fixR = b.minR; fixC = b.minC; }
      if (s.type === 'box') { s.r1 = fixR; s.c1 = fixC; s.r2 = row; s.c2 = col; }
    }
    function clampShape(s) {
      if (s.type === 'box' || s.type === 'arrow') {
        s.r1 = Math.max(0, Math.min(ROWS - 1, s.r1));
        s.c1 = Math.max(0, Math.min(COLS - 1, s.c1));
        s.r2 = Math.max(0, Math.min(ROWS - 1, s.r2));
        s.c2 = Math.max(0, Math.min(COLS - 1, s.c2));
      } else {
        s.row = Math.max(0, Math.min(ROWS - 1, s.row));
        s.col = Math.max(0, Math.min(COLS - s.text.length, s.col));
        if (s.col < 0) s.col = 0;
      }
    }

    // ── Touch Handling ──
    var gw = document.getElementById('gridWrap');
    function onStart(e) {
      var target = e.target || e.srcElement;
      if (target.closest && target.closest('.text-overlay')) return;
      e.preventDefault();
      var cell = toCell(e);

      if (curTool === 'text') {
        textPos = cell;
        editingTextId = null;
        document.getElementById('textOverlay').classList.add('visible');
        var inp = document.getElementById('textInput');
        inp.value = '';
        inp.focus();
        return;
      }

      if (curTool === 'move') {
        // Check resize handles first
        var px = toPx(e);
        var hIdx = hitTestHandlePx(px.x, px.y);
        if (hIdx >= 0) {
          resizeHandle = hIdx;
          dragUndoPushed = false;
          return;
        }
        // Check shape hit
        var hit = hitTest(cell.row, cell.col);
        if (hit !== null) {
          // Tap on already-selected text → edit it
          if (hit === selectedId) {
            var s = findShape(hit);
            if (s && s.type === 'text') {
              editingTextId = s.id;
              textPos = { row: s.row, col: s.col };
              var inp = document.getElementById('textInput');
              inp.value = s.text;
              document.getElementById('textOverlay').classList.add('visible');
              inp.focus();
              return;
            }
          }
          selectedId = hit;
          moveOffset = { row: cell.row, col: cell.col };
          dragUndoPushed = false;
          render();
          updateModButtons();
        } else {
          selectedId = null;
          render();
          updateModButtons();
        }
        return;
      }

      dragStart = cell;
    }
    function onMove(e) {
      e.preventDefault();
      if (curTool === 'move') {
        // Resize
        if (resizeHandle >= 0 && selectedId !== null) {
          if (!dragUndoPushed) { pushUndo(); dragUndoPushed = true; }
          var cell = toCell(e);
          var s = findShape(selectedId);
          if (s) { applyResize(s, resizeHandle, cell.row, cell.col); render(); }
          return;
        }
        // Move
        if (selectedId !== null && moveOffset) {
          var cell = toCell(e);
          var dr = cell.row - moveOffset.row, dc = cell.col - moveOffset.col;
          if (dr === 0 && dc === 0) return;
          if (!dragUndoPushed) { pushUndo(); dragUndoPushed = true; }
          var s = findShape(selectedId);
          if (!s) return;
          if (s.type === 'box' || s.type === 'arrow') {
            s.r1 += dr; s.r2 += dr; s.c1 += dc; s.c2 += dc;
          } else {
            s.row += dr; s.col += dc;
          }
          clampShape(s);
          moveOffset = { row: cell.row, col: cell.col };
          render();
        }
        return;
      }
      if (!dragStart) return;
      var cell = toCell(e);
      var pv = rebuildGrid();
      if (curTool === 'box') drawBox(pv, dragStart.row, dragStart.col, cell.row, cell.col);
      else if (curTool === 'arrow') drawArrow(pv, dragStart.row, dragStart.col, cell.row, cell.col);
      render(pv);
    }
    function onEnd(e) {
      if (curTool === 'move') {
        resizeHandle = -1;
        moveOffset = null;
        return;
      }
      if (!dragStart) return;
      var t = e.changedTouches ? e.changedTouches[0] : e;
      var rect = cv.getBoundingClientRect();
      var col = Math.max(0, Math.min(COLS - 1, Math.floor((t.clientX - rect.left) / cellW)));
      var row = Math.max(0, Math.min(ROWS - 1, Math.floor((t.clientY - rect.top) / cellH)));
      pushUndo();
      if (curTool === 'box') {
        if (Math.abs(row - dragStart.row) >= 1 && Math.abs(col - dragStart.col) >= 1) {
          shapes.push({ id: nextId++, type: 'box', r1: dragStart.row, c1: dragStart.col, r2: row, c2: col });
        }
      } else if (curTool === 'arrow') {
        if (row !== dragStart.row || col !== dragStart.col) {
          shapes.push({ id: nextId++, type: 'arrow', r1: dragStart.row, c1: dragStart.col, r2: row, c2: col });
        }
      }
      dragStart = null;
      render();
    }

    gw.addEventListener('touchstart', onStart);
    gw.addEventListener('touchmove', onMove);
    gw.addEventListener('touchend', onEnd);
    gw.addEventListener('mousedown', onStart);
    gw.addEventListener('mousemove', onMove);
    gw.addEventListener('mouseup', onEnd);

    // ── Text Tool ──
    function confirmText() {
      var text = document.getElementById('textInput').value;
      if (!text) { cancelText(); return; }
      pushUndo();
      if (editingTextId !== null) {
        var s = findShape(editingTextId);
        if (s) s.text = text;
      } else if (textPos) {
        shapes.push({ id: nextId++, type: 'text', row: textPos.row, col: textPos.col, text: text });
      }
      cancelText();
      render();
    }
    function cancelText() {
      textPos = null;
      editingTextId = null;
      document.getElementById('textOverlay').classList.remove('visible');
    }
    document.getElementById('textInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') confirmText();
      if (e.key === 'Escape') cancelText();
    });

    // ── Layer Operations ──
    function layerFront() {
      if (selectedId === null) return;
      var idx = shapeIndex(selectedId);
      if (idx === -1 || idx === shapes.length - 1) return;
      pushUndo(); shapes.push(shapes.splice(idx, 1)[0]); render();
    }
    function layerBack() {
      if (selectedId === null) return;
      var idx = shapeIndex(selectedId);
      if (idx <= 0) return;
      pushUndo(); shapes.unshift(shapes.splice(idx, 1)[0]); render();
    }
    function layerUp() {
      if (selectedId === null) return;
      var idx = shapeIndex(selectedId);
      if (idx === -1 || idx === shapes.length - 1) return;
      pushUndo();
      var tmp = shapes[idx]; shapes[idx] = shapes[idx + 1]; shapes[idx + 1] = tmp;
      render();
    }
    function layerDown() {
      if (selectedId === null) return;
      var idx = shapeIndex(selectedId);
      if (idx <= 0) return;
      pushUndo();
      var tmp = shapes[idx]; shapes[idx] = shapes[idx - 1]; shapes[idx - 1] = tmp;
      render();
    }
    function dupShape() {
      if (selectedId === null) return;
      var s = findShape(selectedId);
      if (!s) return;
      pushUndo();
      var d = JSON.parse(JSON.stringify(s));
      d.id = nextId++;
      if (d.type === 'box' || d.type === 'arrow') { d.r1 += 2; d.r2 += 2; d.c1 += 2; d.c2 += 2; }
      else { d.row += 2; d.col += 2; }
      clampShape(d);
      shapes.push(d);
      selectedId = d.id;
      render();
      updateModButtons();
    }
    function delShape() {
      if (selectedId === null) return;
      var idx = shapeIndex(selectedId);
      if (idx === -1) return;
      pushUndo();
      shapes.splice(idx, 1);
      selectedId = null;
      updateModButtons();
      render();
    }
    function updateModButtons() {
      var mg = document.getElementById('modGroup');
      mg.style.display = curTool === 'move' ? 'flex' : 'none';
      var btns = mg.querySelectorAll('button');
      var enabled = selectedId !== null && curTool === 'move';
      for (var i = 0; i < btns.length; i++) btns[i].disabled = !enabled;
    }

    // ── Actions ──
    function undo() {
      if (undoStack.length === 0) return;
      redoStack.push(JSON.parse(JSON.stringify(shapes)));
      shapes = undoStack.pop();
      selectedId = null;
      updateModButtons();
      render();
    }
    function redo() {
      if (redoStack.length === 0) return;
      undoStack.push(JSON.parse(JSON.stringify(shapes)));
      shapes = redoStack.pop();
      selectedId = null;
      updateModButtons();
      render();
    }
    function clearGrid() {
      pushUndo();
      shapes = [];
      selectedId = null;
      nextId = 1;
      updateModButtons();
      render();
    }

    var sendBtn = document.getElementById('sendBtn');
    function send() {
      var g = rebuildGrid();
      var text = gridStr(g).replace(/[\\t ]+$/gm, '').replace(/\\n+$/, '');
      if (!text.trim()) return;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ascii', text: text })
      })
      .then(function(r) { return r.json(); })
      .then(function() {
        sendBtn.textContent = 'Sent!';
        sendBtn.classList.add('sent');
        setTimeout(function() { sendBtn.textContent = 'Send'; sendBtn.classList.remove('sent'); sendBtn.disabled = false; }, 1500);
      })
      .catch(function() {
        sendBtn.textContent = 'Failed';
        setTimeout(function() { sendBtn.textContent = 'Send'; sendBtn.disabled = false; }, 2000);
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
  private readonly _onAsciiReceived = new vscode.EventEmitter<AsciiReceivedEvent>();
  private readonly _onServerStarted = new vscode.EventEmitter<{ port: number; url: string }>();
  private readonly _onServerStopped = new vscode.EventEmitter<void>();

  readonly onImageReceived = this._onImageReceived.event;
  readonly onAsciiReceived = this._onAsciiReceived.event;
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

    const spanId = tracer.startSpan('state.publish', 'drawingServer.start', {
      executionMode: 'async',
      data: { requestedPort: this._port }
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
        // Read the actual port assigned by the OS (important when _port is 0)
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }

        const networkInfo = DrawingServer.getNetworkInfo(this._port);
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
          data: { localUrl, port: this._port, lanIP: lanIP || 'none', isWSL: networkInfo.isWSL }
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
   * Default route (/) serves the ASCII editor. /draw serves the color drawing page.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      this.serveAsciiPage(res);
      return;
    }

    if (req.method === 'GET' && req.url === '/draw') {
      this.serveDrawingPage(res);
      return;
    }

    if (req.method === 'POST' && req.url === '/upload') {
      this.handleUpload(req, res);
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
   * Serve the ASCII art editor page (default).
   */
  private serveAsciiPage(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ASCII_HTML);
    logger.debug('[DrawingServer] Served ASCII editor page');
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
   * Handle an upload from the phone.
   * Supports two formats:
   * - Image: { image: "data:image/png;base64,..." }
   * - ASCII: { type: "ascii", text: "..." }
   */
  private handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
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

        // ASCII diagram upload
        if (parsed.type === 'ascii' && typeof parsed.text === 'string') {
          if (!parsed.text.trim()) {
            logger.warn('[DrawingServer] Upload rejected: empty ASCII text');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Empty ASCII text' }));
            return;
          }

          const sizeB = Buffer.byteLength(parsed.text, 'utf-8');
          logger.info('[DrawingServer] ASCII diagram received', `${sizeB} bytes`);
          tracer.trace('state.publish', 'drawingServer.asciiReceived', {
            data: { sizeB }
          });

          this._onAsciiReceived.fire({
            text: parsed.text,
            timestamp: Date.now()
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // Image upload (existing flow)
        const imageDataUrl = parsed.image;
        if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
          logger.warn('[DrawingServer] Upload rejected: invalid upload data');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid upload data' }));
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
    this._onAsciiReceived.dispose();
    this._onServerStarted.dispose();
    this._onServerStopped.dispose();
    logger.debug('[DrawingServer] Disposed');
  }
}
