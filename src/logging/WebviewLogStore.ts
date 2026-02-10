/**
 * WebviewLogStore
 *
 * Extension-side ring buffer that stores log entries received from
 * the webview via the 'webviewLogs' postMessage.
 *
 * Buffer size: 5,000 entries (matches webview-side buffer).
 */

/**
 * Shape of a log entry received from the webview.
 * Mirrors WebviewLogEntry from media/logging/WebviewLogBuffer.ts.
 */
export interface WebviewLogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
}

/** Maximum number of entries to store */
const MAX_STORE_SIZE = 5_000;

export class WebviewLogStore {
  private static instance: WebviewLogStore;

  private buffer: WebviewLogEntry[] = [];

  private constructor() {}

  static getInstance(): WebviewLogStore {
    if (!WebviewLogStore.instance) {
      WebviewLogStore.instance = new WebviewLogStore();
    }
    return WebviewLogStore.instance;
  }

  /**
   * Import entries received from the webview.
   * Appends to the buffer and evicts oldest entries if over limit.
   */
  import(entries: WebviewLogEntry[]): void {
    this.buffer.push(...entries);

    // Evict oldest if over limit
    if (this.buffer.length > MAX_STORE_SIZE) {
      this.buffer = this.buffer.slice(-MAX_STORE_SIZE);
    }
  }

  /** Get all stored entries in chronological order. */
  getAll(): WebviewLogEntry[] {
    return [...this.buffer];
  }

  /** Number of entries stored. */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear the store. */
  clear(): void {
    this.buffer = [];
  }
}

/** Singleton instance */
export const webviewLogStore = WebviewLogStore.getInstance();
