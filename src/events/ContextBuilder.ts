/**
 * ContextBuilder - Builds optimal LLM context from events and snapshots
 *
 * The ContextBuilder is responsible for constructing the conversation
 * history that gets sent to the LLM. It:
 * - Uses snapshots to compress old history
 * - Includes recent events in full
 * - Respects token budgets
 * - Handles imported context from other sessions
 */

import { EventStore } from './EventStore';
import { SnapshotManager, Snapshot } from './SnapshotManager';
import {
  ConversationEvent,
  isUserMessageEvent,
  isAssistantMessageEvent,
  isToolResultEvent,
  isContextImportedEvent
} from './EventTypes';

/**
 * Message format for LLM context.
 */
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** For tool messages, the tool call ID */
  toolCallId?: string;
}

/**
 * Complete context package for LLM API call.
 */
export interface LLMContext {
  /** System prompt with any context additions */
  systemPrompt: string;
  /** Conversation messages */
  messages: LLMMessage[];
  /** Estimated total tokens */
  tokenEstimate: number;
  /** Whether a snapshot was used */
  usedSnapshot: boolean;
  /** Events not included due to budget constraints */
  truncatedEventCount: number;
}

export class ContextBuilder {
  private eventStore: EventStore;
  private snapshotManager: SnapshotManager;

  // Configuration
  private readonly MAX_CONTEXT_TOKENS: number;
  private readonly CHARS_PER_TOKEN: number;

  constructor(
    eventStore: EventStore,
    snapshotManager: SnapshotManager,
    options?: {
      maxContextTokens?: number;
      charsPerToken?: number;
    }
  ) {
    this.eventStore = eventStore;
    this.snapshotManager = snapshotManager;

    // Default: 16K tokens max, ~4 chars per token estimate
    this.MAX_CONTEXT_TOKENS = options?.maxContextTokens ?? 16000;
    this.CHARS_PER_TOKEN = options?.charsPerToken ?? 4;
  }

  /**
   * Build optimal context for LLM given token budget.
   *
   * Strategy:
   * 1. Check for imported context (from forked sessions)
   * 2. Use latest snapshot if available
   * 3. Add recent events until budget exhausted
   * 4. Always prioritize user messages
   *
   * @param sessionId - Session to build context for
   * @param tokenBudget - Max tokens to use (default: MAX_CONTEXT_TOKENS)
   * @returns Complete context package
   */
  buildForLLM(sessionId: string, tokenBudget?: number): LLMContext {
    const budget = tokenBudget ?? this.MAX_CONTEXT_TOKENS;
    const snapshot = this.snapshotManager.getLatestSnapshot(sessionId);

    let usedTokens = 0;
    const messages: LLMMessage[] = [];
    let truncatedCount = 0;

    // Get all events for this session
    const allEvents = this.eventStore.getEvents(sessionId);

    // 1. Check for imported context at start of session
    const importedContext = allEvents.find(isContextImportedEvent);
    if (importedContext) {
      const contextMsg = this.formatImportedContext(importedContext);
      const contextTokens = this.estimateTokens(contextMsg);

      if (usedTokens + contextTokens <= budget) {
        messages.push({ role: 'user', content: contextMsg });
        messages.push({
          role: 'assistant',
          content: 'I understand the context from our previous conversation. How can I help you continue?'
        });
        usedTokens += contextTokens + 30; // ~30 tokens for assistant response
      }
    }

    // 2. Handle snapshot if available
    if (snapshot) {
      const summaryMsg = this.formatSnapshotAsContext(snapshot);
      const summaryTokens = snapshot.tokenCount;

      if (usedTokens + summaryTokens <= budget) {
        messages.push({
          role: 'user',
          content: `[Previous conversation summary]\n${summaryMsg}`
        });
        messages.push({
          role: 'assistant',
          content: 'I understand the context. Let me continue helping you.'
        });
        usedTokens += summaryTokens + 20;
      }
    }

    // 3. Get events after snapshot (or all events if no snapshot)
    const fromSeq = snapshot?.upToSequence ?? 0;
    const recentEvents = this.eventStore.getEvents(sessionId, fromSeq)
      // Filter out context_imported events (already handled above)
      .filter(e => e.type !== 'context_imported' && e.type !== 'context_imported_event');

    // 4. Convert events to messages, respecting budget
    const { addedMessages, addedTokens, skippedCount } = this.eventsToMessages(
      recentEvents,
      budget - usedTokens
    );

    messages.push(...addedMessages);
    usedTokens += addedTokens;
    truncatedCount = skippedCount;

    return {
      systemPrompt: this.buildSystemPrompt(snapshot),
      messages,
      tokenEstimate: usedTokens,
      usedSnapshot: snapshot !== null,
      truncatedEventCount: truncatedCount
    };
  }

  /**
   * Format imported context for LLM.
   */
  private formatImportedContext(event: ConversationEvent): string {
    if (event.type !== 'context_imported') return '';

    let context = `[Context from previous conversation]\n\n`;
    context += event.summary + '\n\n';

    if (event.keyFacts.length > 0) {
      context += 'Key points established:\n';
      context += event.keyFacts.map(f => `- ${f}`).join('\n');
      context += '\n\n';
    }

    if (event.filesModified.length > 0) {
      context += 'Files previously modified:\n';
      context += event.filesModified.map(f => `- ${f}`).join('\n');
    }

    return context;
  }

  /**
   * Format snapshot summary for LLM context.
   */
  private formatSnapshotAsContext(snapshot: Snapshot): string {
    let context = snapshot.summary + '\n\n';

    if (snapshot.keyFacts.length > 0) {
      context += 'Key facts established:\n';
      context += snapshot.keyFacts.map(f => `- ${f}`).join('\n');
      context += '\n\n';
    }

    if (snapshot.filesModified.length > 0) {
      context += 'Files modified in this session:\n';
      context += snapshot.filesModified.map(f => `- ${f}`).join('\n');
    }

    return context;
  }

  /**
   * Convert events to LLM messages, respecting token budget.
   */
  private eventsToMessages(
    events: ConversationEvent[],
    tokenBudget: number
  ): {
    addedMessages: LLMMessage[];
    addedTokens: number;
    skippedCount: number;
  } {
    const messages: LLMMessage[] = [];
    let tokenCount = 0;
    let skippedCount = 0;

    for (const event of events) {
      const msg = this.eventToMessage(event);
      if (!msg) continue;

      const msgTokens = this.estimateTokens(msg.content);

      // Always include user messages if possible
      if (event.type === 'user_message') {
        if (tokenCount + msgTokens <= tokenBudget) {
          messages.push(msg);
          tokenCount += msgTokens;
        } else {
          skippedCount++;
        }
        continue;
      }

      // For other events, skip if over budget
      if (tokenCount + msgTokens > tokenBudget) {
        skippedCount++;
        continue;
      }

      messages.push(msg);
      tokenCount += msgTokens;
    }

    return { addedMessages: messages, addedTokens: tokenCount, skippedCount };
  }

  /**
   * Convert a single event to an LLM message.
   */
  private eventToMessage(event: ConversationEvent): LLMMessage | null {
    switch (event.type) {
      case 'user_message':
        return { role: 'user', content: event.content };

      case 'assistant_message':
        return { role: 'assistant', content: event.content };

      case 'tool_result':
        // Truncate long tool results
        const truncatedResult = event.result.length > 2000
          ? event.result.substring(0, 2000) + '\n...[truncated]'
          : event.result;
        return {
          role: 'tool',
          content: truncatedResult,
          toolCallId: event.toolCallId
        };

      // Events that don't need to be in LLM context
      case 'assistant_reasoning':
      case 'tool_call': // Tool calls are represented by assistant messages with tool_calls
      case 'file_read':
      case 'file_write':
      case 'diff_created':
      case 'diff_accepted':
      case 'diff_rejected':
      case 'web_search':
      case 'session_created':
      case 'session_renamed':
      case 'model_changed':
      case 'error':
      case 'context_imported':
      case 'context_imported_event':
        return null;

      default:
        return null;
    }
  }

  /**
   * Build system prompt, optionally enhanced with snapshot info.
   */
  private buildSystemPrompt(snapshot: Snapshot | null): string {
    let prompt = '';

    if (snapshot && snapshot.filesModified.length > 0) {
      prompt += `Files you've modified in this conversation:\n`;
      prompt += snapshot.filesModified.map(f => `- ${f}`).join('\n');
      prompt += '\n\n';
    }

    return prompt;
  }

  /**
   * Estimate token count for a string.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  /**
   * Get just the messages without building full context.
   * Useful for compatibility with existing code.
   */
  getMessagesOnly(sessionId: string): LLMMessage[] {
    const events = this.eventStore.getEventsByType(
      sessionId,
      ['user_message', 'assistant_message']
    );

    return events
      .map(e => this.eventToMessage(e))
      .filter((m): m is LLMMessage => m !== null);
  }
}
