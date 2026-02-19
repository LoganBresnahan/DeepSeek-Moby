# ASCII Art Editor — Phone Drawing Server Extension

## Concept

Add an ASCII art editor mode to the phone drawing server. Instead of freehand drawing that produces a PNG image, the ASCII editor lets users create diagrams with boxes, arrows, and text labels. The output is plain text — sent directly into the chat as a user message, no image encoding needed. LLMs understand ASCII diagrams natively since they appear everywhere in training data (READMEs, RFCs, code comments, Stack Overflow).

```
Phone Browser (ASCII grid editor + touch tools)
  ↓ HTTP POST { type: 'ascii', text: '...' }
DrawingServer (src/providers/drawingServer.ts)
  ↓ vscode.EventEmitter (plain text)
ChatProvider → webview → injected as code-fenced user message
```

## Decisions

- **No circles** — boxes + arrows + text covers 90% of diagram use cases. Circles look crude in ASCII.
- **Unicode box characters** — `┌─┐└─┘│` look better and LLMs handle them fine.
- **Navigation via action bar button** — no separate tab bar. A small `[ASCII →]` / `[← Draw]` button sits in the existing bottom action bar next to Undo/Clear/Send.
- **Inline code-fenced user message** — ASCII art is sent as a regular user message wrapped in triple backticks. Reuses the existing `sendMessage` pipeline. No new segment types, no file attachments.

## Why ASCII Over Images?

| | Image (current) | ASCII (proposed) |
|---|---|---|
| **LLM input** | Requires vision model | Works with any text model |
| **Token cost** | High (base64 image tokens) | Low (just characters) |
| **Editability** | Opaque bitmap | User/LLM can modify the text |
| **Size** | ~50-500 KB per drawing | ~0.5-2 KB per diagram |
| **LLM can produce** | No | Yes — LLM can draw back |

## Data Model

A 2D character grid. Each cell holds one character.

```typescript
type Grid = string[][];

function createGrid(width: number, height: number): Grid {
  return Array.from({ length: height }, () => Array(width).fill(' '));
}

function gridToString(grid: Grid): string {
  return grid.map(row => row.join('')).join('\n');
}
```

Grid size: ~40x20 characters fits a phone screen in landscape with readable monospace font.

## Tools

### 1. Box Tool
Drag from one corner to the opposite corner. Fills border with box-drawing characters.

```
Input: (2,1) to (12,5)

  ┌──────────┐
  │          │
  │          │
  │          │
  └──────────┘
```

Characters: `┌ ┐ └ ┘ ─ │`

### 2. Arrow Tool
Drag from start to end. Draws an L-shaped path (horizontal first, then vertical) with an arrowhead.

```
Straight horizontal:  ──────────>
Straight vertical:    │
                      │
                      v
L-shaped:             ──────┐
                             │
                             v
```

Characters: `─ │ > < ^ v ┐ ┘ └ ┌`

### 3. Text Tool
Tap a position, type text. Characters placed directly into grid cells.

```
  ┌──────────┐
  │  Server  │
  └──────────┘
```

## Phone UX (Final Implementation)

### Layout — Single Top Toolbar
```
┌──────────────────────────────────────────────────────────────┐
│  [□][↗][A][✋] [▲][△][▽][▼][⊕][✕]  ···spacer···  [↩][↪][✖][✎][▶] │  ← Single toolbar
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    ASCII grid (monospace)                     │  ← Touch area
│                    Dynamic COLS × ROWS                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Tool buttons: Box (□), Arrow (↗), Text (A), Move (✋ hand icon).
Modifier buttons (▲△▽▼⊕✕): visible only when Move is active, disabled until a shape is selected.
Action buttons pushed right via spacer: Undo (↩), Redo (↪), Clear (✖), Draw Mode (✎), Send (▶).

The drawing page has a matching single toolbar:
```
[● ● ● ● ● ● ●] [===slider===]  ···spacer···  [↩][↪][✖][A][▶]
```

### Interaction
- **Select tool** → tap a tool button. Cursor changes per tool: crosshair (box/arrow), text (text), grab (move).
- **Box**: touch down at corner A, drag to corner B, release. Draws Unicode box (`┌─┐└─┘│`).
- **Arrow**: touch down at start, drag to end, release. L-shaped path with arrowhead.
- **Text**: tap position → text input overlay opens. Tap selected text in Move mode → edit existing text.
- **Move**: select shapes, drag to reposition, resize via corner handles (box/arrow). Layer badges show z-order.
- Live preview shows the shape while dragging.
- **Undo/Redo**: shape snapshot stack (max 50 entries). Redo stack cleared on new edits.

### Grid Display
- Fixed 16px Courier New monospace font
- `cellW = ctx.measureText('M').width`, `cellH = fontSize`
- `COLS = floor(containerWidth / cellW)`, `ROWS = floor(containerHeight / cellH)`
- Dynamic sizing — grid fills the available area, re-computes on resize/orientation change
- HiDPI-aware: `cv.width = gridW * dpr`, `cv.style.width = gridW + 'px'`

## Server Integration

### Routes
- `GET /` — ASCII editor (default page)
- `GET /draw` — Color drawing page
- `POST /upload` — Receive content (both formats)
- `GET /health` — Health check

### Upload Format
```json
{ "type": "ascii", "text": "┌────┐\n│ DB │\n└────┘" }
```

The `/upload` endpoint handles both formats:
- `{ image: '...' }` → existing drawing flow (base64 PNG)
- `{ type: 'ascii', text: '...' }` → new ASCII flow (plain text)

### Extension Side — Inline User Message
When the server receives `{ type: 'ascii', text }`:
1. Fire `onAsciiReceived` event with the text
2. ChatProvider subscribes, sends to webview: `{ type: 'asciiDrawingReceived', text }`
3. Webview injects it as a user message via the existing `sendMessage` pipeline, wrapped in a code fence

```
The user sees:
┌────────┐     ┌────────┐
│ Server │────>│  DB    │
└────────┘     └────────┘

The LLM sees the same text in the conversation history.
```

No new segment types, no file I/O — just a text message.

### Navigation Between Pages
Both pages include a navigation button in their toolbar:
- ASCII page: ✎ (pencil) → navigates to `/draw`
- Drawing page: A → navigates to `/`

Single QR code in the extension popup — no popup changes needed.

## Implementation (Complete)

### 1. Server: ASCII editor + upload handling ✅
**File:** `src/providers/drawingServer.ts`
- `ASCII_HTML` constant — full ASCII editor (shape registry, box/arrow/text tools, move/resize, layer ops, undo/redo)
- `DRAWING_HTML` constant — color drawing page (colors, brush size, undo/redo via ImageData)
- `AsciiReceivedEvent` interface + `onAsciiReceived` event emitter
- Route `GET /` → ASCII editor (default), `GET /draw` → color drawing
- `/upload` handler detects `{ type: 'ascii', text }` vs `{ image: '...' }`
- Navigation buttons between pages
- Comprehensive logging and tracing

### 2. Extension: Forward to webview ✅
**File:** `src/providers/chatProvider.ts`
- Subscribes to `drawingServer.onAsciiReceived`
- Posts `{ type: 'asciiDrawingReceived', text }` to webview

### 3. Webview: Handle ASCII message ✅
**File:** `media/actors/message-gateway/VirtualMessageGatewayActor.ts`
- `case 'asciiDrawingReceived'` → code-fenced text → `sendMessage` pipeline

### 4. Tests ✅
**File:** `tests/unit/providers/drawingServer.test.ts` (70 tests)
- ASCII page HTML content (tools, modifiers, shapes, grid, undo/redo, text overlay, cursors, badges)
- Drawing page HTML content (colors, slider, undo/redo, HiDPI, touch/mouse, send, toolbar layout)
- Page serve logging
- ASCII upload + image upload (both formats, rejections, events)
- Server lifecycle (start, stop, dispose, events, errors)
- Network info (LAN IP, WSL2 detection, Windows LAN IP)

## Final Line Count

| Component | Lines | Notes |
|-----------|-------|-------|
| ASCII editor (shapes, tools, rendering) | ~530 | Shape registry, all tools, canvas rendering |
| Color drawing page | ~160 | Canvas, colors, undo/redo, send |
| Server class | ~370 | Lifecycle, routing, upload, WSL2 detection |
| Tests | ~800 | 70 tests, full HTML content + behavior coverage |
| **Total** | **~1860** | All vanilla JS in pages, zero dependencies |

## Dependencies

**None.** All algorithms (box drawing, L-shaped arrow routing, shape registry) implemented from scratch. Both editor pages are inline HTML strings served by the DrawingServer class.
