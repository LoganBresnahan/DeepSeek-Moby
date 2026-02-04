/**
 * Actor exports
 *
 * All UI actors are Shadow DOM based for style isolation.
 * Utility actors (Streaming, Scroll) don't need Shadow DOM.
 */

// Streaming (utility - no Shadow DOM needed)
export { StreamingActor } from './streaming';
export type { StreamingState } from './streaming';

// Scroll (utility - no Shadow DOM needed)
export { ScrollActor } from './scroll';
export type { ScrollState } from './scroll';

// Session (manages VS Code extension communication - no Shadow DOM needed)
export { SessionActor } from './session';
export type { SessionData, SessionState, VSCodeAPI } from './session';

// Message
export { MessageShadowActor } from './message/MessageShadowActor';
export type { Message, MessageState } from './message/MessageShadowActor';

// Header
export { HeaderShadowActor } from './header/HeaderShadowActor';
export type { HeaderState, HeaderAction, ActionHandler, ModelChangeHandler, TitleChangeHandler } from './header/HeaderShadowActor';

// Sidebar
export { SidebarShadowActor } from './sidebar/SidebarShadowActor';
export type { HistoryItem, SidebarState, SessionSelectHandler, SessionDeleteHandler } from './sidebar/SidebarShadowActor';

// Shell
export { ShellShadowActor } from './shell/ShellShadowActor';
export type { ShellCommand, ShellSegment, ShellState, ShellExecuteHandler } from './shell/ShellShadowActor';

// Tool Calls
export { ToolCallsShadowActor } from './tools/ToolCallsShadowActor';
export type { ToolCall, ToolCallsState } from './tools/ToolCallsShadowActor';

// Pending Changes
export { PendingChangesShadowActor } from './pending/PendingChangesShadowActor';
export type { FileStatus, EditMode, PendingFile, PendingChangesState, FileActionHandler } from './pending/PendingChangesShadowActor';

// Thinking
export { ThinkingShadowActor } from './thinking/ThinkingShadowActor';
export type { ThinkingIteration, ThinkingState } from './thinking/ThinkingShadowActor';

// Code Block
export { CodeBlockShadowActor } from './codeblock/CodeBlockShadowActor';
export type { CodeBlock, CodeBlockState, CodeActionHandler } from './codeblock/CodeBlockShadowActor';

// Diff
export { DiffShadowActor } from './diff/DiffShadowActor';
export type { DiffLine, DiffData, DiffState, DiffActionHandler } from './diff/DiffShadowActor';

// Input Area
export { InputAreaShadowActor } from './input-area/InputAreaShadowActor';
export type { Attachment, InputAreaState, SendHandler, StopHandler, InterruptHandler } from './input-area/InputAreaShadowActor';

// Status Panel
export { StatusPanelShadowActor } from './status-panel/StatusPanelShadowActor';
export type { StatusPanelState, LogsHandler } from './status-panel/StatusPanelShadowActor';

// Toolbar
export { ToolbarShadowActor } from './toolbar/ToolbarShadowActor';
export type { ToolbarState, EditModeHandler, WebSearchHandler, FilesHandler, CommandHandler, WebSearchSettings } from './toolbar/ToolbarShadowActor';

// History
export { HistoryShadowActor } from './history';
export type { HistorySession, HistoryMessage } from './history';

// Files (context files modal)
export { FilesShadowActor } from './files';
export type { FileData, FilesState, FilesChangeHandler } from './files';

// Commands (commands dropdown)
export { CommandsShadowActor } from './commands';
export type { CommandItem, CommandHandler } from './commands';

// Model Selector (model dropdown with parameters)
export { ModelSelectorShadowActor } from './model-selector';
export type { ModelOption, ModelSettings, ModelChangeHandler as ModelSelectHandler, SettingsChangeHandler } from './model-selector';

// Settings (settings dropdown)
export { SettingsShadowActor } from './settings';
export type { SettingsValues, DefaultPrompt } from './settings';

// Inspector - Dev-only tool, not exported from production actors
// Access via: import { InspectorShadowActor } from './dev/inspector'
