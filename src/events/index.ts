/**
 * Event Sourcing System for Conversation Management
 *
 * This module provides a complete event-sourced conversation storage system
 * with snapshot optimization for long conversations.
 *
 * Main entry point: ConversationManager
 *
 * @example
 * ```typescript
 * import { ConversationManager } from './events';
 *
 * const manager = new ConversationManager(context);
 *
 * // Create a session
 * await manager.createSession('My Chat');
 *
 * // Record events
 * manager.recordUserMessage('Hello');
 * manager.recordAssistantMessage('Hi there!', 'deepseek-chat', 'stop');
 *
 * // Build context for LLM
 * const context = manager.buildLLMContext();
 * console.log(context.messages);
 * ```
 */

// Main manager
export { ConversationManager } from './ConversationManager';
export type { Session, ConversationManagerOptions } from './ConversationManager';

// Event types
export * from './EventTypes';

// Context building
export { ContextBuilder } from './ContextBuilder';
export type { LLMContext, LLMMessage } from './ContextBuilder';

// Snapshots
export { SnapshotManager, createExtractSummarizer } from './SnapshotManager';
export type { Snapshot, SnapshotContent, SummarizerFn } from './SnapshotManager';

// Low-level event store (usually not needed directly)
export { EventStore } from './EventStore';

// Database wrapper (sql.js based)
export { Database, initializeSqlJs } from './SqlJsWrapper';
