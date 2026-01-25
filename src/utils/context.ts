import * as vscode from 'vscode';

export class ContextManager {
  static async getActiveEditorContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }

    const document = editor.document;
    const language = document.languageId;
    const fileName = document.fileName.split('/').pop() || 'unknown';
    const selection = editor.selection;
    
    let context = `File: ${fileName}, Language: ${language}`;
    
    if (!selection.isEmpty) {
      const selectedText = document.getText(selection);
      context += `\nSelected code (${selectedText.length} chars):\n${selectedText}`;
    } else {
      // Get context around cursor
      const line = selection.active.line;
      const start = Math.max(0, line - 10);
      const end = Math.min(document.lineCount, line + 10);
      
      let surroundingCode = '';
      for (let i = start; i < end; i++) {
        surroundingCode += document.lineAt(i).text + '\n';
      }
      
      context += `\nCode around cursor (lines ${start + 1}-${end + 1}):\n${surroundingCode}`;
    }
    
    return context;
  }

  static async getWorkspaceContext(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return 'No workspace open';
    }

    let context = `Workspace: ${workspaceFolders[0].name}\n`;
    
    // List files in workspace (limit to 20 for brevity)
    try {
      const files = await vscode.workspace.findFiles('**/*.{js,ts,py,java,cpp,go,rs,php,rb,cs}', '**/node_modules/**', 20);
      const fileNames = files.map(f => f.path.split('/').pop()).join(', ');
      context += `Files in workspace: ${fileNames}`;
    } catch (error) {
      context += 'Unable to list workspace files';
    }
    
    return context;
  }

  static getLanguageConfiguration(language: string): any {
    const configs: { [key: string]: any } = {
      'python': {
        indentation: 4,
        lineLength: 79,
        docstringStyle: 'pep257'
      },
      'javascript': {
        indentation: 2,
        semicolons: true,
        quoteStyle: 'single'
      },
      'typescript': {
        indentation: 2,
        semicolons: true,
        quoteStyle: 'single'
      },
      'java': {
        indentation: 4,
        braceStyle: 'allman'
      },
      'cpp': {
        indentation: 2,
        braceStyle: 'stroustrup'
      }
    };

    return configs[language] || { indentation: 2 };
  }
}
