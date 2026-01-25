import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private deepSeekClient: DeepSeekClient;
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastRequest: { document: vscode.TextDocument; position: vscode.Position } | undefined;

  constructor(deepSeekClient: DeepSeekClient) {
    this.deepSeekClient = deepSeekClient;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | undefined> {
    // Debounce requests
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Check if this is the same request
    const currentRequest = { document, position };
    if (JSON.stringify(this.lastRequest) === JSON.stringify(currentRequest)) {
      return undefined;
    }
    this.lastRequest = currentRequest;

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        try {
          const completion = await this.deepSeekClient.getContextualCompletion(
            vscode.window.activeTextEditor!,
            position
          );

          if (completion && !token.isCancellationRequested) {
            const item = new vscode.InlineCompletionItem(
              completion,
              new vscode.Range(position, position)
            );
            resolve(new vscode.InlineCompletionList([item]));
          } else {
            resolve(undefined);
          }
        } catch (error) {
          console.error('Completion error:', error);
          resolve(undefined);
        }
      }, 300); // 300ms debounce
    });
  }
}
