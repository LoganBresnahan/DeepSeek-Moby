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
import { getCapabilities } from '../models/registry';
import type { Message, MessageContent } from '../deepseekClient';

/** Context window used when a model doesn't declare one in the registry
 *  (e.g. a custom model). Real per-model windows — V3 = 128K, V4 = 1M —
 *  come from `getCapabilities(model).contextWindow`. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

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
    // Context window (and the output reserve) come from the registry so this
    // budget can't drift from the model's real capabilities. V4 = 1M, V3 = 128K.
    const caps = getCapabilities(model);
    const totalContext = caps.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
    const outputReserve = caps.maxOutputTokens;

    const safetyMultiplier = this.tokenCounter.isExact
      ? 1.0
      : (1.0 - ESTIMATION_SAFETY_MARGIN);

    // Fixed cost: system prompt
    const systemTokens = systemPrompt
      ? this.tokenCounter.countMessage('system', systemPrompt)
      : 0;

    // Available budget for conversation messages
    const availableBudget = Math.floor(
      (totalContext - outputReserve) * safetyMultiplier
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

      const ackContent = 'I understand the context from our earlier conversation. Continuing from where we left off.';
      const ackTokens = this.tokenCounter.countMessage('assistant', ackContent);
      const injectionCost = summaryTokens + ackTokens;

      if (usedTokens + injectionCost <= availableBudget) {
        includedMessages.unshift({
          role: 'user',
          content: `[Previous conversation context]\n${snapshotSummary.summary}`
        });
        includedMessages.splice(1, 0, {
          role: 'assistant',
          content: ackContent
        });
        usedTokens += injectionCost;
        summaryInjected = true;
      }
    }

    const result: ContextResult = {
      messages: includedMessages,
      tokenCount: usedTokens + systemTokens,
      budget: totalContext - outputReserve,
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
