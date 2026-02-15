/**
 * ContextBuilder - Decides what messages fit in the context window.
 *
 * Strategy:
 * 1. Count system prompt tokens (fixed cost per request)
 * 2. Remaining budget = total - output_reserve - system - safety
 * 3. Fill from most recent messages backward until budget exhausted
 * 4. If oldest messages were dropped, optionally inject a snapshot summary
 */

import { TokenCounter } from '../services/tokenCounter';
import { logger } from '../utils/logger';
import type { Message, MessageContent } from '../deepseekClient';

interface ModelBudget {
  totalContext: number;
  maxOutputTokens: number;
}

const MODEL_BUDGETS: Record<string, ModelBudget> = {
  'deepseek-chat': {
    totalContext: 128_000,
    maxOutputTokens: 8_192,
  },
  'deepseek-reasoner': {
    totalContext: 128_000,
    maxOutputTokens: 16_384,
  },
};

const DEFAULT_BUDGET: ModelBudget = {
  totalContext: 128_000,
  maxOutputTokens: 8_192,
};

/** When using estimation, reserve 10% as safety margin */
const ESTIMATION_SAFETY_MARGIN = 0.10;

export interface SnapshotSummary {
  summary: string;
  tokenCount: number;
  snapshotId: string;
}

export interface ContextResult {
  messages: Message[];
  tokenCount: number;
  budget: number;
  truncated: boolean;
  droppedCount: number;
  summaryInjected: boolean;
}

/** Extract plaintext from MessageContent for token counting */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') { return content; }
  return content
    .map(c => c.type === 'text' ? c.text : '[image]')
    .join('');
}

export class ContextBuilder {
  /** In-memory cache: eventId → token count. Dies on extension restart. */
  private _tokenCache = new Map<string, number>();

  constructor(private tokenCounter: TokenCounter) {}

  async build(
    messages: Message[],
    systemPrompt: string | undefined,
    model: string,
    snapshotSummary?: SnapshotSummary
  ): Promise<ContextResult> {
    const budget = MODEL_BUDGETS[model] ?? DEFAULT_BUDGET;

    const safetyMultiplier = this.tokenCounter.isExact
      ? 1.0
      : (1.0 - ESTIMATION_SAFETY_MARGIN);

    // Fixed cost: system prompt
    const systemTokens = systemPrompt
      ? this.tokenCounter.countMessage('system', systemPrompt)
      : 0;

    // Available budget for conversation messages
    const availableBudget = Math.floor(
      (budget.totalContext - budget.maxOutputTokens) * safetyMultiplier
    ) - systemTokens;

    // Count tokens for each message (with cache for event-sourced messages)
    let cacheHits = 0;
    let cacheMisses = 0;
    const messageCosts: Array<{ message: Message; tokens: number }> = [];
    for (const msg of messages) {
      const cached = msg.eventId ? this._tokenCache.get(msg.eventId) : undefined;
      if (cached !== undefined) {
        messageCosts.push({ message: msg, tokens: cached });
        cacheHits++;
      } else {
        const text = extractText(msg.content);
        const tokens = this.tokenCounter.countMessage(msg.role, text);
        messageCosts.push({ message: msg, tokens });
        cacheMisses++;
        if (msg.eventId) {
          this._tokenCache.set(msg.eventId, tokens);
        }
      }
    }

    if (cacheHits > 0) {
      logger.debug(`[Context] Token cache: ${cacheHits} hits, ${cacheMisses} misses`);
    }

    // Fill from newest messages backward
    let usedTokens = 0;
    let cutoffIndex = messageCosts.length;

    for (let i = messageCosts.length - 1; i >= 0; i--) {
      if (usedTokens + messageCosts[i].tokens > availableBudget) {
        cutoffIndex = i + 1;
        break;
      }
      usedTokens += messageCosts[i].tokens;
      if (i === 0) { cutoffIndex = 0; }
    }

    // Adjust cutoff to avoid splitting tool-call / tool-result pairs.
    // If the first kept message is an orphaned tool result or an assistant
    // whose tool results were dropped, nudge the cutoff forward.
    let adjustedCutoff = cutoffIndex;
    while (adjustedCutoff < messageCosts.length) {
      const msg = messageCosts[adjustedCutoff].message;
      if (msg.role === 'tool' && msg.tool_call_id) {
        // Orphaned tool result — its parent assistant was dropped
        usedTokens -= messageCosts[adjustedCutoff].tokens;
        adjustedCutoff++;
      } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Check if all its tool results are still in the kept portion
        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
        let nextIdx = adjustedCutoff + 1;
        while (nextIdx < messageCosts.length) {
          const next = messageCosts[nextIdx].message;
          if (next.role === 'tool' && next.tool_call_id && expectedIds.has(next.tool_call_id)) {
            expectedIds.delete(next.tool_call_id);
            nextIdx++;
          } else {
            break;
          }
        }
        if (expectedIds.size > 0) {
          // Some tool results are missing — drop this assistant + remaining tool results
          for (let k = adjustedCutoff; k < nextIdx; k++) {
            usedTokens -= messageCosts[k].tokens;
          }
          adjustedCutoff = nextIdx;
        } else {
          break; // Clean boundary
        }
      } else {
        break; // Regular message — boundary is clean
      }
    }

    const includedMessages = messageCosts.slice(adjustedCutoff).map(mc => mc.message);
    const droppedCount = adjustedCutoff;

    // If messages were dropped, inject snapshot summary
    let summaryInjected = false;
    if (droppedCount > 0 && snapshotSummary) {
      // Use cached count if available, otherwise use pre-computed count from snapshot
      const summaryTokens = this._tokenCache.get(snapshotSummary.snapshotId)
        ?? snapshotSummary.tokenCount;
      this._tokenCache.set(snapshotSummary.snapshotId, summaryTokens);

      if (usedTokens + summaryTokens <= availableBudget) {
        includedMessages.unshift({
          role: 'user',
          content: `[Previous conversation context]\n${snapshotSummary.summary}`
        });
        includedMessages.splice(1, 0, {
          role: 'assistant',
          content: 'I understand the context from our earlier conversation. Continuing from where we left off.'
        });
        usedTokens += summaryTokens;
        summaryInjected = true;
      }
    }

    const result: ContextResult = {
      messages: includedMessages,
      tokenCount: usedTokens + systemTokens,
      budget: budget.totalContext - budget.maxOutputTokens,
      truncated: droppedCount > 0,
      droppedCount,
      summaryInjected,
    };

    logger.info(
      `[Context] ${result.tokenCount.toLocaleString()}/${result.budget.toLocaleString()} tokens` +
      ` | ${result.droppedCount} dropped` +
      (result.summaryInjected ? ' | summary injected' : '')
    );

    return result;
  }
}
