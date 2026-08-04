/**
 * Availability checks for subagent roles — the same double gate the settings
 * picker offers and the router enforces, as a pure predicate other surfaces
 * can consult (the drawing server gates its freeform /draw page on this).
 *
 * Deliberately stateless: reads live config and the live registry on every
 * call, so per-request consumers are always current with no push machinery.
 */

import * as vscode from 'vscode';
import { getCapabilities } from '../models/registry';

/**
 * Is an `image-describe` subagent configured AND capable? True only when
 * `moby.subagents.image-describe` names a model whose registry entry declares
 * both `acceptsImages` and the role — the two gates `route()` checks, so a
 * true here means an attached image will actually be digested rather than
 * fall back to a placeholder.
 *
 * A stale id (model removed from `moby.customModels`) resolves through the
 * registry's fallback entry, which declares neither gate — correctly false.
 */
export function isImageDescribeAvailable(): boolean {
  const subs = vscode.workspace.getConfiguration('moby').get<Record<string, string>>('subagents') ?? {};
  const modelId = subs['image-describe'];
  if (!modelId || modelId === 'off') return false;
  const caps = getCapabilities(modelId);
  return caps.acceptsImages === true && (caps.subagentRoles ?? []).includes('image-describe');
}
