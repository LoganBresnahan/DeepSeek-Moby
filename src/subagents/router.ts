/**
 * SubagentRouter — dispatches role-specific digestion calls to a sub model.
 *
 * Sits between a tool's raw output and what the main model actually sees.
 * Per-modelId DeepSeekClient cache (lazy-created on first route, never
 * mutates the main client). Failure model: every fallback path returns
 * `{routed: false, reason}` so callers use the original raw output. The
 * main model never knows whether routing happened or whether it failed.
 * See [docs/plans/subagents.md].
 */

import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import type { Message } from '../deepseekClient';
import { tracer } from '../tracing';
import { logger } from '../utils/logger';
import { getCapabilities } from '../models/registry';
import type { RouteResult, SubagentMessageContent, SubagentRole, SubagentTaskContext } from './types';

/**
 * Size of a sub call's input for tracing. A content array has no `.length`
 * that means anything, so measure the parts: text by its own length, an image
 * by its encoded URL (a data URI's length is a fair proxy for payload size).
 */
function measureContentBytes(content: SubagentMessageContent): number {
  if (typeof content === 'string') return content.length;
  return content.reduce(
    (sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length),
    0
  );
}

/**
 * Parse a sub's response, tolerating the two ways models wrap JSON even when
 * told not to: a ```json fence, or prose around the object.
 *
 * This lives in the router, not in a role's `parse`, because the router does
 * the `JSON.parse` — a fenced response would fail here and never reach the
 * role. Vision backends are the worst offenders (many ignore `response_format`
 * entirely), but every role benefits.
 *
 * Throws like `JSON.parse` when nothing parses, so the caller's `parse-fail`
 * path is unchanged.
 */
export function tolerantJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch (firstError) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch { /* fall through to brace scan */ }
    }

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw firstError;
  }
}

export class SubagentRouter {
  private readonly clients = new Map<string, DeepSeekClient>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Single entry point. Decide whether to route, and if so, perform the
   *  call. Always swallows errors and returns `{routed: false, reason}` on
   *  any failure path so callers can use the raw input safely. */
  async route<TIn, TOut>(
    role: SubagentRole<TIn, TOut>,
    input: TIn,
    taskContext: SubagentTaskContext
  ): Promise<RouteResult> {
    const modelId = this.resolveModelId(role.name);
    if (!modelId) {
      return { routed: false, reason: 'off' };
    }

    if (!role.shouldRoute(input)) {
      return { routed: false, reason: 'below-threshold' };
    }

    const caps = getCapabilities(modelId);
    if (!caps.subagentRoles?.includes(role.name)) {
      logger.warn(
        `[Subagent] Model "${modelId}" is not declared for role "${role.name}". Falling back to raw input.`
      );
      return { routed: false, reason: 'no-model' };
    }

    // Declaring the role is not enough for an image role — a text-only backend
    // would 400 on the image_url block rather than degrade.
    if (role.requiresImageSupport && !caps.acceptsImages) {
      logger.warn(
        `[Subagent] Model "${modelId}" does not declare acceptsImages, which role "${role.name}" requires. Falling back to raw input.`
      );
      return { routed: false, reason: 'no-model' };
    }

    const span = tracer.startSpan('subagent.route', role.name, {
      executionMode: 'async',
      data: { role: role.name, modelId }
    });
    const startedAt = performance.now();
    // Multimodal roles (image-describe) supply a content array; text roles
    // keep returning a plain string.
    const userContent: SubagentMessageContent =
      role.buildUserContent?.(input) ?? role.buildUserMessage(input);
    const inputBytes = measureContentBytes(userContent);
    const systemPrompt = role.buildSystemPrompt(taskContext);

    let rawContent = '';
    try {
      const client = this.getClient(modelId);
      const messages: Message[] = [{ role: 'user', content: userContent }];
      // Force non-thinking on every sub call — digest roles never need
      // reasoning, and thinking-mode reasoning was the dominant latency
      // cost in Phase 1+polish observations (4-7s per call). For models
      // without sendThinkingParam, the option is silently ignored.
      const response = await client.chat(messages, systemPrompt, {
        jsonMode: true,
        thinkingMode: 'disabled'
      });
      rawContent = (response.content ?? '').trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.endSpan(span, {
        status: 'failed',
        error: message,
        data: {
          role: role.name,
          modelId,
          inputBytes,
          validationResult: 'sub-error',
          durationMs: Math.round(performance.now() - startedAt)
        }
      });
      logger.warn(`[Subagent] ${role.name} call failed: ${message}. Falling back to raw input.`);
      return { routed: false, reason: 'sub-error' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = tolerantJsonParse(rawContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.endSpan(span, {
        status: 'failed',
        error: `JSON parse error: ${message}`,
        data: {
          role: role.name,
          modelId,
          inputBytes,
          outputBytes: rawContent.length,
          validationResult: 'parse-fail',
          preview: rawContent.slice(0, 200),
          durationMs: Math.round(performance.now() - startedAt)
        }
      });
      return { routed: false, reason: 'parse-fail' };
    }

    const validated = role.parse(parsedJson);
    if (!validated) {
      tracer.endSpan(span, {
        status: 'failed',
        error: 'schema validation failed',
        data: {
          role: role.name,
          modelId,
          inputBytes,
          outputBytes: rawContent.length,
          validationResult: 'schema-fail',
          preview: rawContent.slice(0, 200),
          durationMs: Math.round(performance.now() - startedAt)
        }
      });
      return { routed: false, reason: 'schema-fail' };
    }

    const digest = role.formatForMain(validated, input);
    tracer.endSpan(span, {
      status: 'completed',
      data: {
        role: role.name,
        modelId,
        inputBytes,
        outputBytes: rawContent.length,
        digestBytes: digest.length,
        validationResult: 'ok',
        durationMs: Math.round(performance.now() - startedAt)
      }
    });
    return { routed: true, digest };
  }

  /** Resolve role → modelId from `moby.subagents.<roleName>`. Returns null
   *  when the setting is missing or set to "off". */
  private resolveModelId(roleName: string): string | null {
    const config = vscode.workspace.getConfiguration('moby');
    const subs = config.get<Record<string, string>>('subagents');
    const raw = subs?.[roleName];
    if (!raw || raw === 'off') return null;
    return raw;
  }

  /** Lazy per-modelId client cache. Each subagent backend gets its own
   *  DeepSeekClient — never mutate the main client's modelOverride. */
  private getClient(modelId: string): DeepSeekClient {
    let client = this.clients.get(modelId);
    if (!client) {
      client = new DeepSeekClient(this.context);
      client.setModel(modelId);
      this.clients.set(modelId, client);
    }
    return client;
  }
}
