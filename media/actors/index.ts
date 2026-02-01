/**
 * Actor exports
 */

// Streaming
export { StreamingActor } from './streaming';
export type { StreamingState } from './streaming';

// Message
export { MessageActor } from './message';
export type { Message, MessageState } from './message';

// Input
export { InputActor } from './input';
export type { InputState, SubmitHandler } from './input';

// Session
export { SessionActor } from './session';
export type { SessionData, SessionState, VSCodeAPI } from './session';

// Header
export { HeaderActor } from './header';
export type { HeaderState, HeaderAction, ActionHandler, ModelChangeHandler, TitleChangeHandler } from './header';

// Sidebar
export { SidebarActor } from './sidebar';
export type { HistoryItem, SidebarState, SessionSelectHandler, SessionDeleteHandler } from './sidebar';

// Shell
export { ShellActor } from './shell';
export type { ShellCommand, ShellSegment, ShellState, ShellExecuteHandler } from './shell';

// Tool Calls
export { ToolCallsActor } from './tools';
export type { ToolCall, ToolCallsState } from './tools';

// Pending Changes
export { PendingChangesActor } from './pending';
export type { FileStatus, EditMode, PendingFile, PendingChangesState, FileActionHandler } from './pending';

// Thinking
export { ThinkingActor } from './thinking';
export type { ThinkingIteration, ThinkingState } from './thinking';

// Code Block
export { CodeBlockActor } from './codeblock';
export type { CodeBlock, CodeBlockState, CodeActionHandler } from './codeblock';

// Scroll
export { ScrollActor } from './scroll';
export type { ScrollState } from './scroll';

// Diff
export { DiffActor } from './diff';
export type { DiffLine, DiffData, DiffState } from './diff';

// Input Area (wraps existing DOM)
export { InputAreaActor } from './input-area';
export type { Attachment, InputAreaState, SendHandler, StopHandler, InterruptHandler } from './input-area';

// Status Panel (wraps existing DOM)
export { StatusPanelActor } from './status-panel';
export type { StatusPanelState, LogsHandler } from './status-panel';

// Toolbar (wraps existing DOM)
export { ToolbarActor } from './toolbar';
export type { ToolbarState, EditModeHandler, WebSearchHandler, FilesHandler, CommandHandler, WebSearchSettings } from './toolbar';
// Note: EditMode is also exported from ./pending, so toolbar's version is accessed via ToolbarActor.EditMode if needed

// Future actors will be exported here as they're implemented:
// export { MarkdownActor } from './markdown';
