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

  /** Get concatenated content of all active plans for system prompt injection */
  async getActivePlansContext(): Promise<string> {
    const dir = this.getPlansDir();
    if (!dir) return '';

    const activePlans = this._plans.filter(p => p.active);
    if (activePlans.length === 0) return '';

    const sections: string[] = [];
    for (const plan of activePlans) {
      const filePath = vscode.Uri.joinPath(dir, plan.name);
      try {
        const content = await vscode.workspace.fs.readFile(filePath);
        const text = Buffer.from(content).toString('utf-8').trim();
        if (text) {
          sections.push(`## ${plan.name}\n${text}`);
        }
      } catch {
        logger.warn(`[PlanManager] Failed to read plan: ${plan.name}`);
      }
    }

    if (sections.length === 0) return '';

    return `\n--- ACTIVE PLANS ---\nThe following plans describe the user's goals and approach. Follow them when relevant:\n\n${sections.join('\n\n')}\n--- END PLANS ---\n`;
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
