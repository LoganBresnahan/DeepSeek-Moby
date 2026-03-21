/**
 * SavedPromptManager — CRUD for saved system prompts stored in SQLite.
 *
 * Prompts are stored in the `saved_prompts` table. At most one prompt
 * has `is_active = 1`, which is the prompt used for API requests.
 * If no prompt is active, the hardcoded default is used.
 */

import { Database } from '../events/SqlJsWrapper';
import { logger } from '../utils/logger';

export interface SavedPrompt {
  id: number;
  name: string;
  content: string;
  model: string | null;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export class SavedPromptManager {
  constructor(private readonly db: Database) {}

  /**
   * Get all saved prompts, newest first.
   */
  getAll(): SavedPrompt[] {
    const rows = this.db.prepare(
      'SELECT * FROM saved_prompts ORDER BY updated_at DESC'
    ).all() as any[];
    return rows.map(r => this.rowToPrompt(r));
  }

  /**
   * Get a single prompt by ID.
   */
  getById(id: number): SavedPrompt | null {
    const row = this.db.prepare(
      'SELECT * FROM saved_prompts WHERE id = ?'
    ).get(id) as any;
    return row ? this.rowToPrompt(row) : null;
  }

  /**
   * Get the currently active prompt, or null if none.
   */
  getActive(): SavedPrompt | null {
    const row = this.db.prepare(
      'SELECT * FROM saved_prompts WHERE is_active = 1'
    ).get() as any;
    return row ? this.rowToPrompt(row) : null;
  }

  /**
   * Get the active prompt content, or empty string if none.
   */
  getActiveContent(): string {
    const active = this.getActive();
    return active ? active.content : '';
  }

  /**
   * Save a new prompt and optionally set it as active.
   */
  save(name: string, content: string, model?: string, setActive = true): SavedPrompt {
    const now = Date.now();

    if (setActive) {
      this.clearActive();
    }

    this.db.prepare(
      'INSERT INTO saved_prompts (name, content, model, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, content, model || null, setActive ? 1 : 0, now, now);

    // Get the inserted row
    const row = this.db.prepare(
      'SELECT * FROM saved_prompts WHERE rowid = last_insert_rowid()'
    ).get() as any;

    logger.info(`[SavedPromptManager] Saved prompt "${name}" (id=${row.id}, active=${setActive})`);
    return this.rowToPrompt(row);
  }

  /**
   * Update an existing prompt.
   */
  update(id: number, name: string, content: string, model?: string): void {
    const now = Date.now();
    this.db.prepare(
      'UPDATE saved_prompts SET name = ?, content = ?, model = ?, updated_at = ? WHERE id = ?'
    ).run(name, content, model || null, now, id);
    logger.info(`[SavedPromptManager] Updated prompt id=${id} "${name}"`);
  }

  /**
   * Delete a prompt by ID.
   */
  delete(id: number): void {
    this.db.prepare('DELETE FROM saved_prompts WHERE id = ?').run(id);
    logger.info(`[SavedPromptManager] Deleted prompt id=${id}`);
  }

  /**
   * Set a prompt as the active one (deactivates all others).
   */
  setActive(id: number): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('UPDATE saved_prompts SET is_active = 0 WHERE is_active = 1').run();
      this.db.prepare('UPDATE saved_prompts SET is_active = 1 WHERE id = ?').run(id);
    });
    txn();
    logger.info(`[SavedPromptManager] Set active prompt id=${id}`);
  }

  /**
   * Deactivate all prompts (revert to hardcoded default).
   */
  clearActive(): void {
    this.db.prepare('UPDATE saved_prompts SET is_active = 0 WHERE is_active = 1').run();
  }

  private rowToPrompt(row: any): SavedPrompt {
    return {
      id: row.id,
      name: row.name,
      content: row.content,
      model: row.model || null,
      is_active: row.is_active === 1,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}
