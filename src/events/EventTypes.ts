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
  /** CQRS turn events — full ordered event log for this turn's content.
   *  When present, history restore uses these instead of reconstructing from fragments.
   *  ADR 0003 Phase 3 retires this field in favor of structural_turn_event rows. */
  turnEvents?: Array<Record<string, unknown>>;
  /** ADR 0003 Phase 2: lifecycle status. Absence is treated as 'complete' for
   *  events written before this field existed. An 'in_progress' row is a
   *  placeholder written at turn start; on clean completion a new row with
   *  status='complete' supersedes it. 'interrupted' marks a turn whose process
   *  died between placeholder and completion. */
  status?: 'in_progress' | 'complete' | 'interrupted';
  /** ADR 0003 Phase 2: correlation id shared by all events belonging to the
   *  same turn (placeholder, structural_turn_event rows, final complete row).
   *  Hydration groups rows by this id to resolve which assistant_message is
   *  authoritative for a given turn. */
  turnId?: string;
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

// ============================================================================
// File Write Events
// ============================================================================

/**
 * File written/modified during conversation.
 */
export interface FileWriteEvent extends BaseEvent {
  type: 'file_write';
  filePath: string;
}

// ============================================================================
// Context Events
// ============================================================================

/**
 * Context imported from a previous session.
 */
export interface ContextImportedEvent extends BaseEvent {
  type: 'context_imported';
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
// Fork Events
// ============================================================================

/**
 * Session forked from another session.
 * Recorded as the first event after linked events in a forked session.
 */
export interface ForkCreatedEvent extends BaseEvent {
  type: 'fork_created';
  /** The session this fork was created from */
  parentSessionId: string;
  /** The sequence number in the parent where the fork happened */
  forkPointSequence: number;
}

// ============================================================================
// Structural Turn Event (ADR 0003 Phase 2)
// ============================================================================

/**
 * A single structural event within an assistant turn (text-append, shell-start,
 * iteration-end, etc.). Written incrementally during streaming so a crash mid-
 * turn still leaves the completed portion on disk. Correlated to the turn via
 * `turnId`. The event payload is the TurnEvent union from
 * shared/events/TurnEvent.ts.
 */
export interface StructuralTurnEvent extends BaseEvent {
  type: 'structural_turn_event';
  turnId: string;
  /** Monotonic index within the turn (0-based) for stable ordering during
   *  hydration. Protects against timestamp ties when events fire in the same ms. */
  indexInTurn: number;
  /** The TurnEvent payload. Kept as an opaque record here to avoid coupling
   *  events table schemas to the shared/events/TurnEvent union shape. */
  payload: Record<string, unknown>;
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
  | ContextImportedEvent
  | ErrorEvent
  | ForkCreatedEvent
  | StructuralTurnEvent;

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

// ============================================================================
// Type Guards
// ============================================================================

export function isUserMessageEvent(event: ConversationEvent): event is UserMessageEvent {
  return event.type === 'user_message';
}

export function isAssistantMessageEvent(event: ConversationEvent): event is AssistantMessageEvent {
  return event.type === 'assistant_message';
}

export function isDiffAcceptedEvent(event: ConversationEvent): event is DiffAcceptedEvent {
  return event.type === 'diff_accepted';
}

export function isForkCreatedEvent(event: ConversationEvent): event is ForkCreatedEvent {
  return event.type === 'fork_created';
}
