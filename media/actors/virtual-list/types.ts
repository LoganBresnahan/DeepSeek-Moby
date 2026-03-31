/**
 * Types for VirtualListActor
 *
 * The VirtualListActor manages a pool of MessageTurnActor instances,
 * rendering only visible turns and recycling actors as the user scrolls.
 */

import type { TurnRole, EditMode } from '../turn/types';

// ============================================
// Turn Data (source of truth for all turns)
// ============================================

/**
 * Complete turn data stored by the VirtualListActor.
 * This is the source of truth - actors are just views into this data.
 */
export interface TurnData {
  turnId: string;
  role: TurnRole;
  timestamp: number;
  model?: string;
  files?: string[];
  /** Event sequence number from backend (for fork API) */
  sequence?: number;

  /** Estimated or measured height in pixels */
  height: number;

  /** Whether height has been measured (vs estimated) */
  heightMeasured: boolean;

  /** Y offset from top of list (computed from preceding heights) */
  offsetTop: number;

  /** Whether this turn is currently visible */
  visible: boolean;

  /** Index in the turn list (0-based) */
  index: number;

  // ============================================
  // Content stored for reconstruction
  // ============================================

  /** Text segments content */
  textSegments: TextSegmentData[];

  /** Thinking iterations content */
  thinkingIterations: ThinkingIterationData[];

  /** Tool batches content */
  toolBatches: ToolBatchData[];

  /** Shell segments content */
  shellSegments: ShellSegmentData[];

  /** Pending files content */
  pendingFiles: PendingFileData[];

  /** Command approval widgets */
  commandApprovals: CommandApprovalData[];

  /** Drawing segments (images from phone drawing pad) */
  drawingSegments: DrawingSegmentData[];

  /** Whether streaming is active for this turn */
  isStreaming: boolean;

  /**
   * Order of content creation for proper reconstruction.
   * Each entry is { type, index } where index is the position in the respective array.
   */
  contentOrder: ContentOrderEntry[];
}

/**
 * Tracks the order in which content was added to a turn.
 * Used to restore content in the correct interleaved order.
 */
export interface ContentOrderEntry {
  type: 'text' | 'thinking' | 'tools' | 'shell' | 'pending' | 'approval' | 'drawing';
  index: number;
}

// ============================================
// Segment Data Types
// ============================================

export interface TextSegmentData {
  id: string;
  content: string;
  isContinuation: boolean;
  complete: boolean;
}

export interface ThinkingIterationData {
  index: number;
  content: string;
  complete: boolean;
  expanded: boolean;
}

export interface ToolBatchData {
  id: string;
  calls: ToolCallData[];
  expanded: boolean;
  complete: boolean;
}

export interface ToolCallData {
  id: string;
  name: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export interface ShellSegmentData {
  id: string;
  commands: ShellCommandData[];
  expanded: boolean;
  complete: boolean;
  /** Actor's internal segment ID when bound (for delegation) */
  actorSegmentId?: string;
}

export interface ShellCommandData {
  command: string;
  cwd?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  output?: string;
  success?: boolean;
}

export interface PendingFileData {
  id: string;
  filePath: string;
  fileName: string;
  diffId?: string;
  status: 'pending' | 'applied' | 'rejected' | 'superseded' | 'error';
  iteration: number;
  /** Edit mode at time of creation — preserved across virtual scroll re-binds */
  editMode: EditMode;
}

export interface CommandApprovalData {
  id: string;
  command: string;
  prefix: string;
  /** The specific sub-command that triggered the approval (for compound commands) */
  unknownSubCommand: string;
  status: 'pending' | 'allowed' | 'blocked';
  /** Whether the decision was persistent (Always Allow/Block) */
  persistent?: boolean;
  /** Actor's internal approval ID when bound */
  actorApprovalId?: string;
}

export interface DrawingSegmentData {
  id: string;
  imageDataUrl: string;
  timestamp: number;
}

// ============================================
// Visibility Range
// ============================================

export interface VisibleRange {
  /** First visible turn index */
  startIndex: number;
  /** Last visible turn index (inclusive) */
  endIndex: number;
  /** Scroll top position */
  scrollTop: number;
  /** Viewport height */
  viewportHeight: number;
}

// ============================================
// Pool Statistics
// ============================================

export interface PoolStats {
  /** Total turns in the list */
  totalTurns: number;
  /** Currently visible turns */
  visibleTurns: number;
  /** Actors in use (bound to visible turns) */
  actorsInUse: number;
  /** Actors in pool (available for reuse) */
  actorsInPool: number;
  /** Total actors created */
  totalActorsCreated: number;
}

// ============================================
// Configuration
// ============================================

export interface VirtualListConfig {
  /** Minimum pool size (pre-created actors) */
  minPoolSize?: number;
  /** Maximum pool size (actors kept when released) */
  maxPoolSize?: number;
  /** Default estimated height for unmeasured turns */
  defaultTurnHeight?: number;
  /** Overscan: extra turns to render above/below viewport */
  overscan?: number;
  /** Debounce delay for scroll handling (ms) */
  scrollDebounce?: number;
}

export const DEFAULT_CONFIG: Required<VirtualListConfig> = {
  minPoolSize: 5,
  maxPoolSize: 20,
  defaultTurnHeight: 0,
  overscan: 2,
  scrollDebounce: 16
};
