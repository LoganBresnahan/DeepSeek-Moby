import * as vscode from 'vscode';
import { logger } from './logger';
import { extractCodeFromMarkdown, formatCode, normalizeIndentation } from './formattingCore';

/**
 * The vscode edge of code formatting. All pure string logic lives in
 * formattingCore.ts; this class delegates and owns the one method that
 * needs the VS Code formatter provider.
 */
export class FormattingEngine {
  extractCodeFromMarkdown(text: string): string {
    return extractCodeFromMarkdown(text);
  }

  formatCode(code: string, language: string, _context?: string): string {
    return formatCode(code, language);
  }

  normalizeIndentation(code: string, indentSize: number = 2): string {
    return normalizeIndentation(code, indentSize);
  }

  /**
   * Apply VS Code's built-in formatter for final polish
   */
  async applyVSCodeFormatter(code: string, language: string): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument({
        content: code,
        language
      });

      const formatEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        { insertSpaces: true, tabSize: 2 }
      );

      if (formatEdits && formatEdits.length > 0) {
        const edit = formatEdits[0];
        const range = edit.range;
        const formattedText = edit.newText;

        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(document.uri, range, formattedText);

        await vscode.workspace.applyEdit(workspaceEdit);

        const formattedDoc = await vscode.workspace.openTextDocument(document.uri);
        return formattedDoc.getText();
      }
    } catch (error: any) {
      logger.warn('VS Code formatter failed, using basic formatting', error?.message);
    }

    return code;
  }
}
