/**
 * UnifiedLogExporter
 *
 * Combines all three log sources into a single document:
 *   1. Trace events (from TraceCollector)
 *   2. Extension logs (from Logger ring buffer)
 *   3. Webview logs (from WebviewLogStore)
 *
 * Two export modes:
 *   - AI: Condensed, LLM-optimized (tracer.exportForAI + summarized logs)
 *   - Human: Full detail (tracer.export('pretty') + full logs)
 */

import * as vscode from 'vscode';
import { tracer } from '../tracing';
import { logger, type LogBufferEntry } from '../utils/logger';
import { webviewLogStore, type WebviewLogEntry } from './WebviewLogStore';

const SECTION_DIVIDER = '═══════════════════════════════════════════════════════════════';
const SECTION_DIVIDER_THIN = '───────────────────────────────────────────────────────────────';

export class UnifiedLogExporter {
  /**
   * Export all logs in AI-optimized format and open in an editor tab.
   */
  static async exportForAI(): Promise<void> {
    const sections: string[] = [];
    const timestamp = new Date().toISOString();

    sections.push(SECTION_DIVIDER);
    sections.push(`  MOBY UNIFIED LOG EXPORT (AI) - ${timestamp}`);
    sections.push(SECTION_DIVIDER);
    sections.push('');

    // Section 1: Traces (AI format)
    const traceEvents = tracer.getAll();
    sections.push(`## TRACES (${traceEvents.length} events)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (traceEvents.length > 0) {
      sections.push(tracer.exportForAI({ maxEvents: 500, groupByFlow: true }));
    } else {
      sections.push('(no trace events)');
    }
    sections.push('');

    // Section 2: Extension Logs (condensed)
    const extLogs = logger.getLogBuffer();
    sections.push(`## EXTENSION LOGS (${extLogs.length} entries)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (extLogs.length > 0) {
      sections.push(UnifiedLogExporter.formatExtensionLogsAI(extLogs));
    } else {
      sections.push('(no extension log entries)');
    }
    sections.push('');

    // Section 3: Webview Logs (condensed)
    const wvLogs = webviewLogStore.getAll();
    sections.push(`## WEBVIEW LOGS (${wvLogs.length} entries)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (wvLogs.length > 0) {
      sections.push(UnifiedLogExporter.formatWebviewLogsAI(wvLogs));
    } else {
      sections.push('(no webview log entries)');
    }
    sections.push('');
    sections.push(SECTION_DIVIDER);
    sections.push('  END OF EXPORT');
    sections.push(SECTION_DIVIDER);

    const content = sections.join('\n');
    await UnifiedLogExporter.openInEditor(content, 'moby-logs-ai');
  }

  /**
   * Export all logs in full human-readable format and open in an editor tab.
   */
  static async exportForHuman(): Promise<void> {
    const sections: string[] = [];
    const timestamp = new Date().toISOString();

    sections.push(SECTION_DIVIDER);
    sections.push(`  MOBY UNIFIED LOG EXPORT (FULL) - ${timestamp}`);
    sections.push(`  Traces: ${tracer.size} | Extension Logs: ${logger.logBufferSize} | Webview Logs: ${webviewLogStore.size}`);
    sections.push(SECTION_DIVIDER);
    sections.push('');

    // Section 1: Traces (pretty format)
    sections.push(`## TRACES (${tracer.size} events)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (tracer.size > 0) {
      sections.push(tracer.export('pretty'));
    } else {
      sections.push('(no trace events)');
    }
    sections.push('');

    // Section 2: Extension Logs (full)
    const extLogs = logger.getLogBuffer();
    sections.push(`## EXTENSION LOGS (${extLogs.length} entries)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (extLogs.length > 0) {
      sections.push(UnifiedLogExporter.formatExtensionLogsFull(extLogs));
    } else {
      sections.push('(no extension log entries)');
    }
    sections.push('');

    // Section 3: Webview Logs (full)
    const wvLogs = webviewLogStore.getAll();
    sections.push(`## WEBVIEW LOGS (${wvLogs.length} entries)`);
    sections.push(SECTION_DIVIDER_THIN);
    if (wvLogs.length > 0) {
      sections.push(UnifiedLogExporter.formatWebviewLogsFull(wvLogs));
    } else {
      sections.push('(no webview log entries)');
    }
    sections.push('');
    sections.push(SECTION_DIVIDER);
    sections.push('  END OF EXPORT');
    sections.push(SECTION_DIVIDER);

    const content = sections.join('\n');
    await UnifiedLogExporter.openInEditor(content, 'moby-logs-full');
  }

  // --- Formatting helpers ---

  /**
   * Format extension logs for AI: only WARN/ERROR, no timestamps, condensed.
   */
  private static formatExtensionLogsAI(entries: LogBufferEntry[]): string {
    // Filter to WARN/ERROR for AI context efficiency
    const significant = entries.filter(e => e.level === 'WARN' || e.level === 'ERROR');
    if (significant.length === 0) {
      return `(${entries.length} entries, all DEBUG/INFO - no warnings or errors)`;
    }

    const lines = significant.map(e => {
      const time = e.timestamp.slice(11, 23); // HH:MM:SS.mmm
      const msg = e.details ? `${e.message} | ${e.details}` : e.message;
      return `[${e.level}] ${time} ${msg}`;
    });

    if (significant.length < entries.length) {
      lines.unshift(`(showing ${significant.length} warnings/errors of ${entries.length} total)`);
    }

    return lines.join('\n');
  }

  /**
   * Format extension logs for human: all entries, full detail.
   */
  private static formatExtensionLogsFull(entries: LogBufferEntry[]): string {
    return entries.map(e => {
      const time = e.timestamp.slice(11, 23); // HH:MM:SS.mmm
      let line = `${time} [${e.level.padEnd(5)}] ${e.message}`;
      if (e.details) {
        line += `\n      ${e.details}`;
      }
      return line;
    }).join('\n');
  }

  /**
   * Format webview logs for AI: only warn/error, condensed.
   */
  private static formatWebviewLogsAI(entries: WebviewLogEntry[]): string {
    const significant = entries.filter(e => e.level === 'warn' || e.level === 'error');
    if (significant.length === 0) {
      return `(${entries.length} entries, all debug/info - no warnings or errors)`;
    }

    const lines = significant.map(e => {
      const time = e.timestamp.slice(11, 23);
      return `[${e.level.toUpperCase()}] ${time} [${e.component}] ${e.message}`;
    });

    if (significant.length < entries.length) {
      lines.unshift(`(showing ${significant.length} warnings/errors of ${entries.length} total)`);
    }

    return lines.join('\n');
  }

  /**
   * Format webview logs for human: all entries, full detail.
   */
  private static formatWebviewLogsFull(entries: WebviewLogEntry[]): string {
    return entries.map(e => {
      const time = e.timestamp.slice(11, 23);
      return `${time} [${e.level.toUpperCase().padEnd(5)}] [${e.component}] ${e.message}`;
    }).join('\n');
  }

  /**
   * Open content in a new editor tab.
   */
  private static async openInEditor(content: string, title: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'log'
    });
    await vscode.window.showTextDocument(doc, { preview: false });

    const totalLines = content.split('\n').length;
    vscode.window.showInformationMessage(
      `Moby logs exported: ${totalLines} lines`
    );
  }
}
