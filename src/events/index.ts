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
 * manager.startNewSession('My Chat', 'deepseek-chat');
 *
 * // Record events
 * manager.addMessageToCurrentSession('user', 'Hello');
 * ```
 */

// Main manager
export { ConversationManager } from './ConversationManager';
export type { Session, ConversationManagerOptions } from './ConversationManager';

// Event types
export * from './EventTypes';

// Snapshots
export { SnapshotManager, createLLMSummarizer } from './SnapshotManager';
export type { Snapshot, SnapshotContent, SummarizerFn, SummarizerChatFn } from './SnapshotManager';

// Low-level event store (usually not needed directly)
export { EventStore } from './EventStore';

// Schema migrations
export { runMigrations } from './migrations';

// Database wrapper (native SQLCipher)
export { Database } from './SqlJsWrapper';
