/**
 * WebviewLogBuffer
 *
 * Standalone ring buffer that captures webview log entries and syncs them
 * to the extension via postMessage. Completely independent from the tracer.
 *
 * - Buffer size: 5,000 entries
 * - Sync interval: 5s (offset 2.5s from tracer to avoid burst)
 * - Own message type: 'webviewLogs'
 */

import type { VSCodeAPI } from '../state/types';

/**
 * A single log entry captured from the webview.
 */
export interface WebviewLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
}

/** Maximum buffer size */
const MAX_BUFFER_SIZE = 5_000;

/** Sync interval in milliseconds */
const SYNC_INTERVAL_MS = 5_000;

/** Offset from tracer sync to avoid burst (2.5s) */
const SYNC_OFFSET_MS = 2_500;

/**
 * WebviewLogBuffer singleton.
 * Collects log entries from createLogger and syncs to extension.
 */
export class WebviewLogBuffer {
  private static instance: WebviewLogBuffer;

  private buffer: WebviewLogEntry[] = [];
  private vscode: VSCodeAPI | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private _enabled: boolean = true;

  private constructor() {}

  static getInstance(): WebviewLogBuffer {
    if (!WebviewLogBuffer.instance) {
      WebviewLogBuffer.instance = new WebviewLogBuffer();
    }
    return WebviewLogBuffer.instance;
  }

  /**
   * Initialize with VS Code API for syncing.
   * Starts the sync timer with a 2.5s offset from startup.
   */
  initialize(vscode: VSCodeAPI): void {
    this.vscode = vscode;
    this.startSyncTimer();
  }

  /**
   * Push a log entry into the buffer.
   */
  push(entry: WebviewLogEntry): void {
    if (!this._enabled) return;

    this.buffer.push(entry);

    // Evict oldest if over limit
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }

  /**
   * Sync buffered entries to the extension and clear the buffer.
   */
  sync(): void {
    if (!this.vscode || this.buffer.length === 0) return;

    this.vscode.postMessage({
      type: 'webviewLogs',
      entries: this.buffer,
      webviewSyncTime: new Date().toISOString()
    });

    this.buffer = [];
  }

  /**
   * Start the sync timer with an offset to avoid overlapping with tracer sync.
   */
  private startSyncTimer(): void {
    this.stopSyncTimer();
    // Initial delay of 2.5s to offset from tracer (which fires at 0s, 5s, 10s...)
    this.syncTimer = setTimeout(() => {
      this.sync();
      // Then repeat every 5s
      this.syncTimer = setInterval(() => this.sync(), SYNC_INTERVAL_MS) as unknown as ReturnType<typeof setTimeout>;
    }, SYNC_OFFSET_MS);
  }

  /**
   * Stop the sync timer.
   */
  private stopSyncTimer(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      clearInterval(this.syncTimer as unknown as ReturnType<typeof setInterval>);
      this.syncTimer = null;
    }
  }

  /** Number of entries in the buffer. */
  get size(): number {
    return this.buffer.length;
  }

  /** Whether the buffer is enabled. */
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /** Get all buffered entries (for testing). */
  getAll(): WebviewLogEntry[] {
    return [...this.buffer];
  }

  /** Clear the buffer. */
  clear(): void {
    this.buffer = [];
  }

  /** Dispose the buffer and stop syncing. */
  dispose(): void {
    this.stopSyncTimer();
    this.buffer = [];
    this.vscode = null;
  }
}

/** Singleton instance */
export const webviewLogBuffer = WebviewLogBuffer.getInstance();
