# Drawing Server Guide

The drawing server lets you use your phone as a wireless drawing pad. The extension runs a lightweight HTTP server, your phone opens the URL in its browser, and you draw on a touch canvas. Tap "Send" to transmit the drawing inline into the chat stream.

## Quick Start

1. Click the **pencil button** in the chat header bar (left of the model selector)
2. Click **Start Server** in the popup
3. Scan the **QR code** with your phone (or copy the URL)
4. Draw with your finger, tap **Send**
5. The drawing appears inline in the chat stream

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
# Port forwarding: route Windows port 8839 to WSL2
netsh interface portproxy add v4tov4 listenport=8839 listenaddress=0.0.0.0 connectport=8839 connectaddress=<WSL2_IP>

# Firewall: allow incoming connections on port 8839
netsh advfirewall firewall add rule name="Moby Drawing Pad" dir=in action=allow protocol=TCP localport=8839
```

Replace `<WSL2_IP>` with your WSL2 IP address. To find it, run in WSL2:
```bash
hostname -I | awk '{print $1}'
```

Then open `http://<your-windows-ip>:8839` on your phone. Your Windows IP is typically found via `ipconfig` in a Windows terminal (look for the WiFi adapter's IPv4 address).

### WSL2 IP Changes on Reboot

WSL2's internal IP changes every time Windows or WSL restarts. When that happens, the port forwarding breaks. To fix it:

```powershell
# Remove the old rule
netsh interface portproxy delete v4tov4 listenport=8839 listenaddress=0.0.0.0

# Add with the new WSL2 IP
netsh interface portproxy add v4tov4 listenport=8839 listenaddress=0.0.0.0 connectport=8839 connectaddress=<NEW_WSL2_IP>
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
netsh interface portproxy delete v4tov4 listenport=8839 listenaddress=0.0.0.0
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

## Drawing Controls

The phone drawing page provides:

- **Canvas**: Full-screen touch drawing area
- **Color picker**: 7 colors (black, red, blue, green, orange, purple, white)
- **Stroke size**: Adjustable slider (1-20px)
- **Clear**: Wipe the canvas
- **Send**: Transmit the drawing as a PNG to the extension

Mouse input also works (for testing on desktop).

## Inline Display

Received drawings appear inline in the chat stream as user messages with an `<img>` element. Drawings render on a white background for visibility in both dark and light themes.

**Right-click** on any inline drawing to access "Save Drawing As..." which opens a native file save dialog to export the image as PNG.

## Header Popup

The drawing server popup is triggered by the pencil button in the header bar. It shows two states:

- **Stopped**: A "Start Server" button with a brief description
- **Running**: A QR code encoding the server URL, the URL with a copy button, and a "Stop Server" button

The QR code is generated on the extension side using the vendored [nayuki QR Code generator](https://github.com/nayuki/QR-Code-generator) (MIT license, zero dependencies) and transmitted to the webview as a boolean matrix.

On WSL2, the popup automatically detects and displays the real Windows LAN IP (via `powershell.exe`) instead of the WSL2 internal IP, so the QR code works directly from your phone.

## Technical Details

- **Server**: Built-in Node.js `http` module (zero dependencies)
- **Port**: 8839 (default)
- **Protocol**: HTTP (no HTTPS needed on LAN — WiFi encryption handles security)
- **Image format**: PNG via `canvas.toDataURL()`
- **Max upload size**: 5 MB
- **QR code**: Vendored nayuki qrcodegen (`src/vendor/qrcodegen.ts`), MIT license
- **Storage**: Ephemeral — drawings are not saved to disk or database
- **Devices**: Single phone at a time
- **Health check**: `GET /health` returns `{"status":"ok"}`
- **WSL2 IP detection**: Shells out to `powershell.exe` to find the DHCP-assigned IPv4 address
- **Guide**: See [docs/phone-drawing.md](../phone-drawing.md) for research and phasing

## Architecture

```
Phone Browser (HTML5 canvas + touch events)
  ↓ HTTP POST (base64 PNG data URL)
DrawingServer (src/providers/drawingServer.ts)
  ↓ vscode.EventEmitter<DrawingReceivedEvent>
ChatProvider (src/providers/chatProvider.ts)
  ↓ webview.postMessage({ type: 'drawingReceived', imageDataUrl, timestamp })
VirtualMessageGatewayActor (media/actors/message-gateway/)
  ↓ virtualList.addTurn() + virtualList.addDrawingSegment()
VirtualListActor (media/actors/virtual-list/)
  ↓ actor.createDrawingSegment()
MessageTurnActor (media/actors/turn/)
  → Renders <img> in shadow DOM container
```

Key files:
- `src/providers/drawingServer.ts` — HTTP server, WSL2 detection, image events
- `src/vendor/qrcodegen.ts` — Vendored QR encoder (nayuki, MIT)
- `media/actors/drawing-server/DrawingServerShadowActor.ts` — Header popup UI
- `media/actors/virtual-list/types.ts` — `DrawingSegmentData` type
- `media/actors/turn/MessageTurnActor.ts` — `createDrawingSegment()` render method

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Phone can't reach the URL | Check WiFi (same network?), check firewall, check port forwarding (WSL2) |
| "Port 8839 is already in use" | Another process is using the port. Stop it or change the port in code |
| Drawing doesn't send | Check phone browser console for errors. Ensure the server is still running |
| QR code shows WSL2 internal IP | PowerShell IP detection failed. Check that `powershell.exe` is in PATH |
| WSL2 port forwarding stopped working | WSL2 IP changed after reboot. Re-run the setup commands |
| Drawing appears but is dark/invisible | Should have white background. Check CSS in `media/actors/turn/styles/index.ts` |
