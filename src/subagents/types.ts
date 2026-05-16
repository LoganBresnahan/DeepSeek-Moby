/**
 * Subagent routing — shared types.
 *
 * Roles delegate verbose tool outputs to a smaller model that produces a
 * focused digest. The router intercepts inside the tool's owning manager
 * (e.g. webSearchManager); main agent loop and main model never know
 * routing happened. See [docs/plans/subagents.md].
 */

export type SubagentRoleName =
  | 'web-search-digest'
  | 'search-digest'
  | 'file-summarize'
  | 'tool-classify'
  | 'image-describe';

/** What the user is currently working on. Roles use this to bias the digest
 *  (e.g. prefer auth-related search hits when the user is debugging an auth
 *  bug). Empty values are valid — the role falls back to general relevance. */
export interface SubagentTaskContext {
  /** The user's most recent prompt verbatim. Empty string if unavailable. */
  recentUserPrompt: string;
}

/** Why routing did not produce a digest. Useful for tests + tracing; the
 *  main model never sees these — every non-routed result silently passes
 *  through the raw tool output. */
export type RouteSkipReason =
  | 'off'              // setting absent or "off"
  | 'below-threshold'  // role.shouldRoute returned false
  | 'no-model'         // configured modelId not registered for this role
  | 'parse-fail'       // sub returned non-JSON
  | 'schema-fail'      // sub returned JSON that didn't match the role's schema
  | 'sub-error';       // sub call threw (network, API error, timeout)

/** Result of a routing call. `routed: false` carries no digest — the caller
 *  uses the original raw output. `routed: true` carries the digest string
 *  ready to substitute. */
export type RouteResult =
  | { routed: false; reason: RouteSkipReason }
  | { routed: true; digest: string };

/** A subagent role: pure functions plus a hand-rolled validator and a
 *  formatter for the digest. Roles know nothing about the router's transport. */
export interface SubagentRole<TInput, TOutput> {
  /** Stable identifier; matches the `moby.subagents.<name>` setting key. */
  readonly name: SubagentRoleName;

  /** True if the input is large enough to be worth routing. Cheap calls
   *  bypass the sub. */
  shouldRoute(input: TInput): boolean;

  /** System prompt for the sub call. Combine the role's template with the
   *  task context. */
  buildSystemPrompt(taskContext: SubagentTaskContext): string;

  /** User-message body for the sub call — the raw input serialized for the
   *  model. */
  buildUserMessage(input: TInput): string;

  /** Parse + validate the sub's JSON response. Returns `null` on schema
   *  failure; router falls back to raw input. */
  parse(rawJson: unknown): TOutput | null;

  /** Format the validated output as a string the main model will read in
   *  place of the raw input. */
  formatForMain(output: TOutput, originalInput: TInput): string;
}
