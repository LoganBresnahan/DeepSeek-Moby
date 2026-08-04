/**
 * Provider registry — one provider per trigger character.
 *
 * Pure (no DOM, no pub/sub) so trigger detection and the providers can be
 * tested without standing up the actor.
 */

import type { SuggestionProvider, TriggerChar } from './types';

export class ProviderRegistry {
  private readonly _byTrigger = new Map<TriggerChar, SuggestionProvider>();

  /** Registering a second provider for a trigger replaces the first. */
  register(provider: SuggestionProvider): void {
    this._byTrigger.set(provider.trigger, provider);
  }

  get(trigger: TriggerChar): SuggestionProvider | undefined {
    return this._byTrigger.get(trigger);
  }

  has(trigger: string): trigger is TriggerChar {
    return this._byTrigger.has(trigger as TriggerChar);
  }

  /** The trigger characters detection should watch for — registered ones only. */
  triggers(): TriggerChar[] {
    return Array.from(this._byTrigger.keys());
  }

  clear(): void {
    this._byTrigger.clear();
  }
}
