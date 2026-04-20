/**
 * TurnEvent — shared contract for structural turn events.
 *
 * Owned by both the extension (src/) and the webview (media/). See ADR 0003:
 * the events table is the sole source of truth for session history, and
 * structural events (code-blocks, iteration boundaries, drawings, approval
 * lifecycle) are authored extension-side. The webview consumes these events
 * for live rendering and restores; it no longer persists its own CQRS blob.
 *
 * Pure TypeScript: no runtime dependencies on vscode, DOM, or Node APIs.
 */

// ── Shell Command Types ──

export interface ShellCommand {
  command: string;
  description?: string;
}

export interface ShellResultData {
  output: string;
  success: boolean;
  executionTimeMs?: number;
}

// ── Tool Call Types ──

export interface ToolCallData {
  name: string;
  detail: string;
}

// ── Turn Event union ──

export type TurnEvent =
  // Text content
  | { type: 'text-append'; content: string; iteration: number; ts: number }
  | { type: 'text-finalize'; iteration: number; ts: number }

  // Thinking (R1 reasoning)
  | { type: 'thinking-start'; iteration: number; ts: number }
  | { type: 'thinking-content'; content: string; iteration: number; ts: number }
  | { type: 'thinking-complete'; iteration: number; ts: number }

  // Shell commands
  | { type: 'shell-start'; id: string; commands: ShellCommand[]; iteration: number; ts: number }
  | { type: 'shell-complete'; id: string; results: ShellResultData[]; ts: number }

  // Command approval
  | { type: 'approval-created'; id: string; command: string; prefix: string; shellId: string; ts: number }
  | { type: 'approval-resolved'; id: string; decision: 'allowed' | 'blocked'; persistent: boolean; ts: number }

  // File modifications (from shell or diff engine)
  | { type: 'file-modified'; path: string; status: string; editMode?: string; causedBy?: string; ts: number }

  // Tool calls (Chat model)
  | { type: 'tool-batch-start'; tools: ToolCallData[]; ts: number }
  | { type: 'tool-batch-update'; tools: Array<ToolCallData & { status?: string }>; ts: number }
  | { type: 'tool-update'; index: number; status: string; ts: number }
  | { type: 'tool-batch-complete'; ts: number }

  // Code blocks (rendered separately from text)
  | { type: 'code-block'; language: string; content: string; file?: string; iteration: number; ts: number }

  // Drawing
  | { type: 'drawing'; imageDataUrl: string; ts: number }

  // Iteration boundary (R1 shell loop tick). Emitted at the end of each iteration
  // so restore can reconstruct per-iteration content/shell/reasoning grouping
  // without the heuristic in convertHistoryToEvents (see ADR 0003).
  | { type: 'iteration-end'; iteration: number; ts: number }

  // ADR 0003 Phase 3: synthesized at hydration time for turns whose only
  // assistant_message row is status='in_progress' (host died before finalization).
  // Never persisted — added to the returned stream so the renderer can show a
  // distinct "interrupted by shutdown" marker. Idempotent: two hydrations of the
  // same turn produce the same synthetic event without duplication.
  | { type: 'shutdown-interrupted'; iteration: number; ts: number };
