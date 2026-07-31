---
name: verify
description: Runtime-verification recipe for DeepSeek Moby — how to drive the built webview headless and the full extension in a real VS Code instance (WSLg) without a real model API key.
---

# Verifying DeepSeek Moby changes at runtime

Two handles, cheapest first. Both need `npm run compile` (webpack → `dist/extension.js` + esbuild → `dist/media/chat.js`); webview-only changes need only `node scripts/build-media.js`.

## Handle 1 — webview only (headless Chromium, ~5s/run)

The webview's programmatic surface is window `message` events (what the extension posts). Load `tests/e2e/helpers/harness.html` (which pulls the real `dist/media/chat.js`) in Playwright Chromium with a mocked `acquireVsCodeApi`, then dispatch messages:

- restore path: `{ type: 'loadHistory', history: [...] }` with `turnEvents` arrays
- live path: `addMessage` → `startResponse` → `streamToken`(s) → `endResponse`; live modified-files via `diffListChanged`

Inspect across shadow roots: turns are `[data-turn-id]` hosts; code dropdowns are `.code-block` inside their shadowRoots; the Modified Files dropdown is the `.pending-container` host. Playwright locators do NOT reach these directly — use `evaluate` walking `el.shadowRoot`.

Working driver pattern: see git history of `scratchpad/drive-webview.cjs` in session bf4ef993 or rebuild from the above. `require('<repo>/node_modules/playwright')` works from any script location.

## Handle 2 — full extension in real VS Code (WSLg, ~60s/run)

Cached binaries live in `.vscode-test/vscode-linux-x64-*/code`. WSLg display (`DISPLAY=:0`) is enough — no xvfb needed.

**No API key required**: stand up a fake OpenAI-compatible server (SSE + JSON; return `tool_calls` deltas on iteration 1, content on iteration 2 once a `role:"tool"` message appears) and register it as a custom model. Pre-seed the fresh user-data-dir's `User/settings.json`:

```json
{
  "moby.model": "fake-model",
  "moby.editMode": "auto",
  "moby.customModels": [{
    "id": "fake-model", "name": "Fake E2E Model", "toolCalling": "native",
    "reasoningTokens": "none", "editProtocol": ["native-tool"], "shellProtocol": "native-tool",
    "supportsTemperature": true, "maxOutputTokens": 4096, "maxTokensConfigKey": "maxTokensChat",
    "streaming": true, "apiEndpoint": "http://127.0.0.1:41999/chat/completions",
    "apiKey": "fake-key", "requestFormat": "openai"
  }],
  "security.workspace.trust.enabled": false, "update.mode": "none"
}
```

Launch: spawn the code binary with `--extensionDevelopmentPath=<repo> --remote-debugging-port=<port> --user-data-dir=<tmp> <tmp-workspace> --no-sandbox --disable-gpu --password-store=basic`, strip `ELECTRON_RUN_AS_NODE`/`VSCODE_*` from env (see `tests/e2e/helpers/launch.ts`), wait for "DevTools listening" on stderr, connect `chromium.connectOverCDP`.

Drive: click `.activitybar a[aria-label*="DeepSeek"]`; find the Moby webview frame by polling `page.frames()` for one containing `#chatMessages`. The chat textarea is nested in shadow DOM — set `.value`, dispatch `input`, then a bubbling `keydown` Enter to send.

**Restore paths, in increasing strength:**
1. Same-process webview recreate: switch to Explorer icon, wait ~4s, switch back → webview disposed/recreated → hydration runs against the live extension host.
2. Cold start: relaunch VS Code on the same user-data-dir + workspace. The current-session auto-restore pointer may be lost if you `proc.kill()`ed the previous instance (async globalState write) — instead load the session via the webview History button (`#historyBtn` in the frame document, entries match `/session-item|history-item/` across shadow roots).

## Gotchas

- `pkill -f <pattern>`: the user's own VS Code Remote-WSL server (`~/.vscode-server/...`) is running in this namespace — NEVER kill it. Match on `vscode-linux-x64` (the test binary path) only, and check `ps` before killing.
- One VS Code instance per user-data-dir (single-instance handoff exits 0 immediately).
- moby.db (SQLCipher) lives at `<udd>/User/globalStorage/loganbresnahan.deepseek-moby/moby.db` — unreadable without the secret-storage key; use UI observation, not DB reads.
- Screenshots from repeated driver runs overwrite each other — rename anything you want to keep before re-running.
