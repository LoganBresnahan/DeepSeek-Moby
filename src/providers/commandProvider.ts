import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConfigManager } from '../utils/config';
import { ChatHistoryManager } from '../chatHistory/ChatHistoryManager';

export class CommandProvider {
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private config: ConfigManager;
  private chatHistoryManager: ChatHistoryManager;

  constructor(deepSeekClient: DeepSeekClient, statusBar: StatusBar, chatHistoryManager: ChatHistoryManager) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.config = ConfigManager.getInstance();
    this.chatHistoryManager = chatHistoryManager;
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
    const content = await this.chatHistoryManager.exportAllSessions(formatLower);
    
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
      
      const session = await this.chatHistoryManager.importSession(content);
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
      await this.chatHistoryManager.clearAllHistory();
      vscode.window.showInformationMessage('All chat history deleted');
    }
  }

  async searchChatHistory() {
    const query = await vscode.window.showInputBox({
      prompt: 'Search chat history',
      placeHolder: 'Enter search keywords'
    });
    
    if (!query) return;
    
    const sessions = await this.chatHistoryManager.searchHistory(query);
    
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No matching chat sessions found');
      return;
    }
    
    const items = sessions.map(session => ({
      label: session.title,
      description: `${session.messages.length} messages`,
      detail: session.messages.slice(-1)[0]?.content.substring(0, 100) + '...',
      session
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a chat session to open'
    });
    
    if (selected) {
      vscode.commands.executeCommand('deepseek.showChatHistory');
    }
  }

  async exportCurrentSession() {
    const currentSession = await this.chatHistoryManager.getCurrentSession();
    if (!currentSession) {
      vscode.window.showWarningMessage('No active chat session');
      return;
    }
    
    const content = await this.chatHistoryManager.exportSession(currentSession.id);
    
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
        await this.chatHistoryManager.addMessageToCurrentSession({
          role: 'user',
          content: prompt,
          tokens: this.deepSeekClient.estimateTokens(prompt)
        });
        
        await this.chatHistoryManager.addMessageToCurrentSession({
          role: 'assistant',
          content: formattedResponse,
          tokens: this.deepSeekClient.estimateTokens(formattedResponse)
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