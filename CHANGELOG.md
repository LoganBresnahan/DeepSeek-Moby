# Changelog

## [0.1.0] - 2026-04-05 (Pre-Release)

### Core
- DeepSeek V3 (Chat) and R1 (Reasoner) model support with per-model settings
- Event-sourced conversation database with SQLCipher encryption (AES-256-CBC)
- CQRS turn rendering with TurnEventLog and TurnProjector
- WASM tokenizer with per-model vocabulary support
- Platform-specific VSIX packaging (6 targets)

### Chat & Editing
- Three edit modes: Auto (apply immediately), Ask (accept/reject), Manual (VS Code diff tabs)
- SEARCH/REPLACE diff engine with exact, patch, and location-based matching
- Accept/Reject buttons in diff editor toolbar
- Shell command execution with inline streaming results
- File watcher for shell-modified and deleted files
- Auto-continuation when code edits fail to apply (file creation nudge)

### Shell Security
- Three-layer command validation: regex blocklist, approval rules, user prompts
- Per-command approval with persistent allow/block rules
- Command Rules modal for managing rules
- Git Bash detection on Windows for cross-platform compatibility

### UI
- Shadow DOM actor architecture with EventStateManager pub/sub
- Virtual scroll with actor pooling for large conversations
- Thinking dropdowns with per-iteration content
- Shell command dropdowns with output display
- Modified/Pending Files dropdowns with per-file status (applied, rejected, expired, deleted)
- Code block rendering with syntax highlighting, copy, diff, and apply actions
- "Seeking/Developing/Diving..." animation during code generation
- Expand/collapse toggle for input area
- Web search integration (Tavily)

### History & Sessions
- Auto-save conversations to encrypted database
- Session forking with fork metadata
- History modal with search, date grouping, rename, export (JSON/Markdown/TXT), delete
- Expired status for unresolved pending changes on history restore

### Commands
- 18 commands under "Moby" category
- Drawing server for phone-based sketching input
- Unified log export for debugging

### Known Limitations
- WSL2 file watcher may miss deletion events from chained shell commands (B25)
