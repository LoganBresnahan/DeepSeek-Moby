
<p align="center">
  <img src="media/moby.png" height="120px" alt="DeepSeek Moby" />
</p>

<h1 align="center">DeepSeek Moby</h1>
<h2 align="center">v0.1.0 Pre-Release</h2>

<p align="center">
  <sub><em>This is a pre-release build. Core functionality has been validated on the maintainer's primary development environment, but coverage across the full matrix of operating systems, VS Code versions, shell environments, and model configurations remains incomplete. Expect rough edges. Bug reports and reproduction steps are welcome via the <a href="https://github.com/LoganBresnahan/DeepSeek-Moby/issues">issue tracker</a>.</em></sub>
</p>

<p align="center">
  <strong>An AI coding assistant for VS Code, powered by DeepSeek.</strong>
  <br />
  Chat, edit, search, execute — all from your editor.
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#getting-started">Getting Started</a> &middot;
  <a href="#configuration">Configuration</a> &middot;
  <a href="#commands">Commands</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#roadmap">Roadmap</a>
</p>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/LoganBresnahan/DeepSeek-Moby/main/media/deepseek-moby-preview.gif" alt="DeepSeek Moby demo" width="800" />
</p>

---

## Features

### Four Models, One Interface

Pick the model that fits the task — or register your own (see [Custom Models](#custom-models)).

| Model | Best For | Context | Max Output |
|-------|----------|---------|------------|
| **DeepSeek V4 Pro** *(default)* | Hardest problems — agentic work, multi-step reasoning, large refactors | 1M tokens | 384K tokens |
| **DeepSeek V4 Flash** | Cheap reasoning — exploration, planning, lightweight agentic tasks | 1M tokens | 384K tokens |
| **DeepSeek Chat (V3)** *(retiring 2026-07-24)* | Legacy non-reasoning fast tier | 128K tokens | 8K tokens |
| **DeepSeek Reasoner (R1)** *(retiring 2026-07-24)* | Legacy chain-of-thought + shell-driven agentic work | 128K tokens | 64K tokens |

- **V4 Pro / V4 Flash** stream native tool calls — file reads, searches, code edits, and shell commands dispatch inline as the model emits them, with reasoning tokens streaming live during tool decisions
- **V3 Chat** uses native tool calls without inline reasoning — fast and cheap, no thinking overhead
- **R1** uses inline `<shell>...</shell>` tags — `cat`, `grep`, `sed`, heredocs — with full terminal access
- Switching models automatically creates a new session (no mixed-model conversations)
- Reasoning tokens (V4 Pro / V4 Flash / R1) display in expandable "Thinking" dropdowns so you can follow the model's logic

### Three Edit Modes

Control how code changes are applied to your files:

- **Manual (M)** — Code diffs appear in a collapsible dropdown. You click Diff to view, then Apply to write
- **Ask (Q)** — Diffs auto-display in a side-by-side view. You confirm or reject each change
- **Auto (A)** — Changes are applied immediately. A "Modified Files" dropdown shows what was changed

All edits use a precise SEARCH/REPLACE format with multi-strategy matching (exact, fuzzy whitespace, patch-based, location-based fallback).

### Web Search (Tavily or SearXNG)

Real-time web search integrated into the conversation. Pick a backend via `moby.webSearch.provider`:

- **Tavily** *(default)* — hosted, paid; requires an API key from [tavily.com](https://tavily.com) (free tier available). Set via the **Set Tavily API Key** command.
- **SearXNG** — self-hosted metasearch, free, no API key. Point `moby.webSearch.searxng.endpoint` at a running instance (e.g. `http://localhost:8080`); the instance must have the JSON format enabled. Configure engines via `moby.webSearch.searxng.engines`. Use the **Set SearXNG Endpoint** command for the URL.

Modes (`moby.webSearchMode`):

- **Off** — Disabled
- **Auto** — The model decides when to search (recommended)
- **Manual** — Search only when the user toggles it on

Results cache in-memory with configurable duration. Tavily depth is selectable (`basic` / `advanced`); per-prompt search count is capped via `moby.tavilySearchesPerPrompt`.

### Custom Models

Register any OpenAI-compatible endpoint as a first-class model alongside the DeepSeek built-ins:

- **Local runners** — Ollama, LM Studio, llama.cpp Server, vLLM
- **Hosted APIs** — OpenAI, Groq, Moonshot/Kimi, OpenRouter, Together, Fireworks, or any service that speaks the OpenAI Chat Completions wire format
- Use the **Add Custom Model** command (or edit `moby.customModels` directly) to declare an entry with `id`, `apiEndpoint`, `apiKey`, capability flags (`toolCalling`, `reasoningTokens`, `editProtocol`, `shellProtocol`), and per-model token limits
- Per-model API keys via **Set Custom Model API Key** (encrypted in SecretStorage), or omit `apiKey` to fall back to the global `moby.apiKey`
- Capability flags decide which protocols the model supports — native tool calling, SEARCH/REPLACE-only edits, R1-style `<shell>` tags, or any combination
- Custom models appear in the model selector below the built-ins; the "Switch Model" command cycles through all registered models

See [docs/guides/custom-models.md](docs/guides/custom-models.md) for end-to-end examples (Ollama, LM Studio, OpenAI, Groq, Kimi, llama.cpp).

### Shell Command Security

Every shell command goes through an approval system before execution:

- **Inline approval prompts** — When the model attempts to run a command you haven't seen before, an approval widget appears during streaming. You choose:
  - **Allow Once** — Run this command now, ask again next time
  - **Always Allow** — Add this command prefix to your permanent allowlist
  - **Block Once** — Reject this command, the model will adapt
  - **Always Block** — Add this command prefix to your permanent blocklist
- **Command Rules modal** — View and edit your full allowlist/blocklist via the Commands popup or Command Palette. Ships with bash defaults (all platforms use the same rules since Windows runs commands through Git Bash)
- **Override toggle** — "Allow All Commands" setting bypasses all checks (use with caution)
- Commands execute inline during streaming, one at a time, with results visible immediately

### Conversation History

Event-sourced conversation storage with full session management:

- **Forking** — Click the fork button (🍴) on any message to branch the conversation. Forking from a user message auto-sends it for a fresh response
- **Search** — Full-text search across all sessions
- **Export** — JSON, Markdown, or plain text format
- **Import** — Load sessions from JSON files
- **Auto-save** — Every message persisted automatically

### Plan Mode

Create and manage plan files that are injected into every request:

- Click the **P** button to open the plans popup
- Create named plan files (stored in `.moby-plans/` in your workspace)
- Toggle plans active/inactive — only active plans are included in context
- Multiple plans can be active simultaneously
- Plans are regular Markdown files — edit them in VS Code with full editor features

### Custom System Prompts

Add custom instructions that get prepended to every request:

- Accessible via the Commands popup or toolbar
- Saved prompts stored in the encrypted database with per-model tags
- Multiple named prompts with load/save/delete
- Active prompt indicator with deactivation support
- Empty = use built-in defaults (no prompt overhead)

### Drawing Server

Start a local server for desktop or phone/tablet-based drawing input:

- ASCII diagram mode for text-based sketches — send diagrams directly to the model as context
- Freehand drawing pad with touch support (brush color, size, undo/redo) — *note: drawing pad output is image-based and not currently usable by DeepSeek models, which do not support image input*
- QR code for quick phone connection
- WSL2 support with port forwarding instructions

### File Context Selection

Manually curate which files the model sees:

- Modal with live list of open editor tabs
- Workspace search for finding files in large repos
- Selected files injected as full content into the system prompt
- Independent of the model's tool-based file reading

### Context Window Management

Automatic context budgeting so conversations can run indefinitely:

- 128K token context window for both models
- Oldest messages dropped first when budget is exceeded
- Compressed summaries injected to preserve key context
- WASM-based tokenizer for exact token counting (fallback estimation available)
- Silent operation — no user intervention needed

### Encrypted Storage

All conversation data stored in an encrypted SQLite database:

- **SQLCipher** (AES-256-CBC) — the same encryption library used by Signal
- Encryption key auto-generated on first launch and stored securely:
  - **Primary:** OS keychain via VS Code's SecretStorage API (macOS Keychain, Windows Credential Manager, Linux SecretService/kwallet)
  - **Fallback:** File-based storage in VS Code's global storage directory (for environments without a keyring: WSL, containers, headless Linux, SSH sessions)
- Key management UI for viewing, changing, or regenerating the encryption key
- WAL mode for crash safety and concurrent access
- Stored data: conversations, session metadata, command rules, saved prompts, context snapshots

### Shadow DOM Isolation

The entire chat UI is built with Shadow DOM encapsulation:

- Each UI component (messages, toolbars, popups, modals) renders in its own shadow root
- CSS styles cannot leak between components or be affected by other extensions
- DOM isolation prevents other extensions from reading or manipulating the chat content
- VS Code theme variables (`--vscode-*`) flow through for consistent theming
- Actor-based architecture with pub/sub communication between isolated components

---

## Requirements

- **VS Code** 1.85.0 or later
- **Node.js** 20.x or later (for building from source)
- **Git** — Required for shell command execution on Windows. [Git for Windows](https://git-scm.com/download/win) includes Git Bash, which provides the POSIX-compatible shell needed to run AI-generated commands (heredocs, grep, pipes, etc.). On Linux/macOS, the system shell is used automatically.
- **DeepSeek API Key** — From [platform.deepseek.com](https://platform.deepseek.com)

## Getting Started

### 1. Install

**From VSIX:**
1. Download the `.vsix` file from [Releases](https://github.com/LoganBresnahan/DeepSeek-Moby/releases)
2. In VS Code: Extensions view &rarr; `...` menu &rarr; "Install from VSIX..."

**From Source:**
```bash
git clone https://github.com/LoganBresnahan/DeepSeek-Moby.git
cd DeepSeek-Moby
npm install
npm run package
# Press F5 to debug, or install the generated .vsix
```

### 2. Set Your API Key

**Option A: Command Palette (recommended)**

Open the Command Palette (`Ctrl+Shift+P`) and run:
- **DeepSeek Moby: Set API Key** — Enter your key from [platform.deepseek.com](https://platform.deepseek.com)
- **DeepSeek Moby: Set Tavily API Key** — (Optional) For web search, get a key from [tavily.com](https://tavily.com)

**Option B: Environment Variables**

For CI, containers, or headless environments, set environment variables instead:
```bash
export DEEPSEEK_API_KEY="sk-..."        # Required
export TAVILY_API_KEY="tvly-..."        # Optional, for web search
```

The extension checks SecretStorage first, then falls back to environment variables.

### 3. Start Chatting

Click the Moby icon in the sidebar activity bar, type a message, and press Enter.

---

## Configuration

**Model selection**

| Setting | Default | Description |
|---------|---------|-------------|
| `moby.model` | `deepseek-v4-pro-thinking` | Active model. Built-ins: `deepseek-v4-pro-thinking`, `deepseek-v4-flash-thinking`, `deepseek-chat` (retiring 2026-07-24), `deepseek-reasoner` (retiring 2026-07-24). Also accepts any custom model `id`. |
| `moby.customModels` | `[]` | Array of custom OpenAI-compatible models to register alongside the built-ins. See [Custom Models](#custom-models). |
| `moby.modelOptions` | `{}` | Per-model options keyed by model id. Currently supports `reasoningEffort` (`high` or `max`) for V4 models. |
| `moby.temperature` | `0.7` | Creativity (0-2). V3 chat only — V4 and R1 reject temperature. |

**Token / iteration limits**

| Setting | Default | Description |
|---------|---------|-------------|
| `moby.maxTokensV4ProThinking` | `65536` | Max output tokens for V4 Pro. API cap: 384,000. |
| `moby.maxTokensV4FlashThinking` | `65536` | Max output tokens for V4 Flash. API cap: 384,000. |
| `moby.maxTokensChatModel` | `8192` | Max output tokens for Chat (V3). Range: 256-8,192. |
| `moby.maxTokensReasonerModel` | `65536` | Max output tokens for Reasoner (R1). Range: 256-65,536. |
| `moby.maxToolCalls` | `100` | Tool call iteration limit (native-tool models). 100 = no limit. |
| `moby.maxShellIterations` | `100` | Shell command iteration limit (Reasoner). 100 = no limit. |
| `moby.maxFileEditLoops` | `100` | Continuations after R1 produces file edits. 100 = no limit. |

**Editing & shell**

| Setting | Default | Description |
|---------|---------|-------------|
| `moby.editMode` | `manual` | How code changes apply: `manual`, `ask`, or `auto`. |
| `moby.allowAllShellCommands` | `false` | Bypass command approval system. Disables the safety blocklist. |

**Web search**

| Setting | Default | Description |
|---------|---------|-------------|
| `moby.webSearchMode` | `auto` | `off`, `manual` (user toggle only), or `auto` (LLM decides). |
| `moby.webSearch.provider` | `tavily` | Backend: `tavily` (hosted, paid) or `searxng` (self-hosted, free). |
| `moby.webSearch.searxng.endpoint` | `""` | Base URL of your SearXNG instance (e.g. `http://localhost:8080`). |
| `moby.webSearch.searxng.engines` | `["google","bing","duckduckgo"]` | SearXNG engines to query. Empty = instance default. |
| `moby.tavilySearchDepth` | `basic` | Tavily depth: `basic` (1 credit) or `advanced` (2 credits). |
| `moby.tavilySearchesPerPrompt` | `1` | Max Tavily searches per prompt request. |

**UI & observability**

| Setting | Default | Description |
|---------|---------|-------------|
| `moby.showStatusBar` | `true` | Show status bar with token usage. |
| `moby.autoSaveHistory` | `true` | Automatically save chat history. |
| `moby.logLevel` | `WARN` | Extension log level: `DEBUG`, `INFO`, `WARN`, `ERROR`, `OFF`. |
| `moby.webviewLogLevel` | `WARN` | Webview console log level: `DEBUG`, `INFO`, `WARN`, `ERROR`. |
| `moby.tracing.enabled` | `true` | Enable trace collection for debugging. |
| `moby.devMode` | `false` | Enable developer tools (inspector panel). |

---

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and search "Moby":

| Command | Description |
|---------|-------------|
| **Open Chat** | Open the chat sidebar |
| **New Chat** | Start a fresh conversation |
| **Switch Model** | Cycle through registered models (built-ins + custom) |
| **Set API Key** | Configure your DeepSeek API key |
| **Set Tavily API Key** | Configure Tavily web search API key |
| **Set SearXNG Endpoint** | Configure the URL of your SearXNG instance |
| **Add Custom Model** | Walk through registering an OpenAI-compatible custom model |
| **Set Custom Model API Key** | Store an API key for a registered custom model (encrypted) |
| **Clear Custom Model API Key** | Remove a stored custom-model API key |
| **Show Chat History** | Browse, search, and manage past conversations |
| **Export All Chat History** | Export all sessions as JSON, Markdown, or text |
| **Import Chat History** | Load sessions from a JSON file |
| **Clear All Chat History** | Delete all saved conversations |
| **Export Current Session** | Export the active session |
| **Command Rules** | View and edit shell command approval rules |
| **Accept Changes** | Accept the active diff (also bound to the diff toolbar) |
| **Reject Changes** | Reject the active diff |
| **Show Pending Diffs** | Quick pick for pending code changes (`Ctrl+Shift+D`) |
| **Statistics** | View token usage and API call stats |
| **Show Log** | Open the extension output channel |
| **Export Logs** | Export logs and traces for bug reports |
| **Export Turn as JSON (Debug)** | Snapshot the live event stream for the current turn (devMode) |
| **Export Session (Test Fixture)** | Export a session as a fixture file for tests |
| **Start Drawing Server** | Launch the drawing pad server |
| **Stop Drawing Server** | Shut down the drawing server |
| **Manage Database Encryption Key** | View or regenerate the database encryption key |

---

## Architecture

Moby is built with a layered architecture designed for reliability and extensibility:

```
┌─────────────────────────────────────────────────┐
│  VS Code Extension (Node.js)                     │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ DeepSeek API │  │ Managers                  │  │
│  │  Client      │  │  ├─ RequestOrchestrator   │  │
│  │  (Chat, R1)  │  │  ├─ DiffManager           │  │
│  │              │  │  ├─ WebSearchManager      │  │
│  └─────────────┘  │  ├─ FileContextManager    │  │
│                    │  ├─ CommandApprovalMgr    │  │
│  ┌─────────────┐  │  ├─ PlanManager           │  │
│  │ SQLCipher DB │  │  └─ SettingsManager       │  │
│  │ (Encrypted)  │  └──────────────────────────┘  │
│  └─────────────┘                                 │
│         ↕ postMessage                            │
│  ┌───────────────────────────────────────────┐   │
│  │  Webview (Browser)                         │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │ Actor System (Shadow DOM)            │  │   │
│  │  │  ├─ EventStateManager (pub/sub)      │  │   │
│  │  │  ├─ VirtualListActor (pooling)       │  │   │
│  │  │  ├─ MessageTurnActor (per-message)   │  │   │
│  │  │  ├─ ToolbarShadowActor              │  │   │
│  │  │  ├─ InputAreaShadowActor            │  │   │
│  │  │  └─ PopupShadowActor (base)         │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Event-sourced persistence** — Conversations stored as append-only event logs. Enables forking (zero-copy via join table), compression snapshots, and reliable history restore
- **Actor model UI** — Each UI component is a ShadowActor with its own shadow root, styles, and lifecycle. Communication via EventStateManager pub/sub. No global CSS, no DOM conflicts
- **Coordinator pattern** — ChatProvider routes messages between managers. Managers own their domain logic and communicate via VS Code EventEmitters
- **Streaming pipeline** — ContentTransformBuffer handles token-by-token streaming with progressive flush (emit safe content immediately, hold back potential `<shell>` tags until complete)

For contributors, see the full architecture documentation in `docs/architecture/`.

---

## Privacy & Security

- **API keys** stored in VS Code's encrypted SecretStorage (OS keychain when available, file-based fallback otherwise)
- **Conversations** stored locally in an AES-256 encrypted SQLite database
- **No telemetry** — no data sent anywhere except the DeepSeek API (and Tavily if web search is enabled)
- **Shell commands** gated by an approval system with user-configurable rules
- **Shadow DOM isolation** prevents other extensions from accessing chat content
- **Works without a workspace** — the extension activates and is fully functional even when VS Code is opened without a folder

---

## Roadmap

Planned features for future releases:

- **Sub-agent parallelization** — Multiple LLM calls running concurrently for complex tasks
- **Plugin system** — Extensible tool definitions for domain-specific workflows
- **Per-turn lazy event load** — On-demand hydration of large session histories (deferred until real usage surfaces the need)

---

## License

[AGPL-3.0](LICENSE.txt)
