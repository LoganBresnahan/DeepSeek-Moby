/**
 * PlanManager
 *
 * Manages plan files in a `.moby-plans/` directory within the workspace.
 * Plans are markdown files that can be toggled active/inactive.
 * Active plan contents are injected into the system prompt.
 *
 * State is persisted in a `.moby-plans/.plans.json` file:
 *   { "activePlans": ["plan-auth.md", "plan-beta.md"] }
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';

// ============================================
// Constants (ADR 0009)
// ============================================

/** Per-plan body cap for the system-prompt (orientation) injection, so an
 *  over-long plan can't crowd out the rest of the prompt. ~1,500 chars. */
const DEFAULT_PLAN_MAX_CHARS = 1500;

/** Cap on remaining items listed in the terse recency reminder; the rest
 *  collapse to a "… (+K more)" line so the steering copy stays small. */
const MAX_REMAINING_SHOWN = 6;

// ============================================
// Types
// ============================================

export interface PlanFile {
  name: string;       // filename (e.g., "plan-auth.md")
  active: boolean;    // whether injected into system prompt
}

export interface PlanState {
  plans: PlanFile[];
}

interface PlanConfig {
  activePlans: string[];
}

// ============================================
// Events
// ============================================

interface PlanStateEvent {
  plans: PlanFile[];
}

// ============================================
// PlanManager
// ============================================

export class PlanManager {
  private readonly _onPlanState = new vscode.EventEmitter<PlanStateEvent>();
  readonly onPlanState = this._onPlanState.event;

  private _plans: PlanFile[] = [];

  constructor() {
    // Plans dir is computed on-demand from workspace
  }

  // ============================================
  // Public API
  // ============================================

  /** Scan the plans directory and emit current state */
  async refresh(): Promise<void> {
    await this.scanPlans();
    this.emitState();
  }

  /** Get the list of plans */
  getPlans(): PlanFile[] {
    return [...this._plans];
  }

  /** Toggle a plan's active state */
  async togglePlan(name: string): Promise<void> {
    const plan = this._plans.find(p => p.name === name);
    if (!plan) {
      logger.warn(`[PlanManager] Plan not found: ${name}`);
      return;
    }

    plan.active = !plan.active;
    await this.saveConfig();
    this.emitState();
    logger.info(`[PlanManager] ${plan.active ? 'Activated' : 'Deactivated'} plan: ${name}`);
  }

  /** Create a new plan file and open it in the editor */
  async createPlan(name: string): Promise<void> {
    const dir = await this.ensurePlansDir();
    if (!dir) return;

    // Ensure .md extension
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = vscode.Uri.joinPath(dir, filename);

    // Check if already exists
    try {
      await vscode.workspace.fs.stat(filePath);
      logger.warn(`[PlanManager] Plan already exists: ${filename}`);
      // Open existing file
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      return;
    } catch {
      // File doesn't exist, create it
    }

    const template = `# ${name.replace(/\.md$/, '')}\n\n<!-- Write your plan here. Active plans are injected into every request. -->\n\n## Goals\n\n- \n\n## Steps\n\n1. \n`;
    await vscode.workspace.fs.writeFile(filePath, Buffer.from(template, 'utf-8'));

    // Auto-activate the new plan
    this._plans.push({ name: filename, active: true });
    await this.saveConfig();
    this.emitState();

    // Open in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });

    logger.info(`[PlanManager] Created and activated plan: ${filename}`);
  }

  /** Delete a plan file */
  async deletePlan(name: string): Promise<void> {
    const dir = this.getPlansDir();
    if (!dir) return;

    const filePath = vscode.Uri.joinPath(dir, name);
    try {
      await vscode.workspace.fs.delete(filePath);
    } catch {
      // File may already be gone
    }

    this._plans = this._plans.filter(p => p.name !== name);
    await this.saveConfig();
    this.emitState();
    logger.info(`[PlanManager] Deleted plan: ${name}`);
  }

  /** Open a plan file in the editor */
  async openPlan(name: string): Promise<void> {
    const dir = this.getPlansDir();
    if (!dir) return;

    const filePath = vscode.Uri.joinPath(dir, name);
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    } catch (err) {
      logger.error(`[PlanManager] Failed to open plan: ${name} - ${err}`);
    }
  }

  /**
   * Get concatenated content of all active plans for system-prompt injection
   * (primacy / orientation — ADR 0009).
   *
   * `maxChars` caps each plan body so an over-long plan can't crowd out the rest
   * of the system prompt; the body is truncated with a marker pointing at the
   * full file. Default ~1,500 chars/plan. Pass `0`/`undefined` to disable the
   * cap (legacy behaviour). The terse "current step" steering reminder lives
   * separately — see `getActivePlanReminder()`.
   */
  async getActivePlansContext(opts?: { maxChars?: number }): Promise<string> {
    const dir = this.getPlansDir();
    if (!dir) return '';

    const activePlans = this._plans.filter(p => p.active);
    if (activePlans.length === 0) return '';

    const maxChars = opts?.maxChars ?? DEFAULT_PLAN_MAX_CHARS;

    const sections: string[] = [];
    for (const plan of activePlans) {
      const filePath = vscode.Uri.joinPath(dir, plan.name);
      try {
        const content = await vscode.workspace.fs.readFile(filePath);
        let text = Buffer.from(content).toString('utf-8').trim();
        if (text) {
          if (maxChars > 0 && text.length > maxChars) {
            text = `${text.slice(0, maxChars).trimEnd()}\n… (truncated; full plan in .moby-plans/${plan.name})`;
          }
          sections.push(`## ${plan.name}\n${text}`);
        }
      } catch {
        logger.warn(`[PlanManager] Failed to read plan: ${plan.name}`);
      }
    }

    if (sections.length === 0) return '';

    return `\n--- ACTIVE PLANS ---\nThe following plans describe the user's goals and approach. Follow them when relevant:\n\n${sections.join('\n\n')}\n--- END PLANS ---\n`;
  }

  /**
   * Get a terse "current step" reminder for the active plan, to pin at recency
   * (the tail of the last user message) so the step the model is on stays
   * salient next to its live action across a long agentic turn (ADR 0009).
   *
   * This is the *steering* copy — deliberately small. It carries the plan name,
   * a `step N of M` pointer, and the *remaining* (unchecked) items only — never
   * the prose, which lives once in the system prompt via `getActivePlansContext`.
   *
   * The pointer is derived from the plan's checklist:
   *   - GitHub-style `[ ]`/`[x]` items (optionally numbered) → current = first
   *     unchecked, M = total. This is the shape the agent ticks off as it works.
   *   - A plain numbered `## Steps` list with no checkboxes → degrades to
   *     `step 1 of M` with all items remaining (nothing marked done yet); as the
   *     model adds `[x]`, it transitions to checkbox parsing.
   *   - No parseable checklist → names the plan, emits no `step N of M` line.
   *
   * Returns '' when there is no active plan. Never throws.
   */
  async getActivePlanReminder(): Promise<string> {
    const dir = this.getPlansDir();
    if (!dir) return '';

    const activePlan = this._plans.find(p => p.active);
    if (!activePlan) return '';

    let text = '';
    try {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, activePlan.name));
      text = Buffer.from(content).toString('utf-8');
    } catch {
      logger.warn(`[PlanManager] Failed to read plan for reminder: ${activePlan.name}`);
      return '';
    }

    const steps = this.parsePlanSteps(text);
    const open = (body: string) => `\n--- ACTIVE PLAN (reminder) ---\n${body}\n--- END ACTIVE PLAN ---\n`;

    // No parseable checklist — name the plan, no pointer. Graceful, never an error.
    if (steps.length === 0) {
      return open(`active plan: ${activePlan.name} (no checklist — see the full plan in the system prompt)`);
    }

    const remaining = steps.filter(s => !s.done);
    const total = steps.length;

    // All steps checked — the model thinks it's done; remind it to verify/finish.
    if (remaining.length === 0) {
      return open(`${activePlan.name} — all ${total} steps checked\n(verify the work and finish, or see the full plan in the system prompt)`);
    }

    const current = steps.findIndex(s => !s.done) + 1; // 1-based position of first unchecked
    const shown = remaining.slice(0, MAX_REMAINING_SHOWN);
    const lines = shown.map(s => `[ ] ${s.position}. ${s.text}`);
    if (remaining.length > shown.length) {
      lines.push(`… (+${remaining.length - shown.length} more)`);
    }

    return open(
      `${activePlan.name} — step ${current} of ${total}\n` +
      `Remaining:\n${lines.join('\n')}\n` +
      `(full plan and completed steps are in the system prompt)`
    );
  }

  /**
   * Parse a plan body into ordered steps with done-state (ADR 0009).
   *
   * Prefers GitHub-style checkbox items anywhere in the body — `- [ ]`, `* [x]`,
   * `[ ]`, or numbered `1. [ ]` — because that is the live, agent-tickable shape.
   * If no checkbox exists but a plain numbered list does, every item is treated
   * as not-done (current = step 1); the model adding a `[x]` flips it to checkbox
   * parsing. Empty-bodied items (e.g. the `1. ` from the new-plan template) are
   * skipped so a blank template doesn't report a bogus pointer.
   */
  private parsePlanSteps(body: string): Array<{ position: number; text: string; done: boolean }> {
    const lines = body.split(/\r?\n/);

    // Pass 1: checkbox items (optionally bulleted/numbered). `[ ]` / `[x]` / `[X]`.
    const checkboxRe = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\[([ xX])\]\s+(.+?)\s*$/;
    const checkboxItems: Array<{ position: number; text: string; done: boolean }> = [];
    for (const line of lines) {
      const m = checkboxRe.exec(line);
      if (m) {
        checkboxItems.push({
          position: checkboxItems.length + 1,
          text: m[2].trim(),
          done: m[1] !== ' ',
        });
      }
    }
    if (checkboxItems.length > 0) return checkboxItems;

    // Pass 2: plain numbered list with non-empty text (no done-state available).
    const numberedRe = /^\s*\d+[.)]\s+(.+?)\s*$/;
    const numberedItems: Array<{ position: number; text: string; done: boolean }> = [];
    for (const line of lines) {
      const m = numberedRe.exec(line);
      if (m && m[1].trim()) {
        numberedItems.push({
          position: numberedItems.length + 1,
          text: m[1].trim(),
          done: false,
        });
      }
    }
    return numberedItems;
  }

  /** Number of active plans */
  get activePlanCount(): number {
    return this._plans.filter(p => p.active).length;
  }

  // ============================================
  // Private
  // ============================================

  private getPlansDir(): vscode.Uri | null {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return null;
    return vscode.Uri.joinPath(workspace.uri, '.moby-plans');
  }

  private async ensurePlansDir(): Promise<vscode.Uri | null> {
    const dir = this.getPlansDir();
    if (!dir) {
      logger.warn('[PlanManager] No workspace folder found');
      return null;
    }

    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // Already exists
    }

    return dir;
  }

  private async scanPlans(): Promise<void> {
    const dir = this.getPlansDir();
    if (!dir) {
      this._plans = [];
      return;
    }

    // Read config for active state
    const config = await this.loadConfig();
    const activeSet = new Set(config.activePlans);

    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      this._plans = entries
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
        .map(([name]) => ({
          name,
          active: activeSet.has(name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // Directory doesn't exist yet
      this._plans = [];
    }
  }

  private async loadConfig(): Promise<PlanConfig> {
    const dir = this.getPlansDir();
    if (!dir) return { activePlans: [] };

    const configPath = vscode.Uri.joinPath(dir, '.plans.json');
    try {
      const content = await vscode.workspace.fs.readFile(configPath);
      return JSON.parse(Buffer.from(content).toString('utf-8'));
    } catch {
      return { activePlans: [] };
    }
  }

  private async saveConfig(): Promise<void> {
    const dir = await this.ensurePlansDir();
    if (!dir) return;

    const config: PlanConfig = {
      activePlans: this._plans.filter(p => p.active).map(p => p.name)
    };

    const configPath = vscode.Uri.joinPath(dir, '.plans.json');
    await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify(config, null, 2), 'utf-8'));
  }

  private emitState(): void {
    this._onPlanState.fire({ plans: [...this._plans] });
  }

  dispose(): void {
    this._onPlanState.dispose();
  }
}
