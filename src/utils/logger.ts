import * as vscode from 'vscode';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'OFF';

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
  private outputChannel: vscode.LogOutputChannel;
  private _minLevel: LogLevel = 'INFO';
  // Note: VS Code Output channels do NOT support ANSI colors
  // Colors are disabled by default - the setting is kept for potential future terminal output
  private _useColors: boolean = false;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('DeepSeek Moby', { log: true });
    this.loadSettings();

    // Listen for config changes
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('deepseek.logLevel') || e.affectsConfiguration('deepseek.logColors')) {
        this.loadSettings();
      }
    });
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
  }

  public sessionSwitch(sessionId: string) {
    this.log('INFO', `Session switched: ${sessionId}`, undefined, 'session');
  }

  public sessionClear() {
    this.log('INFO', 'Session cleared', undefined, 'session');
  }

  // API events
  public apiRequest(model: string, messageCount: number, hasImages: boolean = false) {
    const imageInfo = hasImages ? ' (with images)' : '';
    this.log('INFO', `→ Request: ${messageCount} messages${imageInfo}`, `Model: ${model}`, 'api');
  }

  public apiResponse(tokenCount: number, durationMs: number) {
    const duration = (durationMs / 1000).toFixed(2);
    this.log('INFO', `← Response: ${tokenCount.toLocaleString()} tokens in ${duration}s`, undefined, 'api');
  }

  public apiError(error: string, details?: string) {
    this.log('ERROR', `API error: ${error}`, details, 'api');
  }

  public apiAborted() {
    this.log('INFO', 'Request aborted by user', undefined, 'api');
  }

  // Settings events
  public settingsChanged(setting: string, value: any) {
    this.log('DEBUG', `Setting changed: ${setting} = ${value}`);
  }

  public modelChanged(model: string) {
    this.log('INFO', `Model changed: ${model}`);
  }

  // Tool events
  public toolCall(toolName: string) {
    this.log('INFO', `Tool call: ${toolName}`, undefined, 'tool');
  }

  public toolResult(toolName: string, success: boolean) {
    if (success) {
      this.log('INFO', `Tool result: ${toolName} succeeded`, undefined, 'tool');
    } else {
      this.log('WARN', `Tool result: ${toolName} failed`, undefined, 'tool');
    }
  }

  // Shell events (R1 reasoner)
  public shellExecuting(command: string) {
    this.log('INFO', `Shell executing: ${command}`, undefined, 'shell');
  }

  public shellResult(command: string, success: boolean, output?: string) {
    if (success) {
      this.log('INFO', `Shell completed: ${command}`, output?.substring(0, 200), 'shell');
    } else {
      this.log('WARN', `Shell failed: ${command}`, output?.substring(0, 200), 'shell');
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
  public webSearchRequest(query: string, searchDepth: string) {
    this.log('INFO', `🌐 Web search: "${query}"`, `Depth: ${searchDepth}`, 'web');
  }

  public webSearchResult(resultCount: number, durationMs: number) {
    const duration = (durationMs / 1000).toFixed(2);
    this.log('INFO', `🌐 Web search complete: ${resultCount} results in ${duration}s`, undefined, 'web');
  }

  public webSearchCached(query: string) {
    this.log('DEBUG', `🌐 Web search (cached): "${query}"`, undefined, 'web');
  }

  public webSearchError(error: string) {
    this.log('ERROR', `🌐 Web search failed: ${error}`, undefined, 'web');
  }

  public webSearchCacheCleared() {
    this.log('INFO', '🌐 Web search cache cleared', undefined, 'web');
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

export const logger = Logger.getInstance();
