/**
 * Types for MessageTurnActor
 *
 * A "turn" represents a single user or assistant message in the conversation,
 * which may contain multiple interleaved content types:
 * - Text segments (can be split by tool/thinking insertions)
 * - Thinking iterations (chain-of-thought reasoning)
 * - Tool call batches
 * - Shell command executions
 * - Pending file changes
 */

// ============================================
// Text Segments
// ============================================

export interface TextSegment {
  id: string;
  content: string;
  containerId: string;
  isContinuation: boolean;
  complete: boolean;
}

// ============================================
// Thinking
// ============================================

export interface ThinkingIteration {
  index: number;
  content: string;
  containerId: string;
  complete: boolean;
}

// ============================================
// Tool Calls
// ============================================

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  detail: string;
  status: ToolStatus;
}

export interface ToolBatch {
  id: string;
  calls: ToolCall[];
  containerId: string;
  expanded: boolean;
  complete: boolean;
}

// ============================================
// Shell Execution
// ============================================

export type ShellCommandStatus = 'pending' | 'running' | 'done' | 'error';

export interface ShellCommand {
  command: string;
  cwd?: string;
  status: ShellCommandStatus;
  output?: string;
  success?: boolean;
}

export interface ShellSegment {
  id: string;
  commands: ShellCommand[];
  containerId: string;
  expanded: boolean;
  complete: boolean;
}

// ============================================
// Pending Files
// ============================================

export type PendingFileStatus = 'pending' | 'applied' | 'rejected' | 'superseded' | 'error' | 'deleted' | 'expired';
export type PendingFileAction = 'created' | 'modified' | 'deleted';

export interface PendingFile {
  id: string;
  filePath: string;
  fileName: string;
  diffId?: string;
  status: PendingFileStatus;
  /** What kind of filesystem change — created, modified, or deleted. */
  action?: PendingFileAction;
  iteration: number;
}

export interface PendingGroup {
  containerId: string;
  files: Map<string, PendingFile>;
  /** Edit mode at the time this group was created — determines display style permanently */
  editMode: EditMode;
}

// ============================================
// Turn Configuration
// ============================================

export type TurnRole = 'user' | 'assistant';
export type EditMode = 'manual' | 'ask' | 'auto';

/**
 * A user-turn attachment as the transcript renders it. Live sends carry the
 * data URL already (the composer's 512px archive rendition); restored turns
 * carry only {blobId, width, height} and the bytes arrive lazily via
 * requestAttachmentBlob when the turn becomes visible.
 */
export interface TurnAttachment {
  name: string;
  type: 'file' | 'image';
  /** Persisted images only — key for the lazy blob fetch. */
  blobId?: string;
  /** Pixel size of the stored rendition — reserves the box before bytes arrive. */
  width?: number;
  height?: number;
  mimeType?: string;
  /** Present once bytes are in hand (live send, cache hit, or fetch reply). */
  dataUrl?: string;
}

export interface TurnData {
  turnId: string;
  role: TurnRole;
  timestamp: number;
  model?: string;
  files?: string[];
  attachments?: TurnAttachment[];
  /** Event sequence number from backend (for fork API) */
  sequence?: number;
}

// ============================================
// Turn State (for publications)
// ============================================

export interface TurnState {
  turnId: string | null;
  role: TurnRole | null;
  isStreaming: boolean;
  hasInterleaved: boolean;
  textSegmentCount: number;
  thinkingIterationCount: number;
  toolBatchCount: number;
  shellSegmentCount: number;
}
