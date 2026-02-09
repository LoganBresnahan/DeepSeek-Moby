import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConfigManager } from '../utils/config';
import { ConversationManager } from '../events';
import { tracer } from '../tracing';

export class CommandProvider {
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private config: ConfigManager;
  private conversationManager: ConversationManager;

  constructor(deepSeekClient: DeepSeekClient, statusBar: StatusBar, conversationManager: ConversationManager) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.config = ConfigManager.getInstance();
    this.conversationManager = conversationManager;
  }

  async explainCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      // Get entire file or function
      const line = selection.active.line;
      code = await this.getFunctionAtLine(document, line);
      if (!code) {
        code = document.getText();
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Explain this ${language} code in detail:\n\n${code}\n\nProvide a clear explanation including:\n1. What the code does\n2. Key algorithms/data structures used\n3. Time/space complexity if applicable\n4. Any potential issues or edge cases`;

    await this.executeCodeAction(prompt, 'explanation', language);
  }

  async refactorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      code = await this.getFunctionAtLine(document, selection.active.line);
      if (!code) {
        vscode.window.showWarningMessage('Please select code to refactor');
        return;
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Refactor this ${language} code to be more efficient, readable, and maintainable:\n\n${code}\n\nProvide:\n1. The refactored code with proper formatting\n2. Explanation of changes made\n3. Benefits of the refactoring`;

    await this.executeCodeAction(prompt, 'refactored code', language);
  }

  async documentCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      code = await this.getFunctionAtLine(document, selection.active.line);
      if (!code) {
        vscode.window.showWarningMessage('Please select code to document');
        return;
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Add comprehensive documentation to this ${language} code:\n\n${code}\n\nInclude:\n1. Function/class documentation with parameters and return values\n2. Inline comments for complex logic\n3. Usage examples if appropriate\n4. Any assumptions or constraints`;

    await this.executeCodeAction(prompt, 'documentation', language);
  }

  async fixBugs() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      code = await this.getFunctionAtLine(document, selection.active.line);
      if (!code) {
        code = document.getText();
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Analyze this ${language} code for bugs, errors, or potential issues:\n\n${code}\n\nProvide:\n1. List of identified issues with explanations\n2. Fixed code with corrections\n3. Suggestions for preventing similar issues`;

    await this.executeCodeAction(prompt, 'bug fixes', language);
  }

  async optimizeCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      code = await this.getFunctionAtLine(document, selection.active.line);
      if (!code) {
        vscode.window.showWarningMessage('Please select code to optimize');
        return;
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Optimize this ${language} code for performance:\n\n${code}\n\nFocus on:\n1. Algorithmic improvements\n2. Memory usage reduction\n3. Execution speed\n4. Cache efficiency if applicable\nProvide optimized code with explanations of changes`;

    await this.executeCodeAction(prompt, 'optimized code', language);
  }

  async generateTests() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const language = document.languageId;

    let code: string;
    if (selection.isEmpty) {
      code = await this.getFunctionAtLine(document, selection.active.line);
      if (!code) {
        vscode.window.showWarningMessage('Please select code to test');
        return;
      }
    } else {
      code = document.getText(selection);
    }

    const prompt = `Generate comprehensive test cases for this ${language} code:\n\n${code}\n\nInclude:\n1. Unit tests with edge cases\n2. Integration tests if applicable\n3. Mock data setup\n4. Expected outputs\nUse appropriate testing framework for ${language}`;

    await this.executeCodeAction(prompt, 'tests', language);
  }

  async switchModel() {
    const currentModel = this.config.get<string>('model');
    const newModel = currentModel === 'deepseek-chat' ? 'deepseek-reasoner' : 'deepseek-chat';

    // Set model immediately on client (VS Code config has propagation delay)
    this.deepSeekClient.setModel(newModel);
    await this.config.update('model', newModel);

    vscode.window.showInformationMessage(`Switched to ${newModel} model`);
    this.statusBar.updateModel(newModel);
  }

  async insertCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    const language = editor.document.languageId;
    const prompt = await vscode.window.showInputBox({
      prompt: 'What code would you like to generate?',
      placeHolder: 'e.g., "function to sort an array using quicksort"'
    });

    if (!prompt) {
      return;
    }

    const fullPrompt = `Generate ${language} code for: ${prompt}\n\nProvide complete, production-ready code with proper formatting, error handling, and documentation.`;

    const response = await this.deepSeekClient.chat([
      { role: 'user', content: fullPrompt }
    ]);

    const formattedCode = await this.deepSeekClient.formatCodeResponse(
      response.content,
      language
    );

    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, formattedCode);
    });

    vscode.window.showInformationMessage('Code inserted successfully!');
  }

  // 🆕 Chat History Commands
  async exportChatHistory() {
    const format = await vscode.window.showQuickPick(
      ['JSON', 'Markdown', 'Text'],
      { placeHolder: 'Select export format' }
    );
    
    if (!format) return;
    
    const formatLower = format.toLowerCase() as 'json' | 'markdown' | 'txt';
    const content = await this.conversationManager.exportAllSessions(formatLower);
    
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: formatLower === 'json' ? 'json' : formatLower === 'markdown' ? 'markdown' : 'plaintext'
    });
    
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Chat history exported as ${format}`);
  }

  async importChatHistory() {
    const fileUri = await vscode.window.showOpenDialog({
      filters: { 'JSON Files': ['json'] },
      canSelectMany: false
    });
    
    if (!fileUri || fileUri.length === 0) return;
    
    try {
      const fileContent = await vscode.workspace.fs.readFile(fileUri[0]);
      const content = Buffer.from(fileContent).toString('utf8');
      
      const session = await this.conversationManager.importSession(content);
      if (session) {
        vscode.window.showInformationMessage(`Chat session "${session.title}" imported successfully`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to import chat history: ${error.message}`);
    }
  }

  async clearChatHistory() {
    const result = await vscode.window.showWarningMessage(
      'Delete ALL chat history? This cannot be undone.',
      { modal: true },
      'Delete All',
      'Cancel'
    );

    if (result === 'Delete All') {
      await this.conversationManager.clearAllHistory();
      vscode.window.showInformationMessage('All chat history deleted');
    }
  }

  async searchChatHistory() {
    const query = await vscode.window.showInputBox({
      prompt: 'Search chat history',
      placeHolder: 'Enter search keywords'
    });

    if (!query) return;

    const sessions = await this.conversationManager.searchHistory(query);

    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No matching chat sessions found');
      return;
    }

    const items = sessions.map(session => ({
      label: session.title,
      description: `${session.eventCount} events`,
      detail: session.lastActivityPreview || session.firstUserMessage || '',
      session
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a chat session to open'
    });

    if (selected) {
      vscode.commands.executeCommand('deepseek.showChatHistory');
    }
  }

  // ============================================
  // Trace Export Commands
  // ============================================

  async exportTraceToFile() {
    const events = tracer.getAll();

    if (events.length === 0) {
      vscode.window.showInformationMessage('No trace events to export');
      return;
    }

    const format = await vscode.window.showQuickPick(
      [
        { label: 'JSON', description: 'Structured data for programmatic analysis', value: 'json' as const },
        { label: 'JSON Lines', description: 'One event per line, good for streaming/logs', value: 'jsonl' as const },
        { label: 'Pretty', description: 'Human-readable formatted text', value: 'pretty' as const }
      ],
      { placeHolder: 'Select export format' }
    );

    if (!format) return;

    const content = tracer.export(format.value);
    const extension = format.value === 'json' ? 'json' : format.value === 'jsonl' ? 'jsonl' : 'txt';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultFilename = `moby-trace-${timestamp}.${extension}`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultFilename),
      filters: {
        'Trace Files': [extension],
        'All Files': ['*']
      },
      saveLabel: 'Export Trace'
    });

    if (!uri) return;

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`Trace exported: ${events.length} events to ${uri.fsPath}`);
  }

  async copyTraceToClipboard() {
    const events = tracer.getAll();

    if (events.length === 0) {
      vscode.window.showInformationMessage('No trace events to copy');
      return;
    }

    // Use pretty format for clipboard - more human-readable
    const content = tracer.export('pretty');
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage(`Copied ${events.length} trace events to clipboard`);
  }

  async viewTraceInOutput() {
    const events = tracer.getAll();

    if (events.length === 0) {
      vscode.window.showInformationMessage('No trace events to display');
      return;
    }

    // Create or get output channel for traces
    const outputChannel = vscode.window.createOutputChannel('Moby Trace', 'log');
    outputChannel.clear();

    // Header
    outputChannel.appendLine('═══════════════════════════════════════════════════════════════');
    outputChannel.appendLine(`  MOBY TRACE EXPORT - ${new Date().toISOString()}`);
    outputChannel.appendLine(`  Events: ${events.length}`);
    outputChannel.appendLine('═══════════════════════════════════════════════════════════════');
    outputChannel.appendLine('');

    // Content
    const content = tracer.export('pretty');
    outputChannel.appendLine(content);

    outputChannel.appendLine('');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════════');
    outputChannel.appendLine('  END OF TRACE');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════════');

    outputChannel.show();
  }

  async clearTraces() {
    const eventCount = tracer.size;

    if (eventCount === 0) {
      vscode.window.showInformationMessage('Trace buffer is already empty');
      return;
    }

    const result = await vscode.window.showWarningMessage(
      `Clear ${eventCount} trace events? This cannot be undone.`,
      { modal: true },
      'Clear',
      'Cancel'
    );

    if (result === 'Clear') {
      tracer.clear();
      vscode.window.showInformationMessage('Trace buffer cleared');
    }
  }

  async showTraceStats() {
    const events = tracer.getAll();

    if (events.length === 0) {
      vscode.window.showInformationMessage('No trace events recorded');
      return;
    }

    // Collect stats
    const categoryCount = new Map<string, number>();
    const sourceCount = new Map<string, number>();
    let errorCount = 0;
    let totalDuration = 0;
    let durationCount = 0;

    // Time alignment diagnostics
    const extensionEvents = events.filter(e => e.source === 'extension');
    const webviewEvents = events.filter(e => e.source === 'webview');

    for (const event of events) {
      // Category breakdown
      const cat = event.category.split('.')[0];
      categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);

      // Source breakdown
      sourceCount.set(event.source, (sourceCount.get(event.source) || 0) + 1);

      // Errors
      if (event.status === 'failed' || event.error) {
        errorCount++;
      }

      // Duration
      if (event.duration !== undefined) {
        totalDuration += event.duration;
        durationCount++;
      }
    }

    // Calculate timestamp ranges for time alignment diagnostics
    const getTimeRange = (evts: typeof events) => {
      if (evts.length === 0) return null;
      const sorted = [...evts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return {
        first: sorted[0].timestamp,
        last: sorted[sorted.length - 1].timestamp,
        firstMs: new Date(sorted[0].timestamp).getTime(),
        lastMs: new Date(sorted[sorted.length - 1].timestamp).getTime()
      };
    };

    const extRange = getTimeRange(extensionEvents);
    const webRange = getTimeRange(webviewEvents);

    // Format stats
    const lines: string[] = [
      `Total Events: ${events.length}`,
      `Errors: ${errorCount}`,
      `Avg Duration: ${durationCount > 0 ? (totalDuration / durationCount).toFixed(2) + 'ms' : 'N/A'}`,
      '',
      'By Category:',
      ...Array.from(categoryCount.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`),
      '',
      'By Source:',
      ...Array.from(sourceCount.entries())
        .map(([src, count]) => `  ${src}: ${count}`),
      '',
      '=== TIME ALIGNMENT DIAGNOSTICS ===',
      `Current Extension Time: ${new Date().toISOString()}`,
      ''
    ];

    if (extRange) {
      lines.push(
        'Extension Events:',
        `  First: ${extRange.first}`,
        `  Last:  ${extRange.last}`,
        `  Span:  ${((extRange.lastMs - extRange.firstMs) / 1000).toFixed(2)}s`
      );
    } else {
      lines.push('Extension Events: None');
    }

    if (webRange) {
      lines.push(
        '',
        'Webview Events:',
        `  First: ${webRange.first}`,
        `  Last:  ${webRange.last}`,
        `  Span:  ${((webRange.lastMs - webRange.firstMs) / 1000).toFixed(2)}s`
      );
    } else {
      lines.push('', 'Webview Events: None');
    }

    // Calculate gap between extension and webview events
    if (extRange && webRange) {
      const gapMs = webRange.firstMs - extRange.lastMs;
      const gapSeconds = gapMs / 1000;
      const gapMinutes = gapSeconds / 60;
      lines.push(
        '',
        'Cross-Boundary Gap:',
        `  Gap: ${gapMs}ms (${gapMinutes.toFixed(2)} minutes)`,
        `  (Extension last -> Webview first)`
      );

      if (Math.abs(gapMinutes) > 1) {
        lines.push(
          '',
          '*** WARNING: Large time gap detected! ***',
          'This may indicate:',
          '  1. Webview was hidden/recreated after extension events',
          '  2. Clock synchronization issue',
          '  3. Long delay between extension and webview initialization'
        );
      }
    }

    const doc = await vscode.workspace.openTextDocument({
      content: lines.join('\n'),
      language: 'plaintext'
    });

    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async exportCurrentSession() {
    const currentSession = await this.conversationManager.getCurrentSession();
    if (!currentSession) {
      vscode.window.showWarningMessage('No active chat session');
      return;
    }

    const content = await this.conversationManager.exportSession(currentSession.id);

    const doc = await vscode.workspace.openTextDocument({
      content,
      language: 'json'
    });

    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`Session "${currentSession.title}" exported`);
  }

  private async executeCodeAction(prompt: string, action: string, language: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `DeepSeek Moby: Generating ${action}...`,
      cancellable: true
    }, async (progress, token) => {
      try {
        progress.report({ increment: 0 });
        
        const response = await this.deepSeekClient.chat([
          { role: 'user', content: prompt }
        ]);

        if (token.isCancellationRequested) {
          return;
        }

        progress.report({ increment: 50 });

        // Extract and format code from response
        const formattedResponse = await this.deepSeekClient.formatCodeResponse(
          response.content,
          language
        );

        // Save to chat history
        await this.conversationManager.addMessageToCurrentSession({
          role: 'user',
          content: prompt
        });

        await this.conversationManager.addMessageToCurrentSession({
          role: 'assistant',
          content: formattedResponse
        });

        // Show in new document
        const document = await vscode.workspace.openTextDocument({
          content: formattedResponse,
          language
        });

        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true
        });

        progress.report({ increment: 100 });
        this.statusBar.updateLastResponse();
        
      } catch (error: any) {
        vscode.window.showErrorMessage(`DeepSeek Moby error: ${error.message}`);
      }
    });
  }

  private async getFunctionAtLine(document: vscode.TextDocument, line: number): Promise<string> {
    // Simple function extraction - can be enhanced per language
    const text = document.getText();
    const lines = text.split('\n');
    
    // Find function start
    let start = line;
    while (start > 0 && !lines[start].match(/^(async\s+)?(function|class|def|fn)\s/)) {
      start--;
    }
    
    // Find function end (simple brace matching)
    let braceCount = 0;
    let end = start;
    
    for (let i = start; i < lines.length; i++) {
      braceCount += (lines[i].match(/{/g) || []).length;
      braceCount -= (lines[i].match(/}/g) || []).length;
      
      if (braceCount === 0 && i > start) {
        end = i;
        break;
      }
    }
    
    if (end > start) {
      return lines.slice(start, end + 1).join('\n');
    }
    
    return '';
  }
}