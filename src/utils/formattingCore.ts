/**
 * Pure code-formatting logic — no vscode imports so it is directly
 * unit-testable. The VS Code formatter pass lives in formatting.ts.
 */

export function extractCodeFromMarkdown(text: string): string {
  let code = text.replace(/```[\w]*\n/g, '').replace(/\n```/g, '');
  code = code.replace(/`([^`]+)`/g, '$1');
  code = code.replace(/\*\*(.+?)\*\*/g, '$1');
  code = code.replace(/\*(.+?)\*/g, '$1');
  code = code.replace(/_(.+?)_/g, '$1');
  return code.trim();
}

export function formatCode(code: string, language: string): string {
  code = code.replace(/\r\n/g, '\n');

  switch (language.toLowerCase()) {
    case 'python':
      return formatPython(code);
    case 'javascript':
    case 'typescript':
    case 'js':
    case 'ts':
      return formatJavaScript(code);
    case 'java':
      return formatJava(code);
    case 'cpp':
    case 'c++':
      return formatCpp(code);
    case 'go':
      return formatGo(code);
    case 'rust':
      return formatRust(code);
    default:
      return formatGeneric(code);
  }
}

export function normalizeIndentation(code: string, indentSize: number = 2): string {
  const lines = code.split('\n');

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

  const normalizedLines = lines.map(line => {
    if (line.trim().length === 0) return line;

    let normalized = line.replace(/\t/g, ' '.repeat(indentSize));

    const currentIndent = normalized.match(/^(\s*)/)?.[1] || '';
    if (currentIndent.length >= minIndent) {
      normalized = normalized.slice(minIndent);
    }

    return normalized;
  });

  return normalizedLines.join('\n');
}

function formatPython(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\t/g, '    ');
  formatted = formatted.replace(/[ \t]+$/gm, '');
  formatted = formatted.replace(/(\n)(def |class |async def )/g, '\n\n$2');
  formatted = formatted.replace(/(\n\n\n)/g, '\n\n');
  formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
  formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');
  formatted = formatted.replace(/,(\w)/g, ', $1');

  return normalizeIndentation(formatted, 4);
}

function formatJavaScript(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\t/g, '  ');
  formatted = formatted.replace(/(\w|\)|\]|\"|\')(\n\s*[A-Za-z_$])/g, '$1;$2');
  formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
  formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');
  formatted = formatted.replace(/,(\w)/g, ', $1');
  formatted = formatted.replace(/(if|for|while|catch|switch)\(/g, '$1 (');

  return normalizeIndentation(formatted, 2);
}

function formatJava(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\t/g, '    ');
  formatted = formatted.replace(/\s*\{\s*/g, ' {\n');
  formatted = formatted.replace(/\s*\}\s*/g, '\n}\n');
  formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?)/g, '$1 $2');
  formatted = formatted.replace(/([+\-*/%=<>!&|^]=?)(\w)/g, '$1 $2');

  return normalizeIndentation(formatted, 4);
}

function formatCpp(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\t/g, '  ');
  formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?|<<|>>)/g, '$1 $2');
  formatted = formatted.replace(/([+\-*/%=<>!&|^]=?|<<|>>)(\w)/g, '$1 $2');
  formatted = formatted.replace(/,(\w)/g, ', $1');
  formatted = formatted.replace(/for\(([^)]+)\)/g, (_match, inner) => {
    return `for(${inner.replace(/;/g, '; ')})`;
  });

  return normalizeIndentation(formatted, 2);
}

function formatGo(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/^(\s*)/gm, (match) => {
    const spaces = match.length;
    const tabs = Math.floor(spaces / 2);
    return '\t'.repeat(tabs);
  });
  formatted = formatted.replace(/\n\s*\n\s*\n/g, '\n\n');

  return formatted;
}

function formatRust(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\t/g, '    ');
  formatted = formatted.replace(/(\w)([+\-*/%=<>!&|^]=?|::)/g, '$1 $2');
  formatted = formatted.replace(/([+\-*/%=<>!&|^]=?|::)(\w)/g, '$1 $2');
  formatted = formatted.replace(/,(\w)/g, ', $1');

  return normalizeIndentation(formatted, 4);
}

function formatGeneric(code: string): string {
  let formatted = code;

  formatted = formatted.replace(/\r\n/g, '\n');
  formatted = formatted.replace(/\n\s*\n\s*\n/g, '\n\n');
  formatted = formatted.replace(/[ \t]+$/gm, '');
  formatted = normalizeIndentation(formatted, 2);

  return formatted;
}
