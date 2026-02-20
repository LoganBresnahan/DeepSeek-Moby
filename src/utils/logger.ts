import * as vscode from 'vscode';
import { tracer, type TraceLevel } from '../tracing';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'OFF';

/**
 * A single log buffer entry for export.
 */
export interface LogBufferEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  details?: string;
}

/** Maximum number of log entries kept in the ring buffer */
const LOG_BUFFER_MAX_SIZE = 5_000;

// Log level priority (lower = more verbose)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  'DEBUG': 0,
  'INFO': 1,
  'WARN': 2,
  'ERROR': 3,
  'OFF': 4
};

// ANSI color codes for terminal/output channel
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  // Level colors
  debug: '\x1b[36m',    // Cyan
  info: '\x1b[32m',     // Green
  warn: '\x1b[33m',     // Yellow
  error: '\x1b[31m',    // Red
  // Component colors
  timestamp: '\x1b[90m', // Gray
  shell: '\x1b[35m',     // Magenta
  tool: '\x1b[34m',      // Blue
  api: '\x1b[36m',       // Cyan
  session: '\x1b[33m',   // Yellow
  code: '\x1b[32m',      // Green
  web: '\x1b[96m'        // Bright Cyan
};

class Logger {
  private static instance: Logger;
  private static _instanceNumber: number = 1;
  private outputChannel: vscode.LogOutputChannel;
  private _minLevel: LogLevel = 'INFO';
  // Note: VS Code Output channels do NOT support ANSI colors
  // Colors are disabled by default - the setting is kept for potential future terminal output
  private _useColors: boolean = false;
  private _logBuffer: LogBufferEntry[] = [];
  private _logBufferStart: number = 0;
  private _logBufferCount: number = 0;

  /**
   * Set the instance number for multi-instance output channel separation.
   * Call from activate() before any logging occurs.
   * Instance 1 → "DeepSeek Moby", Instance 2+ → "DeepSeek Moby (2)", etc.
   * If called after the Logger is already created, replaces the output channel.
   */
  static setInstanceNumber(n: number): void {
    Logger._instanceNumber = n;
    if (Logger.instance) {
      const channelName = n > 1 ? `DeepSeek Moby (${n})` : 'DeepSeek Moby';
      Logger.instance.outputChannel.dispose();
      Logger.instance.outputChannel = vscode.window.createOutputChannel(channelName, { log: true });
    }
  }

  /** Get the current instance number. */
  static getInstanceNumber(): number {
    return Logger._instanceNumber;
  }

  private static get channelName(): string {
    return Logger._instanceNumber > 1
      ? `DeepSeek Moby (${Logger._instanceNumber})`
      : 'DeepSeek Moby';
  }

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel(Logger.channelName, { log: true });
    this.loadSettings();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('deepseek.logLevel') || e.affectsConfiguration('deepseek.logColors')) {
        this.loadSettings();
      }
    });

    // Set up tracer log output callback
    tracer.setLogOutput((level: TraceLevel, message: string, details?: string) => {
      this.log(this.traceLevelToLogLevel(level), message, details);
    });
  }

  /**
   * Convert trace level to log level.
   */
  private traceLevelToLogLevel(level: TraceLevel): LogLevel {
    switch (level) {
      case 'debug': return 'DEBUG';
      case 'info': return 'INFO';
      case 'warn': return 'WARN';
      case 'error': return 'ERROR';
    }
  }

  private loadSettings(): void {
    const config = vscode.workspace.getConfiguration('deepseek');
    this._minLevel = config.get<LogLevel>('logLevel') || 'INFO';
    // VS Code Output channels don't support ANSI colors, so we always disable them
    // The setting is kept in package.json for potential future terminal/debug console output
    this._useColors = false;
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public get minLevel(): LogLevel {
    return this._minLevel;
  }

  public set minLevel(level: LogLevel) {
    this._minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this._minLevel];
  }

  private colorize(text: string, color: keyof typeof COLORS): string {
    if (!this._useColors) return text;
    return `${COLORS[color]}${text}${COLORS.reset}`;
  }

  /**
   * Format: ":vscode | Moby: 2026-02-08T22:45:23.732Z [INFO] Message"
   *
   * We include our own timestamp and level because:
   * 1. We can't rely on VS Code's level matching ours
   * 2. Provides clear attribution (logs from Moby extension)
   * 3. ISO timestamps are unambiguous and LLM-friendly
   */
  private log(level: LogLevel, message: string, details?: string, component?: keyof typeof COLORS) {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();

    // Push to ring buffer
    this.pushToBuffer({ timestamp, level, message, details });

    const msg = component ? this.colorize(message, component) : message;

    // Format: ":vscode | Moby: ISO_TIMESTAMP [LEVEL] message"
    let logLine = `:vscode | Moby: ${timestamp} [${level}] ${msg}`;

    if (details) {
      // Indent details to align with message start
      const indent = '      '; // 6 spaces for alignment under message
      const detailLines = details.replace(/\n/g, `\n${indent}`);
      logLine += `\n${indent}${this.colorize(detailLines, 'dim')}`;
    }

    // Use the appropriate log method based on level
    switch (level) {
      case 'DEBUG':
        this.outputChannel.debug(logLine);
        break;
      case 'INFO':
        this.outputChannel.info(logLine);
        break;
      case 'WARN':
        this.outputChannel.warn(logLine);
        break;
      case 'ERROR':
        this.outputChannel.error(logLine);
        break;
    }
  }

  public info(message: string, details?: string) {
    this.log('INFO', message, details);
  }

  public warn(message: string, details?: string) {
    this.log('WARN', message, details);
  }

  public error(message: string, details?: string) {
    this.log('ERROR', message, details);
  }

  public debug(message: string, details?: string) {
    this.log('DEBUG', message, details);
  }

  // Session events
  public sessionStart(sessionId: string, title: string) {
    this.log('INFO', `Session started: ${sessionId}`, `Title: ${title}`, 'session');
    tracer.trace('session.create', 'start', {
      data: { sessionId, title }
    });
  }

  public sessionSwitch(sessionId: string) {
    this.log('INFO', `Session switched: ${sessionId}`, undefined, 'session');
    tracer.trace('session.switch', 'switch', {
      data: { sessionId }
    });
  }

  public sessionClear() {
    this.log('INFO', 'Session cleared', undefined, 'session');
    tracer.trace('session.switch', 'clear');
  }

  // API events
  private currentApiSpan: string = '';
  private currentApiCorrelationId: string = '';
  private streamingChunkCount: number = 0;
  private streamingTokenCount: number = 0;
  private currentIteration: number = 0;
  private iterationChunkCount: number = 0;
  private iterationTokenCount: number = 0;

  public apiRequest(model: string, messageCount: number, hasImages: boolean = false): string {
    const imageInfo = hasImages ? ' (with images)' : '';
    this.log('INFO', `→ Request: ${messageCount} messages${imageInfo}`, `Model: ${model}`, 'api');

    // Generate correlation ID for this request flow
    this.currentApiCorrelationId = tracer.startFlow();
    this.streamingChunkCount = 0;
    this.streamingTokenCount = 0;
    this.currentIteration = 0;
    this.iterationChunkCount = 0;
    this.iterationTokenCount = 0;

    // Start a span for the API request (async operation)
    this.currentApiSpan = tracer.startSpan('api.request', 'chat', {
      correlationId: this.currentApiCorrelationId,
      executionMode: 'async',
      data: { model, messageCount, hasImages }
    });
    return this.currentApiSpan;
  }

  /**
   * Log a streaming chunk (called frequently during response streaming).
   * Traces are batched to avoid overwhelming the buffer.
   */
  public apiStreamChunk(chunkSize: number, contentType: 'text' | 'thinking' | 'tool' = 'text') {
    this.streamingChunkCount++;
    this.streamingTokenCount += chunkSize;
    this.iterationChunkCount++;
    this.iterationTokenCount += chunkSize;

    // Only trace every 10th chunk to reduce noise, or on significant chunks
    if (this.streamingChunkCount % 10 === 1 || chunkSize > 100) {
      tracer.trace('api.stream', 'chunk', {
        correlationId: this.currentApiCorrelationId,
        executionMode: 'callback',
        level: 'debug',
        data: {
          iteration: this.currentIteration,
          chunkNumber: this.iterationChunkCount,
          chunkSize,
          contentType,
          totalChunks: this.streamingChunkCount,
          totalTokens: this.streamingTokenCount
        }
      });
    }
  }

  /**
   * Log streaming progress at key milestones.
   */
  public apiStreamProgress(milestone: 'first-token' | 'thinking-start' | 'thinking-end' | 'content-start') {
    tracer.trace('api.stream', milestone, {
      correlationId: this.currentApiCorrelationId,
      executionMode: 'callback',
      level: 'info',
      data: {
        iteration: this.currentIteration,
        iterationChunks: this.iterationChunkCount,
        iterationTokens: this.iterationTokenCount,
        totalChunks: this.streamingChunkCount,
        totalTokens: this.streamingTokenCount
      }
    });

    if (milestone === 'first-token') {
      this.log('DEBUG', 'First token received', undefined, 'api');
    }
  }

  public apiResponse(tokenCount: number, _durationMs?: number) {
    // Note: durationMs parameter is deprecated - we use the span's internal timing
    // for consistency. Kept for backward compatibility but ignored.
    this.log('INFO', `← Response: ${tokenCount.toLocaleString()} tokens`, undefined, 'api');

    // End the API span - the tracer calculates duration from relativeTime
    if (this.currentApiSpan) {
      tracer.endSpan(this.currentApiSpan, {
        status: 'completed',
        data: {
          tokenCount,
          streamChunks: this.streamingChunkCount,
          streamTokens: this.streamingTokenCount
        }
      });
      this.currentApiSpan = '';
      this.currentApiCorrelationId = '';
    }
  }

  public apiError(error: string, details?: string) {
    this.log('ERROR', `API error: ${error}`, details, 'api');

    // End the API span with failure
    if (this.currentApiSpan) {
      tracer.endSpan(this.currentApiSpan, {
        status: 'failed',
        error,
        data: { details }
      });
      this.currentApiSpan = '';
      this.currentApiCorrelationId = '';
    }
  }

  public apiAborted() {
    this.log('INFO', 'Request aborted by user', undefined, 'api');

    // End the API span as completed (abort is intentional)
    if (this.currentApiSpan) {
      tracer.endSpan(this.currentApiSpan, {
        status: 'completed',
        data: {
          aborted: true,
          streamChunks: this.streamingChunkCount,
          streamTokens: this.streamingTokenCount
        }
      });
      this.currentApiSpan = '';
      this.currentApiCorrelationId = '';
    }
  }

  /**
   * Get the current API correlation ID (for child operations).
   */
  public getCurrentApiCorrelationId(): string {
    return this.currentApiCorrelationId;
  }

  /**
   * Set the current iteration number (for R1 multi-iteration flows).
   * Call this at the start of each iteration.
   */
  public setIteration(iteration: number): void {
    this.currentIteration = iteration;
    this.iterationChunkCount = 0;
    this.iterationTokenCount = 0;
  }

  /**
   * Get the current iteration number.
   */
  public getCurrentIteration(): number {
    return this.currentIteration;
  }

  // Settings events
  public settingsChanged(setting: string, value: any) {
    this.log('DEBUG', `Setting changed: ${setting} = ${value}`);
  }

  public modelChanged(model: string) {
    this.log('INFO', `Model changed: ${model}`);
  }

  // Tool events
  private currentToolSpan: string = '';

  public toolCall(toolName: string): string {
    this.log('INFO', `Tool call: ${toolName}`, undefined, 'tool');

    // Start a span for the tool call
    this.currentToolSpan = tracer.startSpan('tool.call', toolName, {
      executionMode: 'async',
      data: { toolName }
    });
    return this.currentToolSpan;
  }

  public toolResult(toolName: string, success: boolean) {
    if (success) {
      this.log('INFO', `Tool result: ${toolName} succeeded`, undefined, 'tool');
    } else {
      this.log('WARN', `Tool result: ${toolName} failed`, undefined, 'tool');
    }

    // End the tool span
    if (this.currentToolSpan) {
      tracer.endSpan(this.currentToolSpan, {
        status: success ? 'completed' : 'failed',
        data: { toolName, success }
      });
      this.currentToolSpan = '';
    }
  }

  // Shell events (R1 reasoner)
  private currentShellSpan: string = '';

  public shellExecuting(command: string): string {
    this.log('INFO', `Shell executing: ${command}`, undefined, 'shell');

    // Start a span for the shell command
    this.currentShellSpan = tracer.startSpan('shell.execute', 'run', {
      executionMode: 'async',
      data: { command }
    });
    return this.currentShellSpan;
  }

  public shellResult(command: string, success: boolean, output?: string) {
    if (success) {
      this.log('INFO', `Shell completed: ${command}`, output?.substring(0, 200), 'shell');
    } else {
      this.log('WARN', `Shell failed: ${command}`, output?.substring(0, 200), 'shell');
    }

    // End the shell span
    if (this.currentShellSpan) {
      tracer.endSpan(this.currentShellSpan, {
        status: success ? 'completed' : 'failed',
        data: { command, success, outputLength: output?.length }
      });
      this.currentShellSpan = '';
    }
  }

  // Code actions
  public codeApplied(success: boolean, file?: string) {
    if (success) {
      this.log('INFO', `Code applied${file ? `: ${file}` : ''}`, undefined, 'code');
    } else {
      this.log('WARN', `Code apply failed${file ? `: ${file}` : ''}`, undefined, 'code');
    }
  }

  public diffShown(file: string) {
    this.log('INFO', `Diff shown: ${file}`, undefined, 'code');
  }

  // Web search events (Tavily)
  private currentWebSearchSpan: string = '';

  public webSearchRequest(query: string, searchDepth: string): string {
    this.log('INFO', `🌐 Web search: "${query}"`, `Depth: ${searchDepth}`, 'web');

    // Start a span for the web search
    this.currentWebSearchSpan = tracer.startSpan('api.request', 'webSearch', {
      executionMode: 'async',
      data: { query, searchDepth }
    });
    return this.currentWebSearchSpan;
  }

  public webSearchResult(resultCount: number, durationMs: number) {
    const duration = (durationMs / 1000).toFixed(2);
    this.log('INFO', `🌐 Web search complete: ${resultCount} results in ${duration}s`, undefined, 'web');

    // End the web search span
    if (this.currentWebSearchSpan) {
      tracer.endSpan(this.currentWebSearchSpan, {
        status: 'completed',
        data: { resultCount, durationMs }
      });
      this.currentWebSearchSpan = '';
    }
  }

  public webSearchCached(query: string) {
    this.log('DEBUG', `🌐 Web search (cached): "${query}"`, undefined, 'web');
    tracer.trace('api.response', 'webSearchCached', {
      level: 'debug',
      data: { query, cached: true }
    });
  }

  public webSearchError(error: string) {
    this.log('ERROR', `🌐 Web search failed: ${error}`, undefined, 'web');

    // End the web search span with failure
    if (this.currentWebSearchSpan) {
      tracer.endSpan(this.currentWebSearchSpan, {
        status: 'failed',
        error
      });
      this.currentWebSearchSpan = '';
    }
  }

  public webSearchCacheCleared() {
    this.log('INFO', '🌐 Web search cache cleared', undefined, 'web');
    tracer.trace('api.response', 'cacheCleared');
  }

  /**
   * Get the current API correlation ID for cross-boundary tracing.
   * Returns null if no API request is in progress.
   */
  public getCurrentCorrelationId(): string | null {
    return this.currentApiCorrelationId || null;
  }

  // --- Ring Buffer ---

  private pushToBuffer(entry: LogBufferEntry): void {
    if (this._logBufferCount < LOG_BUFFER_MAX_SIZE) {
      this._logBuffer.push(entry);
      this._logBufferCount++;
    } else {
      // Overwrite oldest entry (ring buffer wrap)
      this._logBuffer[this._logBufferStart] = entry;
      this._logBufferStart = (this._logBufferStart + 1) % LOG_BUFFER_MAX_SIZE;
    }
  }

  /** Get all buffered log entries in chronological order. */
  public getLogBuffer(): LogBufferEntry[] {
    if (this._logBufferCount < LOG_BUFFER_MAX_SIZE) {
      return this._logBuffer.slice();
    }
    // Ring buffer wrapped - return in order: start..end, 0..start
    return [
      ...this._logBuffer.slice(this._logBufferStart),
      ...this._logBuffer.slice(0, this._logBufferStart)
    ];
  }

  /** Clear the log buffer. */
  public clearLogBuffer(): void {
    this._logBuffer = [];
    this._logBufferStart = 0;
    this._logBufferCount = 0;
  }

  /** Number of entries in the log buffer. */
  public get logBufferSize(): number {
    return this._logBufferCount;
  }

  // Show the output channel
  public show() {
    this.outputChannel.show(true);
  }

  // Clear the output channel
  public clear() {
    this.outputChannel.clear();
  }

  public dispose() {
    this.outputChannel.dispose();
  }
}

export { Logger };
export const logger = Logger.getInstance();
