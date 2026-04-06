/**
 * Unit tests for PlanManager
 *
 * Tests plan CRUD, activation toggling, context generation,
 * and persistence of active-plan state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Working EventEmitter so onPlanState fires reach subscribers
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

// In-memory filesystem for plan files and config
const { fsStore } = vi.hoisted(() => ({
  fsStore: new Map<string, string>()
}));

// Helper: deterministic URI join
function joinUri(base: any, ...segments: string[]) {
  const basePath = typeof base === 'string' ? base : (base.fsPath || base.path || '');
  const joined = [basePath, ...segments].join('/');
  return { fsPath: joined, scheme: 'file', path: joined };
}

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    Uri: {
      file: vi.fn((p: string) => ({ fsPath: p, scheme: 'file', path: p })),
      parse: vi.fn((u: string) => ({ fsPath: u, scheme: 'file', path: u })),
      joinPath: vi.fn((...args: any[]) => joinUri(args[0], ...args.slice(1)))
    },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace', scheme: 'file', path: '/workspace' } }],
      fs: {
        readFile: vi.fn(async (uri: any) => {
          const key = uri.fsPath || uri.path;
          if (fsStore.has(key)) return Buffer.from(fsStore.get(key)!, 'utf-8');
          throw new Error(`File not found: ${key}`);
        }),
        writeFile: vi.fn(async (uri: any, content: any) => {
          const key = uri.fsPath || uri.path;
          fsStore.set(key, Buffer.from(content).toString('utf-8'));
        }),
        delete: vi.fn(async (uri: any) => {
          const key = uri.fsPath || uri.path;
          fsStore.delete(key);
        }),
        createDirectory: vi.fn().mockResolvedValue(undefined),
        readDirectory: vi.fn(async () => {
          // Return .md files from fsStore that are in .moby-plans/
          const prefix = '/workspace/.moby-plans/';
          const entries: [string, number][] = [];
          for (const key of fsStore.keys()) {
            if (key.startsWith(prefix) && key.endsWith('.md')) {
              const name = key.slice(prefix.length);
              if (!name.includes('/')) {
                entries.push([name, 1]); // FileType.File = 1
              }
            }
          }
          return entries;
        }),
        stat: vi.fn(async (uri: any) => {
          const key = uri.fsPath || uri.path;
          if (fsStore.has(key)) return { type: 1 }; // FileType.File
          throw new Error('File not found');
        })
      },
      openTextDocument: vi.fn().mockResolvedValue({ getText: vi.fn() })
    },
    window: {
      showTextDocument: vi.fn().mockResolvedValue(undefined),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), append: vi.fn(), show: vi.fn(),
        clear: vi.fn(), dispose: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), debug: vi.fn()
      }))
    }
  };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()
  }
}));

import { PlanManager } from '../../../src/providers/planManager';
import type { PlanFile } from '../../../src/providers/planManager';

describe('PlanManager', () => {
  let manager: PlanManager;

  beforeEach(() => {
    vi.clearAllMocks();
    fsStore.clear();
    manager = new PlanManager();
  });

  // ── Constructor ──

  describe('constructor', () => {
    it('should initialize with empty plan list', () => {
      expect(manager.getPlans()).toEqual([]);
      expect(manager.activePlanCount).toBe(0);
    });
  });

  // ── refresh ──

  describe('refresh', () => {
    it('should scan plan directory and emit state', async () => {
      // Put a plan file and config in the fs
      fsStore.set('/workspace/.moby-plans/plan-auth.md', '# Auth Plan');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['plan-auth.md']
      }));

      const listener = vi.fn();
      manager.onPlanState(listener);

      await manager.refresh();

      expect(manager.getPlans()).toEqual([
        { name: 'plan-auth.md', active: true }
      ]);
      expect(listener).toHaveBeenCalledWith({
        plans: [{ name: 'plan-auth.md', active: true }]
      });
    });

    it('should return empty list when no workspace', async () => {
      // Temporarily remove workspaceFolders
      const vscodeModule = await import('vscode');
      const original = (vscodeModule.workspace as any).workspaceFolders;
      (vscodeModule.workspace as any).workspaceFolders = undefined;

      await manager.refresh();
      expect(manager.getPlans()).toEqual([]);

      (vscodeModule.workspace as any).workspaceFolders = original;
    });

    it('should mark plans inactive when not in config', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# A');
      fsStore.set('/workspace/.moby-plans/plan-b.md', '# B');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['plan-a.md']
      }));

      await manager.refresh();

      const plans = manager.getPlans();
      expect(plans.find(p => p.name === 'plan-a.md')!.active).toBe(true);
      expect(plans.find(p => p.name === 'plan-b.md')!.active).toBe(false);
    });

    it('should handle missing config file gracefully', async () => {
      fsStore.set('/workspace/.moby-plans/plan-x.md', '# X');
      // No .plans.json

      await manager.refresh();

      expect(manager.getPlans()).toEqual([
        { name: 'plan-x.md', active: false }
      ]);
    });
  });

  // ── getPlans ──

  describe('getPlans', () => {
    it('should return a copy of the plans array', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# A');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({ activePlans: [] }));
      await manager.refresh();

      const plans1 = manager.getPlans();
      const plans2 = manager.getPlans();
      expect(plans1).toEqual(plans2);
      expect(plans1).not.toBe(plans2); // different array references
    });
  });

  // ── togglePlan ──

  describe('togglePlan', () => {
    it('should toggle inactive plan to active', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# A');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({ activePlans: [] }));
      await manager.refresh();

      const listener = vi.fn();
      manager.onPlanState(listener);

      await manager.togglePlan('plan-a.md');

      const plan = manager.getPlans().find(p => p.name === 'plan-a.md');
      expect(plan!.active).toBe(true);
      expect(listener).toHaveBeenCalled();
    });

    it('should toggle active plan to inactive', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# A');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['plan-a.md']
      }));
      await manager.refresh();

      await manager.togglePlan('plan-a.md');

      const plan = manager.getPlans().find(p => p.name === 'plan-a.md');
      expect(plan!.active).toBe(false);
    });

    it('should save config after toggle', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# A');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({ activePlans: [] }));
      await manager.refresh();

      await manager.togglePlan('plan-a.md');

      // Config should be written to fsStore
      const savedConfig = JSON.parse(fsStore.get('/workspace/.moby-plans/.plans.json')!);
      expect(savedConfig.activePlans).toContain('plan-a.md');
    });

    it('should do nothing for non-existent plan', async () => {
      await manager.refresh();

      const listener = vi.fn();
      manager.onPlanState(listener);

      await manager.togglePlan('nonexistent.md');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── createPlan ──

  describe('createPlan', () => {
    it('should create a new plan file with .md extension', async () => {
      await manager.createPlan('my-plan');

      expect(fsStore.has('/workspace/.moby-plans/my-plan.md')).toBe(true);
      const content = fsStore.get('/workspace/.moby-plans/my-plan.md')!;
      expect(content).toContain('# my-plan');
      expect(content).toContain('## Goals');
    });

    it('should not double-add .md extension', async () => {
      await manager.createPlan('my-plan.md');

      expect(fsStore.has('/workspace/.moby-plans/my-plan.md')).toBe(true);
    });

    it('should auto-activate the new plan', async () => {
      await manager.createPlan('new-plan');

      const plan = manager.getPlans().find(p => p.name === 'new-plan.md');
      expect(plan).toBeDefined();
      expect(plan!.active).toBe(true);
    });

    it('should emit state after creation', async () => {
      const listener = vi.fn();
      manager.onPlanState(listener);

      await manager.createPlan('emit-test');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          plans: expect.arrayContaining([
            expect.objectContaining({ name: 'emit-test.md', active: true })
          ])
        })
      );
    });

    it('should open the plan in the editor', async () => {
      const vscodeModule = await import('vscode');

      await manager.createPlan('editor-test');

      expect(vscodeModule.workspace.openTextDocument).toHaveBeenCalled();
      expect(vscodeModule.window.showTextDocument).toHaveBeenCalled();
    });

    it('should open existing file instead of overwriting', async () => {
      // Pre-create the file
      fsStore.set('/workspace/.moby-plans/existing.md', '# Existing content');

      await manager.createPlan('existing');

      // Content should not be overwritten
      expect(fsStore.get('/workspace/.moby-plans/existing.md')).toBe('# Existing content');
    });
  });

  // ── deletePlan ──

  describe('deletePlan', () => {
    it('should remove the plan file and state entry', async () => {
      fsStore.set('/workspace/.moby-plans/to-delete.md', '# Delete me');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['to-delete.md']
      }));
      await manager.refresh();

      await manager.deletePlan('to-delete.md');

      expect(manager.getPlans().find(p => p.name === 'to-delete.md')).toBeUndefined();
    });

    it('should emit state after deletion', async () => {
      fsStore.set('/workspace/.moby-plans/del-emit.md', '# Del');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({ activePlans: [] }));
      await manager.refresh();

      const listener = vi.fn();
      manager.onPlanState(listener);

      await manager.deletePlan('del-emit.md');

      expect(listener).toHaveBeenCalledWith({ plans: [] });
    });

    it('should update saved config to remove deleted plan', async () => {
      fsStore.set('/workspace/.moby-plans/to-remove.md', '# Remove');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['to-remove.md']
      }));
      await manager.refresh();

      await manager.deletePlan('to-remove.md');

      const savedConfig = JSON.parse(fsStore.get('/workspace/.moby-plans/.plans.json')!);
      expect(savedConfig.activePlans).not.toContain('to-remove.md');
    });
  });

  // ── getActivePlansContext ──

  describe('getActivePlansContext', () => {
    it('should return empty string when no active plans', async () => {
      fsStore.set('/workspace/.moby-plans/inactive.md', '# Nope');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({ activePlans: [] }));
      await manager.refresh();

      const context = await manager.getActivePlansContext();
      expect(context).toBe('');
    });

    it('should concatenate active plan contents', async () => {
      fsStore.set('/workspace/.moby-plans/plan-a.md', '# Plan A content');
      fsStore.set('/workspace/.moby-plans/plan-b.md', '# Plan B content');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['plan-a.md', 'plan-b.md']
      }));
      await manager.refresh();

      const context = await manager.getActivePlansContext();

      expect(context).toContain('ACTIVE PLANS');
      expect(context).toContain('## plan-a.md');
      expect(context).toContain('# Plan A content');
      expect(context).toContain('## plan-b.md');
      expect(context).toContain('# Plan B content');
      expect(context).toContain('END PLANS');
    });

    it('should skip plans whose file cannot be read', async () => {
      fsStore.set('/workspace/.moby-plans/ok.md', '# OK');
      // readable.md exists in plan list but not in fsStore
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['ok.md', 'missing.md']
      }));
      // Manually add 'missing.md' to plans via refresh (it won't be in readDirectory)
      await manager.refresh();
      // Manually push the missing plan to test the read error path
      (manager as any)._plans.push({ name: 'missing.md', active: true });

      const context = await manager.getActivePlansContext();

      expect(context).toContain('# OK');
      expect(context).not.toContain('missing.md content');
    });

    it('should return empty string when no workspace', async () => {
      const vscodeModule = await import('vscode');
      const original = (vscodeModule.workspace as any).workspaceFolders;
      (vscodeModule.workspace as any).workspaceFolders = undefined;

      const context = await manager.getActivePlansContext();
      expect(context).toBe('');

      (vscodeModule.workspace as any).workspaceFolders = original;
    });
  });

  // ── activePlanCount ──

  describe('activePlanCount', () => {
    it('should return 0 when no plans', () => {
      expect(manager.activePlanCount).toBe(0);
    });

    it('should return count of active plans', async () => {
      fsStore.set('/workspace/.moby-plans/a.md', '# A');
      fsStore.set('/workspace/.moby-plans/b.md', '# B');
      fsStore.set('/workspace/.moby-plans/c.md', '# C');
      fsStore.set('/workspace/.moby-plans/.plans.json', JSON.stringify({
        activePlans: ['a.md', 'c.md']
      }));
      await manager.refresh();

      expect(manager.activePlanCount).toBe(2);
    });
  });

  // ── dispose ──

  describe('dispose', () => {
    it('should dispose the event emitter', () => {
      // Should not throw
      expect(() => manager.dispose()).not.toThrow();
    });
  });
});
