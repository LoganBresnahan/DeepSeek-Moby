/**
 * web-search-digest role — compresses verbose Tavily/SearXNG search
 * responses into a small ranked digest before they reach main context.
 *
 * Backend-agnostic: input is always a normalized `WebSearchResponse`
 * (Tavily and SearXNG both produce this shape — see
 * [src/clients/webSearchProvider.ts]).
 *
 * Routing gate is the user's UI checkbox (`moby.subagents.web-search-digest`),
 * not an internal threshold. The role only refuses to route when there are
 * literally no results to digest. Output cap is the user-tunable
 * `moby.subagents.webSearchDigest.maxResults` setting (default 5).
 */

import type { WebSearchResponse } from '../../clients/webSearchProvider';
import type { SubagentRole, SubagentTaskContext } from '../types';

export const DEFAULT_MAX_DIGEST_RESULTS = 5;

export interface WebSearchDigestConfig {
  /** Output cap for the digest. The slider in the web-search popup
   *  writes `moby.subagents.webSearchDigest.maxResults`; the manager
   *  reads it and constructs the role with this value per route call. */
  maxResults: number;
}

export interface WebSearchDigestOutput {
  rankedResults: Array<{
    title: string;
    url: string;
    snippet: string;
    reason: string;
  }>;
  refinedAnswer?: string;
  discardedCount: number;
}

/** Factory — produces a role pinned to a specific maxResults value.
 *  Cheap to call per-route (just object construction); keeps the role
 *  itself pure and free of vscode imports for testability. */
export function makeWebSearchDigestRole(config: WebSearchDigestConfig): SubagentRole<WebSearchResponse, WebSearchDigestOutput> {
  const maxResults = clampMaxResults(config.maxResults);
  return {
    name: 'web-search-digest',

    shouldRoute(input) {
      // UI checkbox is the actual routing gate. Defensive floor only:
      // empty result sets are nothing to digest, so skip the round trip.
      return input.results.length > 0;
    },

    buildSystemPrompt(taskContext) {
      const taskLine = taskContext.recentUserPrompt
        ? `The user's current task: "${truncate(taskContext.recentUserPrompt, 500)}"`
        : `The user's task is unspecified — rank by general informativeness.`;
      return [
        `You are a search-result digester. Pick the ${maxResults} result(s) most relevant to the user's task. Be aggressive — drop everything else.`,
        taskLine,
        'Snippet rules: ≤1 sentence, ~100 characters, no fluff.',
        'Reason rules: 1 sentence stating WHY this matters for the task.',
        'Respond with JSON ONLY, matching this schema:',
        '{',
        '  "rankedResults": Array<{ "title": string, "url": string, "snippet": string, "reason": string }>,',
        '  "refinedAnswer"?: string,',
        '  "discardedCount": number',
        '}',
        `Include at most ${maxResults} entries in rankedResults. discardedCount = total input results minus rankedResults.length.`
      ].join('\n');
    },

    buildUserMessage(input) {
      const lines: string[] = [`Query: "${input.query}"`];
      if (input.answer) {
        lines.push(`Upstream answer: ${input.answer}`);
      }
      lines.push('', 'Results:');
      for (let i = 0; i < input.results.length; i++) {
        const r = input.results[i];
        lines.push(`[${i + 1}] ${r.title} (${r.url}) score=${r.score.toFixed(2)}`);
        lines.push(r.content);
        lines.push('');
      }
      return lines.join('\n');
    },

    parse(rawJson) {
      if (!rawJson || typeof rawJson !== 'object') return null;
      const obj = rawJson as Record<string, unknown>;
      if (!Array.isArray(obj.rankedResults)) return null;
      if (typeof obj.discardedCount !== 'number') return null;

      const rankedResults: WebSearchDigestOutput['rankedResults'] = [];
      for (const item of obj.rankedResults) {
        if (!item || typeof item !== 'object') return null;
        const it = item as Record<string, unknown>;
        if (typeof it.title !== 'string') return null;
        if (typeof it.url !== 'string') return null;
        if (typeof it.snippet !== 'string') return null;
        if (typeof it.reason !== 'string') return null;
        rankedResults.push({
          title: it.title,
          url: it.url,
          snippet: it.snippet,
          reason: it.reason
        });
      }

      const refinedAnswer = typeof obj.refinedAnswer === 'string' ? obj.refinedAnswer : undefined;

      return {
        rankedResults,
        refinedAnswer,
        discardedCount: obj.discardedCount
      };
    },

    formatForMain(output, originalInput) {
      const lines: string[] = [`Web search results for: "${originalInput.query}"`];
      lines.push('─'.repeat(50));
      if (output.refinedAnswer) {
        lines.push('');
        lines.push(`Summary: ${output.refinedAnswer}`);
      }
      lines.push('');
      for (const result of output.rankedResults) {
        lines.push(`**${result.title}**`);
        lines.push(`URL: ${result.url}`);
        lines.push(result.snippet);
        lines.push(`Why relevant: ${result.reason}`);
        lines.push('');
      }
      if (output.discardedCount > 0) {
        const total = output.rankedResults.length + output.discardedCount;
        lines.push(`(Subagent considered ${total} results; ${output.discardedCount} omitted as less relevant.)`);
      }
      return lines.join('\n');
    }
  };
}

function clampMaxResults(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 20) return 20;
  return Math.floor(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
