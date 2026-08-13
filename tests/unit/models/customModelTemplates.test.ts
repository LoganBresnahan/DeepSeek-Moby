/**
 * Stencil integrity.
 *
 * The stencils are what a user clicks in "Moby: Add Custom Model", so a broken
 * one ships a broken entry to someone who never edits JSON. The old
 * `moonshot-v1-128k` stencil was wrong on the model id, the limits, AND
 * `reasoningEcho` at the same time — and the last of those 400s on the SECOND
 * tool iteration, where a smoke test won't catch it.
 *
 * These tests can't check a stencil against a live API. What they can check is
 * that every stencil is structurally something Moby will actually accept, and
 * that the fields whose absence caused real bugs are present.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CUSTOM_MODEL_TEMPLATES } from '../../../src/models/customModelTemplates';
import { validateCustomModelEntry, getCapabilities, registerCustomModels, __resetCustomModelsForTests } from '../../../src/models/registry';

const TEMPLATES = CUSTOM_MODEL_TEMPLATES.map(t => [t.label, t] as const);

describe('custom-model stencils', () => {
  it('ships at least the surveyed providers', () => {
    expect(CUSTOM_MODEL_TEMPLATES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(TEMPLATES)('%s — passes the same validator user entries do', (_label, template) => {
    // A stencil that fails validation is silently dropped at load: the user
    // clicks Add, sees an entry in settings.json, and gets no model.
    expect(validateCustomModelEntry(template.entry)).toEqual({ ok: true });
  });

  it.each(TEMPLATES)('%s — id is unique across stencils', (_label, template) => {
    const ids = CUSTOM_MODEL_TEMPLATES.map(t => t.entry.id);
    expect(ids.filter(id => id === template.entry.id)).toHaveLength(1);
  });

  it.each(TEMPLATES)('%s — apiEndpoint matches the advertised description', (_label, template) => {
    // The quickPick shows `description` as the endpoint; if it disagrees with
    // the entry, the user picks a provider and silently gets another.
    expect(template.entry.apiEndpoint).toBe(template.description);
  });

  it.each(TEMPLATES.filter(([, t]) => t.endpointKind === 'local'))(
    '%s — local stencils declare a port matching their endpoint',
    (_label, template) => {
      expect(template.defaultPort).toBeDefined();
      expect(String(template.entry.apiEndpoint)).toContain(String(template.defaultPort));
    }
  );

  it.each(TEMPLATES.filter(([, t]) => t.endpointKind === 'hosted'))(
    '%s — hosted stencils declare contextWindow',
    (_label, template) => {
      // Omitting it silently falls back to 128,000. Harmless on a small local
      // model; wrong by an order of magnitude on every modern hosted one, and
      // invisible because nothing errors.
      expect(typeof template.entry.contextWindow).toBe('number');
    }
  );

  it.each(TEMPLATES.filter(([, t]) => t.entry.thinkingLevels))(
    '%s — reasoning stencils declare inline reasoning tokens',
    (_label, template) => {
      // A model that grades reasoning but reports `reasoningTokens: 'none'`
      // has its reasoning dropped on the legacy path.
      expect(template.entry.reasoningTokens).toBe('inline');
    }
  );

  it.each(TEMPLATES)('%s — max output never exceeds the context window', (_label, template) => {
    const ctx = template.entry.contextWindow as number | undefined;
    if (ctx === undefined) return;
    const cap = (template.entry.maxOutputTokensCap ?? template.entry.maxOutputTokens) as number;
    expect(cap).toBeLessThanOrEqual(ctx);
  });

  it.each(TEMPLATES)('%s — default max output leaves room for a conversation', (_label, template) => {
    // The K3 starvation bug: maxOutputTokens equal to contextWindow left zero
    // budget, every message was dropped, and the model answered anyway.
    const ctx = template.entry.contextWindow as number | undefined;
    if (ctx === undefined) return;
    expect(template.entry.maxOutputTokens as number).toBeLessThan(ctx * 0.9);
  });

  it('stays in sync with the package.json schema examples', () => {
    // Two surfaces show the same stencils: this array drives the quickPick,
    // the schema `examples` drive settings.json autocomplete. They drifted
    // silently before — four of six examples pointed at models the quickPick
    // no longer offered.
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'));
    const examples = pkg.contributes.configuration.properties['moby.customModels'].examples;
    expect(examples).toEqual(CUSTOM_MODEL_TEMPLATES.map(t => [t.entry]));
  });

  it('registers every stencil cleanly, end to end', () => {
    __resetCustomModelsForTests();
    const { loaded, errors } = registerCustomModels(CUSTOM_MODEL_TEMPLATES.map(t => t.entry));
    expect(errors).toEqual([]);
    expect(loaded).toBe(CUSTOM_MODEL_TEMPLATES.length);
    for (const t of CUSTOM_MODEL_TEMPLATES) {
      // Proves it registered rather than falling back to the default caps.
      expect(getCapabilities(t.entry.id as string).apiEndpoint).toBe(t.entry.apiEndpoint);
    }
    __resetCustomModelsForTests();
  });
});
