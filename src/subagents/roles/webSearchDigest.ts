/**
 * web-search-digest role — compresses verbose Tavily/SearXNG search
 * responses into a small ranked digest before they reach main context.
 *
 * Backend-agnostic: input is always a normalized `WebSearchResponse`
 * (Tavily and SearXNG both produce this shape — see
 * [src/clients/webSearchProvider.ts]). Threshold tuned for typical
 * 5–10 result payloads.
 */

import type { WebSearchResponse } from '../../clients/webSearchProvider';
import type { SubagentRole, SubagentTaskContext } from '../types';

const THRESHOLD_RESULT_COUNT = 3;
const THRESHOLD_TOTAL_BYTES = 1500;
const MAX_DIGEST_RESULTS = 5;

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

export const webSearchDigestRole: SubagentRole<WebSearchResponse, WebSearchDigestOutput> = {
  name: 'web-search-digest',

  shouldRoute(input) {
    if (input.results.length > THRESHOLD_RESULT_COUNT) return true;
    const totalBytes = input.results.reduce((sum, r) => sum + r.content.length, 0);
    return totalBytes > THRESHOLD_TOTAL_BYTES;
  },

  buildSystemPrompt(taskContext) {
    const taskLine = taskContext.recentUserPrompt
      ? `The user's current task: "${truncate(taskContext.recentUserPrompt, 500)}"`
      : `The user's task is unspecified — rank by general informativeness.`;
    return [
      'You are a search-result digester. Pick the few results most relevant to the user\'s task. For each, give a 2-sentence snippet and a 1-sentence reason it matters.',
      taskLine,
      'Respond with JSON ONLY, matching this schema:',
      '{',
      '  "rankedResults": Array<{ "title": string, "url": string, "snippet": string, "reason": string }>,',
      '  "refinedAnswer"?: string,',
      '  "discardedCount": number',
      '}',
      `Include at most ${MAX_DIGEST_RESULTS} entries in rankedResults. discardedCount = total input results minus rankedResults.length.`
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
