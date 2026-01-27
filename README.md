

# DeepSeek Moby
<img src="media/moby.png" height="100px" alt="DeepSeek Moby" />

An unofficial DeepSeek AI assistant for Visual Studio Code.

## Features

### Chat Interface
- Sidebar chat with streaming responses
- Full conversation history with search, export, and import
- Session management and statistics tracking
- Code-aware context from your active editor

### Model Selection
- **DeepSeek-V3** (`deepseek-chat`) - Fast, general-purpose model
- **DeepSeek-R1** (`deepseek-reasoner`) - Reasoning model with chain-of-thought, better for complex problems

### Workspace Tools
The chat model can explore your codebase using built-in tools:
- Read and analyze files in your workspace
- Search for code patterns and symbols
- List directory contents
- Context-aware responses based on your project structure

### Web Search
Optional web search integration via Tavily API:
- Real-time information retrieval during chat
- Configurable search depth and frequency

### Code Actions (Experimental)
Right-click selected code to access:
- **Explain Code** - Get detailed explanations
- **Refactor Code** - Improve structure and readability
- **Document Code** - Generate documentation
- **Find and Fix Bugs** - Identify potential issues
- **Optimize Performance** - Get optimization suggestions
- **Generate Tests** - Create test cases

### Inline Completions
- Context-aware code suggestions as you type
- Works with any programming language

## Installation

### From VSIX
1. Download the `.vsix` file from releases
2. In VS Code: Extensions view → `...` menu → "Install from VSIX..."

### From Source
1. Clone this repository
2. Run `npm install`
3. Run `npm run package`
4. Press F5 to debug, or install the generated `.vsix`

## Configuration

1. Get your API key from [platform.deepseek.com](https://platform.deepseek.com)
2. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
3. Search for "DeepSeek" and enter your API key

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `deepseek.apiKey` | - | Your DeepSeek API key |
| `deepseek.model` | `deepseek-chat` | Model to use (`deepseek-chat` or `deepseek-reasoner`) |
| `deepseek.temperature` | `0.7` | Creativity level (0-2) |
| `deepseek.maxTokens` | `4096` | Max tokens per response (up to 64K for reasoner) |
| `deepseek.maxToolCalls` | `25` | Max tool calls per request (chat model only) |
| `deepseek.enableCompletions` | `true` | Enable inline code completions |
| `deepseek.autoFormat` | `true` | Auto-format code responses |
| `deepseek.showStatusBar` | `true` | Show token usage in status bar |
| `deepseek.maxHistorySessions` | `100` | Max chat sessions to retain |
| `deepseek.tavilyApiKey` | - | Tavily API key for web search |
| `deepseek.tavilySearchDepth` | `basic` | Search depth (`basic` or `advanced`) |

## Usage

### Chat
1. Click the DeepSeek Moby icon in the activity bar
2. Type your message and press Enter
3. Use the History panel to browse and search past conversations

### Code Actions
1. Select code in the editor
2. Right-click and choose a DeepSeek action from the context menu

### Commands
Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search for "DeepSeek Moby" to see all available commands.

## Privacy

- API keys are stored locally in VS Code settings
- Conversations are stored locally on your machine
- Data is only sent to DeepSeek API (and Tavily if web search is enabled)

## License

AGPL
