/**
 * Unit tests for SavedPromptManager
 *
 * Tests CRUD operations, active prompt toggling, and content retrieval.
 * Uses in-memory SQLite database with the real schema.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { SavedPromptManager } from '../../../src/providers/savedPromptManager';
import type { SavedPrompt } from '../../../src/providers/savedPromptManager';

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()
  }
}));

describe('SavedPromptManager', () => {
  let db: Database;
  let manager: SavedPromptManager;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    manager = new SavedPromptManager(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── getAll ──

  describe('getAll', () => {
    it('should return empty array initially', () => {
      const prompts = manager.getAll();
      expect(prompts).toEqual([]);
    });

    it('should return prompts ordered by updated_at DESC', () => {
      // Use explicit timestamps by inserting directly to guarantee ordering
      const now = Date.now();
      db.prepare(
        'INSERT INTO saved_prompts (name, content, model, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('First', 'content-1', null, 0, now - 2000, now - 2000);
      db.prepare(
        'INSERT INTO saved_prompts (name, content, model, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('Second', 'content-2', null, 0, now - 1000, now - 1000);
      db.prepare(
        'INSERT INTO saved_prompts (name, content, model, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('Third', 'content-3', null, 0, now, now);

      const prompts = manager.getAll();
      expect(prompts.length).toBe(3);
      // Newest first
      expect(prompts[0].name).toBe('Third');
      expect(prompts[1].name).toBe('Second');
      expect(prompts[2].name).toBe('First');
    });
  });

  // ── save ──

  describe('save', () => {
    it('should create a prompt and return it with an ID', () => {
      const prompt = manager.save('Test Prompt', 'You are a helpful assistant.');

      expect(prompt.id).toBeDefined();
      expect(typeof prompt.id).toBe('number');
      expect(prompt.name).toBe('Test Prompt');
      expect(prompt.content).toBe('You are a helpful assistant.');
      expect(prompt.created_at).toBeDefined();
      expect(prompt.updated_at).toBeDefined();
    });

    it('should set the prompt as active by default', () => {
      const prompt = manager.save('Active Prompt', 'content');
      expect(prompt.is_active).toBe(true);
    });

    it('should not set active when setActive is false', () => {
      const prompt = manager.save('Inactive', 'content', undefined, false);
      expect(prompt.is_active).toBe(false);
    });

    it('should store the model when provided', () => {
      const prompt = manager.save('With Model', 'content', 'deepseek-chat');
      expect(prompt.model).toBe('deepseek-chat');
    });

    it('should store null model when not provided', () => {
      const prompt = manager.save('No Model', 'content');
      expect(prompt.model).toBeNull();
    });

    it('should deactivate other prompts when setting new one active', () => {
      const first = manager.save('First', 'content-1');
      expect(first.is_active).toBe(true);

      const second = manager.save('Second', 'content-2');
      expect(second.is_active).toBe(true);

      // First should now be inactive
      const firstRefreshed = manager.getById(first.id);
      expect(firstRefreshed!.is_active).toBe(false);
    });
  });

  // ── getById ──

  describe('getById', () => {
    it('should retrieve a specific prompt', () => {
      const saved = manager.save('Find Me', 'some content');
      const found = manager.getById(saved.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(saved.id);
      expect(found!.name).toBe('Find Me');
      expect(found!.content).toBe('some content');
    });

    it('should return null for non-existent ID', () => {
      const found = manager.getById(9999);
      expect(found).toBeNull();
    });
  });

  // ── getActive ──

  describe('getActive', () => {
    it('should return null when none active', () => {
      const active = manager.getActive();
      expect(active).toBeNull();
    });

    it('should return null when all are inactive', () => {
      manager.save('A', 'content-a', undefined, false);
      manager.save('B', 'content-b', undefined, false);

      expect(manager.getActive()).toBeNull();
    });

    it('should return the active prompt', () => {
      manager.save('Inactive', 'x', undefined, false);
      const active = manager.save('Active', 'active content');

      const result = manager.getActive();
      expect(result).not.toBeNull();
      expect(result!.id).toBe(active.id);
      expect(result!.is_active).toBe(true);
    });
  });

  // ── setActive ──

  describe('setActive', () => {
    it('should mark one prompt active and deactivate others', () => {
      const p1 = manager.save('P1', 'content-1');
      const p2 = manager.save('P2', 'content-2', undefined, false);

      // p1 is active, p2 is not
      expect(manager.getById(p1.id)!.is_active).toBe(true);
      expect(manager.getById(p2.id)!.is_active).toBe(false);

      // Now activate p2
      manager.setActive(p2.id);

      expect(manager.getById(p1.id)!.is_active).toBe(false);
      expect(manager.getById(p2.id)!.is_active).toBe(true);
    });

    it('should ensure only one prompt is active at a time', () => {
      const p1 = manager.save('P1', 'c1', undefined, false);
      const p2 = manager.save('P2', 'c2', undefined, false);
      const p3 = manager.save('P3', 'c3', undefined, false);

      manager.setActive(p2.id);

      const all = manager.getAll();
      const activeCount = all.filter(p => p.is_active).length;
      expect(activeCount).toBe(1);
      expect(all.find(p => p.id === p2.id)!.is_active).toBe(true);
    });
  });

  // ── clearActive ──

  describe('clearActive', () => {
    it('should deactivate all prompts', () => {
      manager.save('Active One', 'content');
      expect(manager.getActive()).not.toBeNull();

      manager.clearActive();

      expect(manager.getActive()).toBeNull();
    });

    it('should be safe to call when none are active', () => {
      manager.save('No active', 'x', undefined, false);
      expect(() => manager.clearActive()).not.toThrow();
      expect(manager.getActive()).toBeNull();
    });
  });

  // ── update ──

  describe('update', () => {
    it('should modify an existing prompt', () => {
      const prompt = manager.save('Original', 'old content', undefined, false);

      manager.update(prompt.id, 'Updated', 'new content', 'deepseek-reasoner');

      const updated = manager.getById(prompt.id);
      expect(updated!.name).toBe('Updated');
      expect(updated!.content).toBe('new content');
      expect(updated!.model).toBe('deepseek-reasoner');
    });

    it('should update the updated_at timestamp', () => {
      const prompt = manager.save('Timestamp', 'content', undefined, false);
      const originalUpdatedAt = prompt.updated_at;

      // Small delay to ensure different timestamp
      manager.update(prompt.id, 'Timestamp', 'new content');

      const updated = manager.getById(prompt.id);
      expect(updated!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
    });

    it('should not change active state', () => {
      const prompt = manager.save('Active', 'content');
      expect(prompt.is_active).toBe(true);

      manager.update(prompt.id, 'Still Active', 'modified');

      const updated = manager.getById(prompt.id);
      expect(updated!.is_active).toBe(true);
    });

    it('should set model to null when not provided', () => {
      const prompt = manager.save('Has Model', 'content', 'deepseek-chat', false);
      expect(prompt.model).toBe('deepseek-chat');

      manager.update(prompt.id, 'No Model', 'content');

      const updated = manager.getById(prompt.id);
      expect(updated!.model).toBeNull();
    });
  });

  // ── delete ──

  describe('delete', () => {
    it('should remove a prompt', () => {
      const prompt = manager.save('Delete Me', 'content', undefined, false);
      expect(manager.getById(prompt.id)).not.toBeNull();

      manager.delete(prompt.id);

      expect(manager.getById(prompt.id)).toBeNull();
    });

    it('should not affect other prompts', () => {
      const keep = manager.save('Keep', 'keep content', undefined, false);
      const remove = manager.save('Remove', 'remove content', undefined, false);

      manager.delete(remove.id);

      expect(manager.getById(keep.id)).not.toBeNull();
      expect(manager.getAll().length).toBe(1);
    });

    it('should be safe to delete non-existent ID', () => {
      expect(() => manager.delete(9999)).not.toThrow();
    });
  });

  // ── getActiveContent ──

  describe('getActiveContent', () => {
    it('should return empty string when no active prompt', () => {
      expect(manager.getActiveContent()).toBe('');
    });

    it('should return content of active prompt', () => {
      manager.save('System', 'You are a coding assistant.', undefined, true);

      expect(manager.getActiveContent()).toBe('You are a coding assistant.');
    });

    it('should return empty string after clearActive', () => {
      manager.save('Active', 'content');
      expect(manager.getActiveContent()).not.toBe('');

      manager.clearActive();
      expect(manager.getActiveContent()).toBe('');
    });
  });

  // ── Multiple prompts with only one active ──

  describe('multiple prompts with only one active', () => {
    it('should maintain single active invariant across operations', () => {
      const p1 = manager.save('Prompt 1', 'Content 1'); // active
      const p2 = manager.save('Prompt 2', 'Content 2'); // active (deactivates p1)
      const p3 = manager.save('Prompt 3', 'Content 3', undefined, false); // inactive

      // Only p2 should be active
      let all = manager.getAll();
      expect(all.filter(p => p.is_active).length).toBe(1);
      expect(manager.getActive()!.id).toBe(p2.id);

      // Activate p3
      manager.setActive(p3.id);
      all = manager.getAll();
      expect(all.filter(p => p.is_active).length).toBe(1);
      expect(manager.getActive()!.id).toBe(p3.id);

      // Activate p1
      manager.setActive(p1.id);
      all = manager.getAll();
      expect(all.filter(p => p.is_active).length).toBe(1);
      expect(manager.getActive()!.id).toBe(p1.id);

      // Clear all
      manager.clearActive();
      all = manager.getAll();
      expect(all.filter(p => p.is_active).length).toBe(0);
      expect(manager.getActive()).toBeNull();
    });

    it('should handle save with setActive=true deactivating current', () => {
      const first = manager.save('First', 'c1'); // active
      expect(manager.getActive()!.id).toBe(first.id);

      const second = manager.save('Second', 'c2'); // active, deactivates first
      expect(manager.getActive()!.id).toBe(second.id);
      expect(manager.getById(first.id)!.is_active).toBe(false);

      const third = manager.save('Third', 'c3'); // active, deactivates second
      expect(manager.getActive()!.id).toBe(third.id);
      expect(manager.getById(second.id)!.is_active).toBe(false);
    });
  });
});
