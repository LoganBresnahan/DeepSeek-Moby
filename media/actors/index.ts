/**
 * Actor exports
 */

// Streaming
export { StreamingActor } from './streaming';
export type { StreamingState } from './streaming';

// Message
export { MessageActor } from './message';
export { MessageShadowActor } from './message/MessageShadowActor';
export type { Message, MessageState } from './message';

// Input
export { InputActor } from './input';
export type { InputState, SubmitHandler } from './input';

// Session
export { SessionActor } from './session';
export type { SessionData, SessionState, VSCodeAPI } from './session';

// Header
export { HeaderActor } from './header';
export { HeaderShadowActor } from './header/HeaderShadowActor';
export type { HeaderState, HeaderAction, ActionHandler, ModelChangeHandler, TitleChangeHandler } from './header';

// Sidebar
export { SidebarActor } from './sidebar';
export { SidebarShadowActor } from './sidebar/SidebarShadowActor';
export type { HistoryItem, SidebarState, SessionSelectHandler, SessionDeleteHandler } from './sidebar';

// Shell
export { ShellActor } from './shell';
export { ShellShadowActor } from './shell/ShellShadowActor';
export type { ShellCommand, ShellSegment, ShellState, ShellExecuteHandler } from './shell';

// Tool Calls
export { ToolCallsActor } from './tools';
export { ToolCallsShadowActor } from './tools/ToolCallsShadowActor';
export type { ToolCall, ToolCallsState } from './tools';

// Pending Changes
export { PendingChangesActor } from './pending';
export { PendingChangesShadowActor } from './pending/PendingChangesShadowActor';
export type { FileStatus, EditMode, PendingFile, PendingChangesState, FileActionHandler } from './pending';

// Thinking
export { ThinkingActor } from './thinking';
export { ThinkingShadowActor } from './thinking/ThinkingShadowActor';
export type { ThinkingIteration, ThinkingState } from './thinking';

// Code Block
export { CodeBlockActor } from './codeblock';
export { CodeBlockShadowActor } from './codeblock/CodeBlockShadowActor';
export type { CodeBlock, CodeBlockState, CodeActionHandler } from './codeblock';

// Scroll
export { ScrollActor } from './scroll';
export type { ScrollState } from './scroll';

// Diff
export { DiffActor } from './diff';
export { DiffShadowActor } from './diff/DiffShadowActor';
export type { DiffLine, DiffData, DiffState } from './diff';
export type { DiffActionHandler } from './diff/DiffShadowActor';

// Input Area
export { InputAreaActor } from './input-area';
export { InputAreaShadowActor } from './input-area/InputAreaShadowActor';
export type { Attachment, InputAreaState, SendHandler, StopHandler, InterruptHandler } from './input-area';

// Status Panel
export { StatusPanelActor } from './status-panel';
export { StatusPanelShadowActor } from './status-panel/StatusPanelShadowActor';
export type { StatusPanelState, LogsHandler } from './status-panel';

// Toolbar
export { ToolbarActor } from './toolbar';
export { ToolbarShadowActor } from './toolbar/ToolbarShadowActor';
export type { ToolbarState, EditModeHandler, WebSearchHandler, FilesHandler, CommandHandler, WebSearchSettings } from './toolbar';
// Note: EditMode is also exported from ./pending, so toolbar's version is accessed via ToolbarActor.EditMode if needed

// Dropdown Focus - UNUSED (see media/actors/dropdown-focus/UNUSED.txt)
// export { DropdownFocusActor } from './dropdown-focus';
// export type { DropdownInfo, DropdownFocusState } from './dropdown-focus';

// Inspector
export { InspectorShadowActor } from './inspector';
export type { InspectorState, StyleProperty, StyleCategory, InspectedElement } from './inspector';

// History
export { HistoryShadowActor } from './history';
export type { HistorySession, HistoryMessage } from './history';

// Future actors will be exported here as they're implemented:
// export { MarkdownActor } from './markdown';
