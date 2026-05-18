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
import type { RouteResult, SubagentRole, SubagentTaskContext } from './types';

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

    const span = tracer.startSpan('subagent.route', role.name, {
      executionMode: 'async',
      data: { role: role.name, modelId }
    });
    const startedAt = performance.now();
    const userMessage = role.buildUserMessage(input);
    const systemPrompt = role.buildSystemPrompt(taskContext);

    let rawContent = '';
    try {
      const client = this.getClient(modelId);
      const messages: Message[] = [{ role: 'user', content: userMessage }];
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
          inputBytes: userMessage.length,
          validationResult: 'sub-error',
          durationMs: Math.round(performance.now() - startedAt)
        }
      });
      logger.warn(`[Subagent] ${role.name} call failed: ${message}. Falling back to raw input.`);
      return { routed: false, reason: 'sub-error' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.endSpan(span, {
        status: 'failed',
        error: `JSON parse error: ${message}`,
        data: {
          role: role.name,
          modelId,
          inputBytes: userMessage.length,
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
          inputBytes: userMessage.length,
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
        inputBytes: userMessage.length,
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
