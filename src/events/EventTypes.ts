/**
 * Event Types for Event Sourcing Architecture
 *
 * Events are immutable facts about what happened in a conversation.
 * Each event captures a single atomic action and contains all information
 * needed to reconstruct that action.
 */

// ============================================================================
// Base Types
// ============================================================================

/**
 * Base interface for all events.
 * Every event must have these fields.
 */
export interface BaseEvent {
  /** Unique identifier for this event (UUID) */
  id: string;
  /** Which conversation session this event belongs to */
  sessionId: string;
  /** Unix timestamp in milliseconds when event occurred */
  timestamp: number;
  /** Order within session (auto-increment, 1-based) */
  sequence: number;
}

/**
 * Attachment included with a user message.
 */
export interface Attachment {
  type: 'file' | 'image' | 'selection';
  name: string;
  content: string;
  language?: string;
  filePath?: string;
}

// ============================================================================
// Message Events
// ============================================================================

/**
 * User sends a message to the assistant.
 */
export interface UserMessageEvent extends BaseEvent {
  type: 'user_message';
  content: string;
  attachments?: Attachment[];
}

/**
 * Assistant sends a response.
 * Recorded after streaming completes with the full content.
 */
export interface AssistantMessageEvent extends BaseEvent {
  type: 'assistant_message';
  content: string;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  contentIterations?: string[];
}

/**
 * Reasoning trace from R1 model.
 * The "thinking" content shown in collapsible dropdowns.
 */
export interface AssistantReasoningEvent extends BaseEvent {
  type: 'assistant_reasoning';
  content: string;
  /** Which iteration of reasoning (for multi-step thinking) */
  iteration: number;
}

// ============================================================================
// Tool Events
// ============================================================================

/**
 * Tool invocation request from the model.
 */
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  /** Unique ID for this tool call (from API) */
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a tool.
 */
export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  /** Links to the ToolCallEvent */
  toolCallId: string;
  result: string;
  success: boolean;
  /** Execution time in milliseconds */
  duration?: number;
}

// ============================================================================
// File Events
// ============================================================================

/**
 * File read operation.
 * We store a hash instead of content to save space.
 */
export interface FileReadEvent extends BaseEvent {
  type: 'file_read';
  filePath: string;
  /** SHA-256 hash of file content at read time */
  contentHash: string;
  lineCount: number;
}

/**
 * File write/modification operation.
 */
export interface FileWriteEvent extends BaseEvent {
  type: 'file_write';
  filePath: string;
  diffId: string;
  changeType: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

// ============================================================================
// Diff Events
// ============================================================================

/**
 * Diff created and pending user review.
 */
export interface DiffCreatedEvent extends BaseEvent {
  type: 'diff_created';
  diffId: string;
  filePath: string;
  originalContent: string;
  newContent: string;
}

/**
 * User accepted a pending diff.
 */
export interface DiffAcceptedEvent extends BaseEvent {
  type: 'diff_accepted';
  diffId: string;
}

/**
 * User rejected a pending diff.
 */
export interface DiffRejectedEvent extends BaseEvent {
  type: 'diff_rejected';
  diffId: string;
}

// ============================================================================
// Web Search Events
// ============================================================================

/**
 * Web search performed via Tavily.
 */
export interface WebSearchEvent extends BaseEvent {
  type: 'web_search';
  query: string;
  resultCount: number;
  /** First few result titles for preview */
  resultsPreview: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/**
 * New conversation session created.
 */
export interface SessionCreatedEvent extends BaseEvent {
  type: 'session_created';
  title: string;
  model: string;
}

/**
 * Session title changed.
 */
export interface SessionRenamedEvent extends BaseEvent {
  type: 'session_renamed';
  oldTitle: string;
  newTitle: string;
}

/**
 * Model changed mid-conversation.
 */
export interface ModelChangedEvent extends BaseEvent {
  type: 'model_changed';
  oldModel: string;
  newModel: string;
}

// ============================================================================
// Context Import Events (for conversation forking/seeding)
// ============================================================================

/**
 * Context imported from a snapshot of another session.
 * Used when user starts a new conversation with prior context.
 */
export interface ContextImportedEvent extends BaseEvent {
  type: 'context_imported';
  sourceSessionId: string;
  sourceSnapshotId: string;
  summary: string;
  keyFacts: string[];
  filesModified: string[];
}

/**
 * Specific event cherry-picked from another session.
 * Used when user selects individual events to bring forward.
 */
export interface ContextImportedEventEvent extends BaseEvent {
  type: 'context_imported_event';
  originalEventId: string;
  originalSessionId: string;
  /** Copy of the original event data */
  eventData: ConversationEvent;
}

// ============================================================================
// Error Events
// ============================================================================

/**
 * Error that occurred during conversation.
 */
export interface ErrorEvent extends BaseEvent {
  type: 'error';
  errorType: 'api' | 'tool' | 'parse' | 'network';
  message: string;
  recoverable: boolean;
}

// ============================================================================
// Union Type
// ============================================================================

/**
 * All possible conversation events.
 */
export type ConversationEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileReadEvent
  | FileWriteEvent
  | DiffCreatedEvent
  | DiffAcceptedEvent
  | DiffRejectedEvent
  | WebSearchEvent
  | SessionCreatedEvent
  | SessionRenamedEvent
  | ModelChangedEvent
  | ContextImportedEvent
  | ContextImportedEventEvent
  | ErrorEvent;

/**
 * All possible event type strings.
 */
export type EventType = ConversationEvent['type'];

/**
 * Event type without id and sequence (for appending new events).
 * Uses distributive conditional type to properly handle the union.
 */
export type NewEvent<T extends ConversationEvent = ConversationEvent> =
  T extends any ? Omit<T, 'id' | 'sequence'> : never;

/**
 * Helper type for creating new events with proper type inference.
 */
export type NewEventOf<T extends EventType> = NewEvent<Extract<ConversationEvent, { type: T }>>;

// ============================================================================
// Type Guards
// ============================================================================

export function isUserMessageEvent(event: ConversationEvent): event is UserMessageEvent {
  return event.type === 'user_message';
}

export function isAssistantMessageEvent(event: ConversationEvent): event is AssistantMessageEvent {
  return event.type === 'assistant_message';
}

export function isToolCallEvent(event: ConversationEvent): event is ToolCallEvent {
  return event.type === 'tool_call';
}

export function isToolResultEvent(event: ConversationEvent): event is ToolResultEvent {
  return event.type === 'tool_result';
}

export function isDiffCreatedEvent(event: ConversationEvent): event is DiffCreatedEvent {
  return event.type === 'diff_created';
}

export function isDiffAcceptedEvent(event: ConversationEvent): event is DiffAcceptedEvent {
  return event.type === 'diff_accepted';
}

export function isDiffRejectedEvent(event: ConversationEvent): event is DiffRejectedEvent {
  return event.type === 'diff_rejected';
}

export function isContextImportedEvent(event: ConversationEvent): event is ContextImportedEvent {
  return event.type === 'context_imported';
}

/**
 * Events that represent user-visible messages (for UI rendering).
 */
export function isMessageEvent(
  event: ConversationEvent
): event is UserMessageEvent | AssistantMessageEvent {
  return event.type === 'user_message' || event.type === 'assistant_message';
}

/**
 * Events that should be included when building LLM context.
 */
export function isContextRelevantEvent(event: ConversationEvent): boolean {
  return [
    'user_message',
    'assistant_message',
    'tool_call',
    'tool_result',
    'context_imported',
    'context_imported_event'
  ].includes(event.type);
}
