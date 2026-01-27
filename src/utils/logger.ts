import * as vscode from 'vscode';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('DeepSeek Moby');
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  private log(level: LogLevel, message: string, details?: string) {
    const timestamp = this.formatTimestamp();
    const levelPadded = level.padEnd(5);
    let logLine = `[${timestamp}] ${levelPadded} ${message}`;

    if (details) {
      logLine += `\n         ${details.replace(/\n/g, '\n         ')}`;
    }

    this.outputChannel.appendLine(logLine);
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
    this.info(`Session started: ${sessionId}`, `Title: ${title}`);
  }

  public sessionSwitch(sessionId: string) {
    this.info(`Session switched: ${sessionId}`);
  }

  public sessionClear() {
    this.info('Session cleared');
  }

  // API events
  public apiRequest(model: string, messageCount: number, hasImages: boolean = false) {
    const imageInfo = hasImages ? ' (with images)' : '';
    this.info(`→ Request: ${messageCount} messages${imageInfo}`, `Model: ${model}`);
  }

  public apiResponse(tokenCount: number, durationMs: number) {
    const duration = (durationMs / 1000).toFixed(2);
    this.info(`← Response: ${tokenCount.toLocaleString()} tokens in ${duration}s`);
  }

  public apiError(error: string, details?: string) {
    this.error(`API error: ${error}`, details);
  }

  public apiAborted() {
    this.info('Request aborted by user');
  }

  // Settings events
  public settingsChanged(setting: string, value: any) {
    this.info(`Setting changed: ${setting} = ${value}`);
  }

  public modelChanged(model: string) {
    this.info(`Model changed: ${model}`);
  }

  // Tool events
  public toolCall(toolName: string) {
    this.info(`Tool call: ${toolName}`);
  }

  public toolResult(toolName: string, success: boolean) {
    if (success) {
      this.info(`Tool result: ${toolName} succeeded`);
    } else {
      this.warn(`Tool result: ${toolName} failed`);
    }
  }

  // Code actions
  public codeApplied(success: boolean, file?: string) {
    if (success) {
      this.info(`Code applied${file ? `: ${file}` : ''}`);
    } else {
      this.warn(`Code apply failed${file ? `: ${file}` : ''}`);
    }
  }

  public diffShown(file: string) {
    this.info(`Diff shown: ${file}`);
  }

  // Web search events (Tavily)
  public webSearchRequest(query: string, searchDepth: string) {
    this.info(`🌐 Web search: "${query}"`, `Depth: ${searchDepth}`);
  }

  public webSearchResult(resultCount: number, durationMs: number) {
    const duration = (durationMs / 1000).toFixed(2);
    this.info(`🌐 Web search complete: ${resultCount} results in ${duration}s`);
  }

  public webSearchCached(query: string) {
    this.info(`🌐 Web search (cached): "${query}"`);
  }

  public webSearchError(error: string) {
    this.error(`🌐 Web search failed: ${error}`);
  }

  public webSearchCacheCleared() {
    this.info('🌐 Web search cache cleared');
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
