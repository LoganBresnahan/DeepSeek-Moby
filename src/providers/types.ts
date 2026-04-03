/**
 * Shared types for ChatProvider and extracted manager classes.
 *
 * These types define the event contracts used by vscode.EventEmitter<T>
 * for communication between extracted classes (Phase 0 of ChatProvider refactor).
 */

import * as vscode from 'vscode';

// ── Diff Types ──

/** Internal diff metadata tracked per code edit (owns vscode.Uri references) */
export interface DiffMetadata {
  proposedUri: vscode.Uri;
  originalUri: vscode.Uri;
  targetFilePath: string;
  code: string;
  language: string;
  timestamp: number;
  iteration: number;
  diffId: string;
  superseded?: boolean;
}

/** Serializable diff info sent to webview (no Uri objects) */
export interface DiffInfo {
  filePath: string;
  timestamp: number;
  status: 'pending' | 'applied' | 'rejected' | 'deleted' | 'expired';
  iteration: number;
  diffId: string;
  superseded: boolean;
  /** URI string for pending diffs (used by webview to identify diff tabs) */
  proposedUri?: string;
}

/** Payload for diff list updates sent to webview */
export interface DiffListChangedEvent {
  diffs: DiffInfo[];
  editMode: 'manual' | 'ask' | 'auto';
}

/** Payload for code application results */
export interface CodeAppliedEvent {
  success: boolean;
  error?: string;
  filePath?: string;
}

// ── Web Search Types ──

/** Web search mode: off (disabled), manual (user toggle only), auto (LLM decides) */
export type WebSearchMode = 'off' | 'manual' | 'auto';

/** Web search configuration */
export interface WebSearchSettings {
  creditsPerPrompt: number;
  searchDepth: 'basic' | 'advanced';
  cacheDuration: number;
  maxResultsPerSearch: number;
}

/** Payload for web search results (formatted context for system prompt) */
export interface WebSearchResultEvent {
  context: string;
}

// ── Settings Types ──

/** Full settings snapshot sent to webview */
export interface SettingsSnapshot {
  model: string;
  temperature: number;
  maxToolCalls: number;
  maxShellIterations: number;
  maxTokens: number;
  logLevel: string;
  webviewLogLevel: string;
  tracingEnabled: boolean;
  systemPrompt: string;
  autoSaveHistory: boolean;
  allowAllCommands: boolean;
  webSearch: {
    searchDepth: 'basic' | 'advanced';
    creditsPerPrompt: number;
    maxResultsPerSearch: number;
    cacheDuration: number;
    mode: WebSearchMode;
  };
}

// ── File Context Types ──

/** Payload for open files list */
export interface OpenFilesEvent {
  files: string[];
}

/** Payload for file search results */
export interface FileSearchResultsEvent {
  results: string[];
}

/** Payload for file content delivery */
export interface FileContentEvent {
  filePath: string;
  content: string;
}

// ── Request Orchestrator Types ──

/** Payload for start of streaming response */
export interface StartResponseEvent {
  isReasoner: boolean;
  correlationId?: string;
}

/** Payload for end of streaming response */
export interface EndResponseEvent {
  role: 'assistant';
  content: string;
  reasoning_content?: string;
  reasoning_iterations?: string[];
  content_iterations?: Array<{ text: string; iterationIndex: number }>;
  editMode: 'manual' | 'ask' | 'auto';
}

/** Payload for auto-continuation (reasoner model) */
export interface AutoContinuationEvent {
  count: number;
  max: number;
  reason: string;
}

/** Tool call detail for UI display */
export interface ToolDetail {
  name: string;
  detail: string;
  status: string;
}

/** Payload for individual tool call status update */
export interface ToolCallUpdateEvent {
  index: number;
  status: string;
  detail: string;
}

/** Payload for shell command execution notification */
export interface ShellExecutingEvent {
  commands: Array<{ command: string; description: string }>;
}

/** Payload for shell command results */
export interface ShellResultsEvent {
  results: Array<{ command: string; output: string; success: boolean }>;
}

// ── Diff Approval Types ──

/** Result of a blocking diff approval in ask mode */
export interface DiffApprovalResult {
  filePath: string;
  diffId: string;
  approved: boolean;
}

// ── Command Approval Types ──

/** Payload sent to webview when a command needs user approval */
export interface CommandApprovalRequiredEvent {
  command: string;
  prefix: string;
  /** The specific sub-command that triggered the approval (for compound commands) */
  unknownSubCommand: string;
}

/** Payload sent from webview when user responds to a command approval */
export interface CommandApprovalResponseEvent {
  command: string;
  decision: 'allowed' | 'blocked';
  persistent: boolean;
  prefix?: string;
}
