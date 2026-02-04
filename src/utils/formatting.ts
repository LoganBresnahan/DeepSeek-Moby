import * as vscode from 'vscode';
import { logger } from './logger';

export class FormattingEngine {
  private formatterCache = new Map<string, vscode.DocumentFormattingEditProvider>();

  /**
   * Extract code from markdown code blocks
   */
  extractCodeFromMarkdown(text: string): string {
    // Remove markdown code block syntax
    let code = text.replace(/```[\w]*\n/g, '').replace(/\n```/g, '');
    
    // Remove inline code markers
    code = code.replace(/`([^`]+)`/g, '$1');
    
    // Remove any remaining markdown formatting
    code = code.replace(/\*\*(.+?)\*\*/g, '$1');
    code = code.replace(/\*(.+?)\*/g, '$1');
    code = code.replace(/_(.+?)_/g, '$1');
    
    return code.trim();
  }

  /**
   * Format code with language-specific rules
   */
  formatCode(code: string, language: string, context?: string): string {
    // First, ensure consistent line endings
    code = code.replace(/\r\n/g, '\n');
    
    switch (language.toLowerCase()) {
      case 'python':
        return this.formatPython(code);
      case 'javascript':
      case 'typescript':
      case 'js':
      case 'ts':
        return this.formatJavaScript(code);
      case 'java':
        return this.formatJava(code);
      case 'cpp':
      case 'c++':
        return this.formatCpp(code);
      case 'go':
        return this.formatGo(code);
      case 'rust':
        return this.formatRust(code);
      default:
        return this.formatGeneric(code);
    }
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
        
        // Apply the formatting edit
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(document.uri, range, formattedText);
        
        await vscode.workspace.applyEdit(workspaceEdit);
        
        // Read back the formatted document
        const formattedDoc = await vscode.workspace.openTextDocument(document.uri);
        return formattedDoc.getText();
      }
    } catch (error: any) {
      logger.warn('VS Code formatter failed, using basic formatting', error?.message);
    }
    
    return code;
  }

  /**
   * Smart indentation preservation and correction
   */
  normalizeIndentation(code: string, indentSize: number = 2): string {
    const lines = code.split('\n');
    
    // Find minimum indentation (excluding empty lines)
    let minIndent = Infinity;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      
      const leadingSpaces = line.match(/^(\s*)/)?.[1] || '';
      const leadingTabs = leadingSpaces.match(/\t/g) || [];
      const indentLength = leadingTabs.length * indentSize + (leadingSpaces.length - leadingTabs.length);
      
      if (indentLength < minIndent) {
        minIndent = indentLength;
      }
    }
    
    if (minIndent === Infinity) minIndent = 0;
    
    // Normalize indentation
    const normalizedLines = lines.map(line => {
      if (line.trim().length === 0) return line;
      
      // Convert tabs to spaces
      let normalized = line.replace(/\t/g, ' '.repeat(indentSize));
      
      // Remove excess indentation
      const currentIndent = normalized.match(/^(\s*)/)?.[1] || '';
      if (currentIndent.length >= minIndent) {
        normalized = normalized.slice(minIndent);
      }
      
      return normalized;
    });
    
    return normalizedLines.join('\n');
  }

  private formatPython(code: string): string {
    // Apply PEP 8 style guidelines
    let formatted = code;
    
    // Ensure 4-space indentation
    formatted = formatted.replace(/\t/g, '    ');
    
    // Remove trailing whitespace
    formatted = formatted.replace(/[ \t]+$/gm, '');
    
    // Ensure blank lines around functions/classes
    formatted = formatted.replace(/(\n)(def |class |async def )/g, '\n\n$2');
    formatted = formatted.replace(/(\n\n\n)/g, '\n\n');
    
    // Ensure proper spacing around operators (PEP 8)
    formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
    formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');
    
    // Ensure spaces after commas
    formatted = formatted.replace(/,(\w)/g, ', $1');
    
    return this.normalizeIndentation(formatted, 4);
  }

  private formatJavaScript(code: string): string {
    let formatted = code;
    
    // Ensure 2-space indentation (common JS standard)
    formatted = formatted.replace(/\t/g, '  ');
    
    // Add semicolons where missing (simple detection)
    formatted = formatted.replace(/(\w|\)|\]|\"|\')(\n\s*[A-Za-z_$])/g, '$1;$2');
    
    // Ensure spaces around operators
    formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
    formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');
    
    // Ensure spaces after commas
    formatted = formatted.replace(/,(\w)/g, ', $1');
    
    // Ensure spaces after keywords
    formatted = formatted.replace(/(if|for|while|catch|switch)\(/g, '$1 (');
    
    return this.normalizeIndentation(formatted, 2);
  }

  private formatJava(code: string): string {
    let formatted = code;
    
    // Ensure 4-space indentation
    formatted = formatted.replace(/\t/g, '    ');
    
    // Ensure braces on new lines (Java style)
    formatted = formatted.replace(/\s*\{\s*/g, ' {\n');
    formatted = formatted.replace(/\s*\}\s*/g, '\n}\n');
    
    // Ensure proper spacing
    formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
    formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');
    
    return this.normalizeIndentation(formatted, 4);
  }

  private formatCpp(code: string): string {
    let formatted = code;
    
    // Ensure consistent indentation (usually 2 or 4 spaces)
    formatted = formatted.replace(/\t/g, '  ');
    
    // Ensure spaces around operators
    formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?|<<|>>)/g, '$1 $2');
    formatted = formatted.replace(/([+\-*/%=<>!&|^]=?|<<|>>)(\w)/g, '$1 $2');
    
    // Ensure spaces after commas
    formatted = formatted.replace(/,(\w)/g, ', $1');
    
    // Ensure spaces after semicolons in for loops
    formatted = formatted.replace(/for\(([^)]+)\)/g, (match, inner) => {
      return `for(${inner.replace(/;/g, '; ')})`;
    });
    
    return this.normalizeIndentation(formatted, 2);
  }

  private formatGo(code: string): string {
    let formatted = code;
    
    // Go uses tabs for indentation
    formatted = formatted.replace(/^(\s*)/gm, (match) => {
      const spaces = match.length;
      const tabs = Math.floor(spaces / 2); // Assuming 2-space tabs
      return '\t'.repeat(tabs);
    });
    
    // Gofmt style: remove extra blank lines
    formatted = formatted.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    return formatted;
  }

  private formatRust(code: string): string {
    let formatted = code;
    
    // Rust uses 4-space indentation
    formatted = formatted.replace(/\t/g, '    ');
    
    // Ensure proper spacing
    formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?|::)/g, '$1 $2');
    formatted = formatted.replace(/([+\-*/%=<>!&|^]=?|::)(\w)/g, '$1 $2');
    
    // Rust style: spaces after commas
    formatted = formatted.replace(/,(\w)/g, ', $1');
    
    return this.normalizeIndentation(formatted, 4);
  }

  private formatGeneric(code: string): string {
    // Generic formatting for any language
    let formatted = code;
    
    // Normalize line endings
    formatted = formatted.replace(/\r\n/g, '\n');
    
    // Remove multiple blank lines
    formatted = formatted.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    // Trim trailing whitespace
    formatted = formatted.replace(/[ \t]+$/gm, '');
    
    // Ensure consistent indentation (2 spaces)
    formatted = this.normalizeIndentation(formatted, 2);
    
    return formatted;
  }

  /**
   * Detect code language from content or file extension
   */
  detectLanguage(content: string, filename?: string): string {
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const languageMap: { [key: string]: string } = {
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'java': 'java',
        'cpp': 'cpp',
        'cxx': 'cpp',
        'cc': 'cpp',
        'c': 'c',
        'go': 'go',
        'rs': 'rust',
        'php': 'php',
        'rb': 'ruby',
        'cs': 'csharp',
        'swift': 'swift',
        'kt': 'kotlin',
        'scala': 'scala',
        'html': 'html',
        'css': 'css',
        'json': 'json',
        'xml': 'xml',
        'sql': 'sql',
        'sh': 'bash',
        'bash': 'bash'
      };
      
      if (ext && languageMap[ext]) {
        return languageMap[ext];
      }
    }
    
    // Try to detect from content
    if (content.includes('def ') || content.includes('import ') || content.includes('from ')) {
      return 'python';
    } else if (content.includes('function ') || content.includes('const ') || content.includes('let ') || content.includes('var ')) {
      return 'javascript';
    } else if (content.includes('public class ') || content.includes('private ') || content.includes('protected ')) {
      return 'java';
    } else if (content.includes('#include ') || content.includes('using namespace ') || content.includes('std::')) {
      return 'cpp';
    } else if (content.includes('package ') || content.includes('func ') || content.includes('import "')) {
      return 'go';
    } else if (content.includes('fn ') || content.includes('impl ') || content.includes('use ')) {
      return 'rust';
    }
    
    return 'plaintext';
  }
}
