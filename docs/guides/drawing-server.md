# Drawing Server Guide

The drawing server lets you use your phone as a wireless drawing/diagramming pad. The extension runs a lightweight HTTP server, your phone opens the URL in its browser, and you create drawings or ASCII diagrams on a touch-friendly interface. Tap "Send" to transmit the result inline into the chat stream.

The server provides two modes:
- **ASCII Editor** (`/`) — Create boxes, arrows, and text labels. Output is plain text that LLMs understand natively.
- **Color Drawing** (`/draw`) — Freehand drawing with colors and brush sizes. Output is a PNG image.

## Quick Start

1. Click the **pencil button** in the chat header bar (left of the model selector)
2. Click **Start Server** in the popup
3. Scan the **QR code** with your phone (or copy the URL)
4. The **ASCII Editor** opens by default — draw diagrams, tap **Send**
5. Switch to **Color Drawing** mode via the pencil (✎) button, or vice versa via the "A" button
6. Sent content appears inline in the chat stream

The header button turns green when the server is running. Click it again to open the popup and stop the server.

You can also use the Command Palette:
- **DeepSeek Moby: Start Drawing Server** — starts the server
- **DeepSeek Moby: Stop Drawing Server** — stops the server

## WSL2 Setup

WSL2 uses a virtual NAT network that your phone can't reach directly. You need to forward the port from the Windows host to the WSL2 VM.

### One-Time Setup

When you start the drawing server in WSL2, it detects this automatically and offers to copy the setup commands. You can also run them manually:

**Open an admin PowerShell on Windows** and run:

```powershell
# Port forwarding: route Windows port <PORT> to WSL2
netsh interface portproxy add v4tov4 listenport=<PORT> listenaddress=0.0.0.0 connectport=<PORT> connectaddress=<WSL2_IP>

# Firewall: allow incoming connections on the port
netsh advfirewall firewall add rule name="Moby Drawing Pad" dir=in action=allow protocol=TCP localport=<PORT>
```

Replace `<PORT>` with the port shown in the drawing server popup (it's assigned dynamically on each start). Replace `<WSL2_IP>` with your WSL2 IP address. To find it, run in WSL2:
```bash
hostname -I | awk '{print $1}'
```

Then open `http://<your-windows-ip>:<PORT>` on your phone. Your Windows IP is typically found via `ipconfig` in a Windows terminal (look for the WiFi adapter's IPv4 address).

> **Tip:** The extension copies the exact netsh commands with the correct port and IP when you click "Copy Setup Commands" in the WSL2 start dialog. You don't need to fill in the placeholders manually.

### WSL2 IP Changes on Reboot

WSL2's internal IP changes every time Windows or WSL restarts. When that happens, the port forwarding breaks. To fix it:

```powershell
# Remove the old rule
netsh interface portproxy delete v4tov4 listenport=<PORT> listenaddress=0.0.0.0

# Add with the new WSL2 IP
netsh interface portproxy add v4tov4 listenport=<PORT> listenaddress=0.0.0.0 connectport=<PORT> connectaddress=<NEW_WSL2_IP>
```

Or just restart the drawing server in the extension — it will give you the updated command with the current IP.

### Alternative: WSL2 Mirrored Networking

On Windows 11 22H2+, you can enable mirrored networking mode which shares the host's network interface with WSL2, eliminating the need for port forwarding entirely.

Create or edit `%USERPROFILE%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then restart WSL (`wsl --shutdown` in PowerShell, then reopen your terminal). With mirrored networking, the drawing server URL works directly from your phone — no port forwarding needed.

### Cleanup

To remove the port forwarding and firewall rules:

```powershell
netsh interface portproxy delete v4tov4 listenport=<PORT> listenaddress=0.0.0.0
netsh advfirewall firewall delete rule name="Moby Drawing Pad"
```

### Verifying Port Forwarding

To check if port forwarding is active:

```powershell
netsh interface portproxy show v4tov4
```

To check if the firewall rule exists:

```powershell
netsh advfirewall firewall show rule name="Moby Drawing Pad"
```

## ASCII Editor (`/`)

The default mode. Creates diagrams with boxes, arrows, and text labels. Output is plain text — LLMs understand ASCII diagrams natively since they appear everywhere in training data.

### Toolbar

All controls are in a single top row:

```
[□] [↗] [A] [✋]  [▲][△][▽][▼][⊕][✕]  ··spacer··  [↩][↪][✖][✎][▶]
 ↑   ↑   ↑   ↑    └─ modifier buttons ─┘              ↑  ↑  ↑  ↑  ↑
Box Arrow Text Move  (move mode only)               Undo Redo Clear Draw Send
```

### Tools

| Tool | Icon | Cursor | Description |
|------|------|--------|-------------|
| **Box** | □ | crosshair | Drag from corner to corner. Draws Unicode box (`┌─┐└─┘│`) |
| **Arrow** | ↗ | crosshair | Drag from start to end. L-shaped path with arrowhead (`─│>v^<`) |
| **Text** | A | text | Tap to place. Opens text input overlay. Tap to edit existing text. |
| **Move** | ✋ | grab | Select shapes, drag to reposition. Resize via corner handles (box/arrow only). |

### Modifier Buttons (Move Mode)

When Move is active, modifier buttons appear to the right of the tool buttons. They are disabled until a shape is selected.

| Button | Icon | Description |
|--------|------|-------------|
| To Front | ▲ | Move selected shape to top of layer stack |
| Up | △ | Move selected shape up one layer |
| Down | ▽ | Move selected shape down one layer |
| To Back | ▼ | Move selected shape to bottom of layer stack |
| Duplicate | ⊕ | Clone selected shape (offset by 2 cells) |
| Delete | ✕ | Remove selected shape (red button) |

Layer badges (numbered 1, 2, 3...) appear on each shape in Move mode to indicate z-order. Text badges are positioned above the text to avoid overlapping the first character.

### Action Buttons

| Button | Icon | Description |
|--------|------|-------------|
| Undo | ↩ | Restore previous shape state (max 50 history entries) |
| Redo | ↪ | Redo undone action |
| Clear | ✖ | Clear all shapes (undoable) |
| Draw Mode | ✎ | Switch to color drawing page |
| Send | ▶ | Send the ASCII diagram as text to the chat |

### Grid Sizing

The monospace grid dynamically fills the available screen area. Font size is fixed at 16px. Columns and rows are calculated from the container dimensions and character metrics (`ctx.measureText('M').width`). The grid resizes automatically when the phone orientation changes.

### Upload Format

ASCII diagrams are sent as `{ type: 'ascii', text: '...' }` via POST to `/upload`. Empty/whitespace-only text is rejected.

---

## Color Drawing (`/draw`)

Freehand touch drawing with colors and stroke sizes. Output is a PNG image.

### Toolbar

Single top row:

```
[● ● ● ● ● ● ●] [===slider===]  ··spacer··  [↩][↪][✖][A][▶]
 └─ 7 colors ─┘   brush size                Undo Redo Clear ASCII Send
```

### Controls

| Control | Description |
|---------|-------------|
| **Color swatches** | 7 colors: black, red, blue, green, orange, purple, white. Active swatch has white border. |
| **Stroke size slider** | Range 1-20px. Affects brush width. |
| **Undo** (↩) | Restore previous canvas state via ImageData snapshot (max 15 entries) |
| **Redo** (↪) | Redo undone stroke |
| **Clear** (✖) | Wipe the canvas (undoable) |
| **ASCII Mode** (A) | Switch to ASCII editor |
| **Send** (▶) | Transmit the drawing as a PNG to the extension. Shows progress: ▶ → ⋯ → ✓ (or !) |

### Canvas

Full-screen touch area below the toolbar. Supports both touch and mouse input (for desktop testing). HiDPI-aware via `devicePixelRatio` scaling. Undo/redo stacks are cleared on resize (snapshots become invalid after canvas dimensions change).

### Upload Format

Drawings are sent as `{ image: 'data:image/png;base64,...' }` via POST to `/upload`. Non-data-URL values are rejected.

---

## Inline Display

Received content appears inline in the chat stream:

- **Drawings** (PNG images) appear as `<img>` elements. White background for visibility in dark themes.
- **ASCII diagrams** appear as code-fenced text in user messages. LLMs see the same text in conversation history.

**Right-click** on any inline drawing to access "Save Drawing As..." which opens a native file save dialog to export the image as PNG.

## Header Popup

The drawing server popup is triggered by the pencil button in the header bar. It shows two states:

- **Stopped**: A "Start Server" button with a brief description
- **Running**: A QR code encoding the server URL, the URL with a copy button, and a "Stop Server" button

The QR code is generated on the extension side using the vendored [nayuki QR Code generator](https://github.com/nayuki/QR-Code-generator) (MIT license, zero dependencies) and transmitted to the webview as a boolean matrix.

On WSL2, the popup automatically detects and displays the real Windows LAN IP (via `powershell.exe`) instead of the WSL2 internal IP, so the QR code works directly from your phone.

## Technical Details

- **Server**: Built-in Node.js `http` module (zero dependencies)
- **Port**: OS-assigned (dynamic — a free port is chosen automatically on each start)
- **Protocol**: HTTP (no HTTPS needed on LAN — WiFi encryption handles security)
- **Routes**: `GET /` (ASCII editor), `GET /draw` (color drawing), `POST /upload` (receive content), `GET /health` (health check)
- **Upload formats**: Image (`{ image: 'data:image/png;base64,...' }`) or ASCII (`{ type: 'ascii', text: '...' }`)
- **Max upload size**: 5 MB
- **QR code**: Vendored nayuki qrcodegen (`src/vendor/qrcodegen.ts`), MIT license
- **Storage**: Ephemeral — content is not saved to disk or database
- **Devices**: Single phone at a time
- **WSL2 IP detection**: Shells out to `powershell.exe` to find the DHCP-assigned IPv4 address
- **ASCII grid**: Dynamic sizing, 16px monospace font, Unicode box-drawing characters
- **Drawing canvas**: HiDPI-aware (`devicePixelRatio`), PNG via `canvas.toDataURL()`

## Architecture

### Drawing Flow (PNG)
```
Phone Browser (/draw — color canvas + touch events)
  ↓ HTTP POST { image: 'data:image/png;base64,...' }
DrawingServer (src/providers/drawingServer.ts)
  ↓ vscode.EventEmitter<DrawingReceivedEvent>
ChatProvider (src/providers/chatProvider.ts)
  ↓ webview.postMessage({ type: 'drawingReceived', imageDataUrl, timestamp })
VirtualMessageGatewayActor → VirtualListActor → MessageTurnActor
  → Renders <img> in shadow DOM container
```

### ASCII Flow (text)
```
Phone Browser (/ — ASCII grid editor + shape tools)
  ↓ HTTP POST { type: 'ascii', text: '┌──┐\n│Hi│\n└──┘' }
DrawingServer (src/providers/drawingServer.ts)
  ↓ vscode.EventEmitter<AsciiReceivedEvent>
ChatProvider (src/providers/chatProvider.ts)
  ↓ webview.postMessage({ type: 'asciiDrawingReceived', text })
VirtualMessageGatewayActor
  → Injected as code-fenced user message via sendMessage pipeline
```

### Key Files
- `src/providers/drawingServer.ts` — HTTP server, both HTML pages (inline strings), WSL2 detection, upload handling, events
- `src/vendor/qrcodegen.ts` — Vendored QR encoder (nayuki, MIT)
- `media/actors/drawing-server/DrawingServerShadowActor.ts` — Header popup UI
- `media/actors/virtual-list/types.ts` — `DrawingSegmentData` type
- `media/actors/turn/MessageTurnActor.ts` — `createDrawingSegment()` render method
- `tests/unit/providers/drawingServer.test.ts` — 70 tests covering server, routes, uploads, HTML content

### Logging & Tracing
- **Start/Stop**: `logger.info` + `tracer.startSpan`/`tracer.endSpan` (start), `tracer.trace` (stop)
- **Page serves**: `logger.debug` for each page request
- **Image received**: `logger.info` (size in KB) + `tracer.trace` (`drawingServer.imageReceived`)
- **ASCII received**: `logger.info` (size in bytes) + `tracer.trace` (`drawingServer.asciiReceived`)
- **Rejections**: `logger.warn` for invalid data, empty text, malformed JSON, oversized payloads
- **Errors**: `logger.error` for server errors and upload stream errors
- All trace events use the `state.publish` category for consistency with the extension's tracing system

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Phone can't reach the URL | Check WiFi (same network?), check firewall, check port forwarding (WSL2) |
| "Port is already in use" | Only possible if a specific port was passed to the constructor. Default behavior uses a free OS-assigned port. |
| Drawing doesn't send | Check phone browser console for errors. Ensure the server is still running |
| QR code shows WSL2 internal IP | PowerShell IP detection failed. Check that `powershell.exe` is in PATH |
| WSL2 port forwarding stopped working | WSL2 IP changed after reboot. Re-run the setup commands |
| Drawing appears but is dark/invisible | Should have white background. Check CSS in `media/actors/turn/styles/index.ts` |
| ASCII grid too small/large | Grid sizes dynamically based on screen dimensions. Try rotating phone. |
| Shapes not visible in ASCII | Check that box dimensions are at least 2x2 cells. Single-cell shapes are skipped. |
