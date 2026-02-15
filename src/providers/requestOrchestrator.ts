import * as vscode from 'vscode';
import { DeepSeekClient, Message as ApiMessage } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { logger } from '../utils/logger';
import { workspaceTools, applyCodeEditTool, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { DiffManager } from './diffManager';
import { WebSearchManager } from './webSearchManager';
import { FileContextManager } from './fileContextManager';
import {
  parseShellCommands,
  containsShellCommands,
  containsCodeEdits,
  executeShellCommands,
  formatShellResultsForContext,
  getReasonerShellPrompt,
  stripShellTags,
  ShellResult
} from '../tools/reasonerShellExecutor';
import { ContentTransformBuffer } from '../utils/ContentTransformBuffer';
import type {
  StartResponseEvent,
  EndResponseEvent,
  AutoContinuationEvent,
  ToolDetail,
  ToolCallUpdateEvent,
  ShellExecutingEvent,
  ShellResultsEvent,
} from './types';

export class RequestOrchestrator {
  // ── Events (streaming) ──
  private readonly _onStartResponse = new vscode.EventEmitter<StartResponseEvent>();
  private readonly _onStreamToken = new vscode.EventEmitter<{ token: string }>();
  private readonly _onStreamReasoning = new vscode.EventEmitter<{ token: string }>();
  private readonly _onEndResponse = new vscode.EventEmitter<EndResponseEvent>();
  private readonly _onGenerationStopped = new vscode.EventEmitter<void>();
  private readonly _onIterationStart = new vscode.EventEmitter<{ iteration: number }>();
  private readonly _onAutoContinuation = new vscode.EventEmitter<AutoContinuationEvent>();

  // ── Events (tool calls) ──
  private readonly _onToolCallsStart = new vscode.EventEmitter<{ tools: ToolDetail[] }>();
  private readonly _onToolCallsUpdate = new vscode.EventEmitter<{ tools: ToolDetail[] }>();
  private readonly _onToolCallUpdate = new vscode.EventEmitter<ToolCallUpdateEvent>();
  private readonly _onToolCallsEnd = new vscode.EventEmitter<void>();

  // ── Events (shell execution) ──
  private readonly _onShellExecuting = new vscode.EventEmitter<ShellExecutingEvent>();
  private readonly _onShellResults = new vscode.EventEmitter<ShellResultsEvent>();

  // ── Events (session) ──
  private readonly _onSessionCreated = new vscode.EventEmitter<{ sessionId: string; model: string }>();

  // ── Events (summarization) ──
  private readonly _onSummarizationStarted = new vscode.EventEmitter<void>();
  private readonly _onSummarizationCompleted = new vscode.EventEmitter<void>();

  // ── Events (errors) ──
  private readonly _onError = new vscode.EventEmitter<{ error: string }>();
  private readonly _onWarning = new vscode.EventEmitter<{ message: string }>();

  // ── Public event accessors ──
  readonly onStartResponse = this._onStartResponse.event;
  readonly onStreamToken = this._onStreamToken.event;
  readonly onStreamReasoning = this._onStreamReasoning.event;
  readonly onEndResponse = this._onEndResponse.event;
  readonly onGenerationStopped = this._onGenerationStopped.event;
  readonly onIterationStart = this._onIterationStart.event;
  readonly onAutoContinuation = this._onAutoContinuation.event;
  readonly onToolCallsStart = this._onToolCallsStart.event;
  readonly onToolCallsUpdate = this._onToolCallsUpdate.event;
  readonly onToolCallUpdate = this._onToolCallUpdate.event;
  readonly onToolCallsEnd = this._onToolCallsEnd.event;
  readonly onShellExecuting = this._onShellExecuting.event;
  readonly onShellResults = this._onShellResults.event;
  readonly onSessionCreated = this._onSessionCreated.event;
  readonly onSummarizationStarted = this._onSummarizationStarted.event;
  readonly onSummarizationCompleted = this._onSummarizationCompleted.event;
  readonly onError = this._onError.event;
  readonly onWarning = this._onWarning.event;

  // ── State ──
  private abortController: AbortController | null = null;
  private contentBuffer: ContentTransformBuffer | null = null;

  constructor(
    private deepSeekClient: DeepSeekClient,
    private conversationManager: ConversationManager,
    private statusBar: StatusBar,
    private diffManager: DiffManager,
    private webSearchManager: WebSearchManager,
    private fileContextManager: FileContextManager,
  ) {
    // DiffManager needs to flush the content buffer before emitting events
    this.diffManager.setFlushCallback(() => {
      if (this.contentBuffer) {
        this.contentBuffer.flush();
      }
    });
  }

  /**
   * Main entry point — replaces ChatProvider.handleUserMessage().
   * currentSessionId is passed in (ChatProvider owns session lifecycle).
   * Returns the final sessionId so ChatProvider can update its state.
   */
  async handleMessage(
    message: string,
    currentSessionId: string | null,
    editorContextProvider: () => Promise<string>,
    attachments?: Array<{ content: string; name: string; size: number }>
  ): Promise<{ sessionId: string | null }> {
    // Clear processed code blocks and pending diffs for new conversation turn
    this.diffManager.clearProcessedBlocks();
    this.diffManager.clearPendingDiffs();
    // Clear read files tracking and extract user intent
    this.fileContextManager.clearTurnTracking();
    this.fileContextManager.extractFileIntent(message);

    // Get or create current session
    let sessionId = currentSessionId;
    if (!sessionId) {
      const editor = vscode.window.activeTextEditor;
      const language = editor?.document.languageId;
      const session = await this.conversationManager.startNewSession(
        message,
        this.deepSeekClient.getModel(),
        language
      );
      sessionId = session.id;

      this._onSessionCreated.fire({
        sessionId: session.id,
        model: this.deepSeekClient.getModel()
      });
    }

    // Save user message to history (UI already shows it from frontend)
    if (sessionId) {
      await this.conversationManager.addMessageToCurrentSession({
        role: 'user',
        content: message
      });
    }

    // Build system prompt
    const systemPrompt = await this.buildSystemPrompt(message, editorContextProvider);
    const isReasonerModel = this.deepSeekClient.isReasonerModel();

    // Mutable state object shared with streamAndIterate so catch block
    // can access partial results even if streamAndIterate throws (abort)
    const streamState = {
      fullResponse: '',
      fullReasoning: '',
      accumulatedResponse: '',
      reasoningIterations: [] as string[],
      currentIterationReasoning: '',
      contentIterations: [] as string[],
      currentIterationContent: '',
      shellResultsForHistory: [] as ShellResult[],
    };

    // Clear file changes tracking for this response
    this.diffManager.clearResponseFileChanges();

    // Create abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Get the current correlation ID for cross-boundary tracing
    const correlationId = logger.getCurrentCorrelationId();

    this._onStartResponse.fire({
      isReasoner: isReasonerModel,
      correlationId: correlationId || undefined
    });

    // Initialize content transform buffer for debounced streaming
    this.contentBuffer = new ContentTransformBuffer({
      debounceMs: 150,
      debug: false,
      log: (msg) => logger.debug(msg),
      onFlush: (segments) => {
        for (const segment of segments) {
          switch (segment.type) {
            case 'text':
              this._onStreamToken.fire({ token: segment.content as string });
              break;
            case 'shell':
              logger.debug(`[ContentBuffer] Detected shell commands, will be handled after iteration`);
              break;
            case 'thinking':
              logger.debug(`[ContentBuffer] Detected thinking tags, handled separately`);
              break;
          }
        }
      }
    });

    // Log the API request
    const model = this.deepSeekClient.getModel();
    const hasAttachments = attachments && attachments.length > 0;
    const requestStartTime = Date.now();

    // Declare outside try so it's accessible in catch for partial save
    let toolCallsForHistory: Array<{ name: string; detail: string; status: string }> = [];

    try {
      // Get current session messages for context (user message already saved above)
      const currentSession = await this.conversationManager.getCurrentSession();
      const sessionMessages = currentSession
        ? await this.conversationManager.getSessionMessagesCompat(currentSession.id)
        : [];
      const messageCount = sessionMessages.length || 1;
      logger.apiRequest(model, messageCount, hasAttachments);

      // Build messages array - handle multimodal content if attachments present
      const historyMessages: ApiMessage[] = [];
      for (const msg of sessionMessages) {
        historyMessages.push({
          role: msg.role,
          content: msg.content
        });
      }

      // If this message has file attachments, include their contents in the context
      if (attachments && attachments.length > 0) {
        let fileContext = '\n\n--- Attached Files ---\n';
        for (const attachment of attachments) {
          const content = attachment.content || '';
          fileContext += `\n### File: ${attachment.name}\n\`\`\`\n${content}\n\`\`\`\n`;
        }
        fileContext += '--- End Attached Files ---\n';

        if (historyMessages.length > 0) {
          const lastMsg = historyMessages[historyMessages.length - 1];
          if (lastMsg.role === 'user') {
            lastMsg.content = lastMsg.content + fileContext;
          }
        }
      }

      // If user has selected files for context, include them
      const selectedFilesContext = this.fileContextManager.getSelectedFilesContext();
      if (selectedFilesContext) {
        if (historyMessages.length > 0) {
          const lastMsg = historyMessages[historyMessages.length - 1];
          if (lastMsg.role === 'user') {
            lastMsg.content = lastMsg.content + selectedFilesContext;
            logger.info(`[RequestOrchestrator] Selected files context injected into user message`);
          }
        }
      }

      // --- Context Window Management ---
      const snapshotSummary = currentSession
        ? this.conversationManager.getLatestSnapshotSummary(currentSession.id)
        : undefined;

      const contextResult = await this.deepSeekClient.buildContext(
        historyMessages,
        systemPrompt,
        snapshotSummary
      );

      const contextMessages: ApiMessage[] = contextResult.messages as ApiMessage[];

      // Tool calling loop (only for non-reasoner models)
      let streamingSystemPrompt = systemPrompt;
      if (!isReasonerModel) {
        const { toolMessages, limitReached, budgetExceeded, allToolDetails: toolDetails } = await this.runToolLoop(
          contextMessages, systemPrompt, signal,
          contextResult.tokenCount, contextResult.budget
        );
        toolCallsForHistory = toolDetails;
        contextMessages.push(...toolMessages);

        if (toolMessages.length > 0) {
          const limitWarning = (limitReached || budgetExceeded)
            ? `\n\nNOTE: The tool calling limit was reached. Summarize what you were able to accomplish and explain what remains to be done.`
            : '';
          streamingSystemPrompt = systemPrompt + `\n\nIMPORTANT: The tool exploration phase is now complete. You have already gathered the necessary information using tools.\nNow provide your final response based on what you learned. Do NOT attempt to use any more tools or output any tool-calling markup - just provide your answer directly in plain text.${limitWarning}`;
        }
      }

      // Run streaming + shell iteration loop (mutates streamState in-place)
      await this.streamAndIterate(
        contextMessages, streamingSystemPrompt, signal, message, isReasonerModel,
        streamState
      );

      // Flush and reset the content buffer before finalizing
      if (this.contentBuffer) {
        logger.info(`[Buffer] FLUSH before endResponse (final)`);
        this.contentBuffer.flush();
        logger.info(`[Buffer] RESET after final flush`);
        this.contentBuffer.reset();
      }

      // Strip any DSML markup and shell tags from the final response
      let cleanResponse = stripDSML(streamState.accumulatedResponse);
      cleanResponse = stripShellTags(cleanResponse);

      // Unfenced SEARCH/REPLACE Detection (Fallback)
      if (this.diffManager.currentEditMode !== 'manual') {
        await this.diffManager.detectAndProcessUnfencedEdits(cleanResponse);
      }

      // Finalize response
      this._onEndResponse.fire({
        role: 'assistant',
        content: cleanResponse,
        reasoning_content: streamState.fullReasoning || undefined,
        reasoning_iterations: streamState.reasoningIterations.length > 0 ? streamState.reasoningIterations : undefined,
        content_iterations: streamState.contentIterations.length > 0 ? streamState.contentIterations : undefined,
        editMode: this.diffManager.currentEditMode
      });

      // History Save Pipeline
      await this.saveToHistory(
        sessionId, cleanResponse, streamState.fullReasoning, model,
        streamState.reasoningIterations, streamState.contentIterations,
        toolCallsForHistory, streamState.shellResultsForHistory
      );

      // Log successful response
      const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + streamState.fullReasoning);
      logger.apiResponse(tokenCount, Date.now() - requestStartTime);

      // Update status bar
      this.statusBar.updateLastResponse();

      // ── Proactive Context Compression ──
      // After the response is delivered and saved, check context pressure.
      // If usage > 80%, proactively summarize so the snapshot is ready
      // BEFORE ContextBuilder needs to drop messages on the next request.
      if (sessionId && contextResult.budget > 0) {
        const usageRatio = contextResult.tokenCount / contextResult.budget;
        if (usageRatio > 0.80 && !this.conversationManager.hasFreshSummary(sessionId)) {
          logger.info(
            `[Snapshot] Proactive trigger fired` +
            ` | usage=${(usageRatio * 100).toFixed(1)}%` +
            ` (${contextResult.tokenCount.toLocaleString()}/${contextResult.budget.toLocaleString()})` +
            ` | session=${sessionId.substring(0, 8)}`
          );
          this._onSummarizationStarted.fire();
          try {
            await this.conversationManager.createSnapshot(sessionId);
            logger.info(`[Snapshot] Proactive summarization complete | session=${sessionId.substring(0, 8)}`);
          } catch (summarizeError: any) {
            logger.error(`[Snapshot] Proactive summarization failed: ${summarizeError.message}`);
          }
          this._onSummarizationCompleted.fire();
        } else if (usageRatio > 0.80) {
          logger.debug(
            `[Snapshot] Proactive trigger skipped — fresh summary exists` +
            ` | usage=${(usageRatio * 100).toFixed(1)}%` +
            ` | session=${sessionId.substring(0, 8)}`
          );
        }
      }
    } catch (error: any) {
      // Check if this was an abort (user stopped generation)
      if (error.name === 'CanceledError' || error.name === 'AbortError' || signal.aborted) {
        // Save partial response to history if there's content
        const partialContent = streamState.accumulatedResponse || streamState.fullResponse;
        if (sessionId && (partialContent || streamState.fullReasoning)) {
          const cleanPartialResponse = stripShellTags(stripDSML(partialContent));

          // Record reasoning iterations that completed
          for (let i = 0; i < streamState.reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(streamState.reasoningIterations[i], i);
          }

          // Record the partial assistant message
          const partialText = cleanPartialResponse
            ? `${cleanPartialResponse}\n\n*[Generation stopped]*`
            : '*[Generation stopped]*';
          await this.conversationManager.recordAssistantMessage(partialText, model, 'length');
          logger.info(`[RequestOrchestrator] Saved partial response to history`);
        }
        // Don't show error for user-initiated stops
        return { sessionId };
      }
      // Log the error
      logger.error(error.message, error.stack);

      // Check if error is related to context length and provide helpful message about attachments
      let errorMessage = error.message;
      const lowerMessage = errorMessage.toLowerCase();
      if (lowerMessage.includes('context') || lowerMessage.includes('token') || lowerMessage.includes('length') || lowerMessage.includes('too long')) {
        const totalAttachmentSize = attachments ? attachments.reduce((sum: number, a: any) => sum + (a.content?.length || 0), 0) : 0;
        if (totalAttachmentSize > 0) {
          const sizeKB = (totalAttachmentSize / 1024).toFixed(1);
          errorMessage = `Context limit exceeded. Your attached files total ${sizeKB}KB - try attaching smaller or fewer files.`;
        }
      }

      this._onError.fire({ error: errorMessage });
    } finally {
      this.abortController = null;
      // Clean up content buffer
      if (this.contentBuffer) {
        logger.info(`[Buffer] FLUSH in finally block (cleanup)`);
        this.contentBuffer.flush();
        logger.info(`[Buffer] RESET in finally block (cleanup)`);
        this.contentBuffer.reset();
      }
    }

    return { sessionId };
  }

  /** Abort current request. */
  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      logger.apiAborted();
    }
    this._onGenerationStopped.fire();
  }

  dispose(): void {
    this._onStartResponse.dispose();
    this._onStreamToken.dispose();
    this._onStreamReasoning.dispose();
    this._onEndResponse.dispose();
    this._onGenerationStopped.dispose();
    this._onIterationStart.dispose();
    this._onAutoContinuation.dispose();
    this._onToolCallsStart.dispose();
    this._onToolCallsUpdate.dispose();
    this._onToolCallUpdate.dispose();
    this._onToolCallsEnd.dispose();
    this._onShellExecuting.dispose();
    this._onShellResults.dispose();
    this._onSessionCreated.dispose();
    this._onSummarizationStarted.dispose();
    this._onSummarizationCompleted.dispose();
    this._onError.dispose();
    this._onWarning.dispose();
  }

  // ── Private: System Prompt Builder ──

  private async buildSystemPrompt(
    message: string,
    editorContextProvider: () => Promise<string>
  ): Promise<string> {
    const isReasonerModel = this.deepSeekClient.isReasonerModel();

    // Get custom system prompt from settings (if set)
    const config = vscode.workspace.getConfiguration('deepseek');
    const customSystemPrompt = config.get<string>('systemPrompt') || '';

    let systemPrompt = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.\n`;

    // Prepend custom system prompt if set
    if (customSystemPrompt.trim()) {
      systemPrompt = `${customSystemPrompt.trim()}\n\n---\n\n${systemPrompt}`;
    }

    // Add exploration capabilities based on model type
    if (isReasonerModel) {
      systemPrompt += getReasonerShellPrompt();
    } else {
      systemPrompt += `\nYou have access to tools that let you explore the codebase:\n- read_file: Read contents of any file in the workspace\n- search_files: Find files by name pattern (glob)\n- grep_content: Search for text/patterns in file contents\n- list_directory: See directory structure\n- get_file_info: Get file metadata and preview\n\nUSE THESE TOOLS to understand the codebase before making suggestions. When the user asks about code or wants changes:\n1. First explore relevant files using the tools\n2. Read the actual source code to understand the context\n3. Then provide accurate, informed responses\n`;
    }

    // Add edit mode context to system prompt
    const editModeDescriptions: Record<string, string> = {
      manual: 'Code blocks will be displayed for reference. The user will manually copy and apply changes.',
      ask: 'Code blocks will trigger a diff view where the user can review and accept/reject changes.',
      auto: 'Code blocks will be automatically applied to files without user confirmation.'
    };

    systemPrompt += `\nIMPORTANT - Code Edit Format Requirements\n\n**Current Edit Mode: ${this.diffManager.currentEditMode.toUpperCase()}**\n${editModeDescriptions[this.diffManager.currentEditMode]}\n\n**CRITICAL FORMAT: Every code edit MUST use this exact structure:**\n\n\`\`\`<language>\n# File: path/to/file.ext\n<<<<<<< SEARCH\nexact code to find (copy from file verbatim)\n======= AND\nreplacement code\n>>>>>>> REPLACE\n\`\`\`\n\n**EXAMPLE - Editing a TypeScript function:**\n\`\`\`typescript\n# File: src/utils/helper.ts\n<<<<<<< SEARCH\nexport function calculate(x: number): number {\n  return x + 1;\n}\n======= AND\nexport function calculate(x: number): number {\n  return x * 2;  // Changed from addition to multiplication\n}\n>>>>>>> REPLACE\n\`\`\`\n\n**REQUIREMENTS (MANDATORY - edits will fail without these):**\n1. ✓ Code block must start with triple backticks and optional language\n2. ✓ First line INSIDE the code block must be "# File: <path>"\n3. ✓ SEARCH section contains EXACT code from the file (including whitespace)\n4. ✓ All markers (<<<<<<< SEARCH, ======= AND, >>>>>>> REPLACE) must be INSIDE the code block\n5. ✓ ONE code block per file edit - do NOT split into separate "before" and "after" blocks\n\n**For ADDING new code** (inserting new functions/methods):\n\`\`\`typescript\n# File: src/services/api.ts\n<<<<<<< SEARCH\n  async fetchUser(id: string): Promise<User> {\n    // existing method\n  }\n======= AND\n  async fetchUser(id: string): Promise<User> {\n    // existing method\n  }\n\n  async createUser(data: UserData): Promise<User> {\n    // new method I\'m adding\n    return this.post(\'/users\', data);\n  }\n>>>>>>> REPLACE\n\`\`\`\n\n**For CREATING new files** (empty SEARCH section):\n\`\`\`typescript\n# File: src/utils/newFile.ts\n<<<<<<< SEARCH\n======= AND\n// This is a brand new file\nexport function newHelper(): string {\n  return "hello";\n}\n>>>>>>> REPLACE\n\`\`\`\n\n**COMMON MISTAKES TO AVOID:**\n✗ Forgetting the "# File:" header (edit won\'t be detected)\n✗ Putting SEARCH/REPLACE outside code fences (won\'t be parsed)\n✗ Using separate code blocks for "before" and "after" (use ONE block)\n✗ Showing code without the edit format (won\'t be applied)\n\n`;

    // Add editor context
    const editorContext = await editorContextProvider();
    if (editorContext) {
      systemPrompt += `\n${editorContext}`;
    }

    // Add modified files context to prevent redundant edits
    const modifiedFilesContext = this.diffManager.getModifiedFilesContext();
    if (modifiedFilesContext) {
      systemPrompt += modifiedFilesContext;
    }

    // Auto web search if enabled (search BEFORE DeepSeek, not via tool calls)
    const webSearchContext = await this.webSearchManager.searchForMessage(message);

    // Add search results to system prompt with context for LLM
    if (webSearchContext) {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      systemPrompt += `\n\n--- CURRENT WEB SEARCH RESULTS (${today}) ---\nThe following are real-time web search results. Use this information to answer questions\nabout current events, dates, times, news, or anything requiring up-to-date information.\nDo NOT say you lack access to current information - these results ARE current.\n\n${webSearchContext}\n--- END WEB SEARCH RESULTS ---\n`;
    }

    return systemPrompt;
  }

  // ── Private: Streaming + Shell Iteration Loop ──

  private async streamAndIterate(
    contextMessages: ApiMessage[],
    streamingSystemPrompt: string,
    signal: AbortSignal,
    originalUserMessage: string,
    isReasonerModel: boolean,
    state: {
      accumulatedResponse: string;
      fullResponse: string;
      fullReasoning: string;
      reasoningIterations: string[];
      currentIterationReasoning: string;
      contentIterations: string[];
      currentIterationContent: string;
      shellResultsForHistory: ShellResult[];
    }
  ): Promise<void> {
    // Reasoner shell loop - run shell commands if R1 outputs them
    const shellConfig = vscode.workspace.getConfiguration('deepseek');
    const configuredShellLimit = shellConfig.get<number>('maxShellIterations') ?? 100;
    const maxShellIterations = configuredShellLimit >= 100 ? Infinity : configuredShellLimit;
    let shellIteration = 0;
    let currentSystemPrompt = streamingSystemPrompt;
    let currentHistoryMessages = [...contextMessages];

    // Auto-continuation tracking for R1
    const maxAutoContinuations = 2;
    let autoContinuationCount = 0;
    let lastIterationHadShellCommands = false;

    // Total iteration safeguard (shell iterations + auto-continuations)
    const maxTotalIterations = 10;
    let totalIterations = 0;

    do {
      totalIterations++;
      if (totalIterations > maxTotalIterations) {
        logger.warn(`[R1-Shell] Total iteration limit reached (${maxTotalIterations}), breaking loop`);
        break;
      }

      // Track iteration-specific response
      let iterationResponse = '';

      // Timing metrics for debugging
      const iterationStartTime = Date.now();
      let firstReasoningTokenTime: number | null = null;
      let firstContentTokenTime: number | null = null;

      if (isReasonerModel) {
        logger.info(`[R1-Shell] Starting iteration ${shellIteration + 1}, messages in context: ${currentHistoryMessages.length}`);
        logger.info(`[Timing] Iteration ${shellIteration + 1} started at ${new Date().toISOString()}`);
        logger.setIteration(shellIteration + 1);
        this._onIterationStart.fire({ iteration: shellIteration + 1 });
      } else {
        logger.setIteration(1);
      }

      const _response = await this.deepSeekClient.streamChat(
        currentHistoryMessages,
        async (token) => {
          // Track timing for first content token
          if (!firstContentTokenTime) {
            firstContentTokenTime = Date.now();
            const waitTime = firstContentTokenTime - iterationStartTime;
            const afterReasoning = firstReasoningTokenTime
              ? firstContentTokenTime - firstReasoningTokenTime
              : 0;
            logger.info(`[Timing] First content token after ${waitTime}ms (${afterReasoning}ms after reasoning started)`);
            if (!isReasonerModel) {
              logger.apiStreamProgress('first-token');
            } else if (firstReasoningTokenTime) {
              logger.apiStreamProgress('thinking-end');
            }
            logger.apiStreamProgress('content-start');
          }

          logger.apiStreamChunk(token.length, 'text');

          iterationResponse += token;
          state.accumulatedResponse += token;
          state.currentIterationContent += token;

          // Use content buffer for debounced streaming (filters shell tags)
          if (this.contentBuffer) {
            this.contentBuffer.append(token);
          } else {
            this._onStreamToken.fire({ token });
          }

          // Detect complete code blocks and auto-handle in "ask" or "auto" mode
          this.diffManager.handleCodeBlockDetection(state.accumulatedResponse);
        },
        currentSystemPrompt,
        // Reasoning callback for deepseek-reasoner
        isReasonerModel ? (reasoningToken) => {
          if (!firstReasoningTokenTime) {
            firstReasoningTokenTime = Date.now();
            const waitTime = firstReasoningTokenTime - iterationStartTime;
            logger.info(`[Timing] First reasoning token after ${waitTime}ms`);
            logger.apiStreamProgress('first-token');
            logger.apiStreamProgress('thinking-start');
          }

          logger.apiStreamChunk(reasoningToken.length, 'thinking');

          state.fullReasoning += reasoningToken;
          state.currentIterationReasoning += reasoningToken;
          this._onStreamReasoning.fire({ token: reasoningToken });
        } : undefined,
        { signal }
      );

      // Log iteration completion for debugging R1 continuation
      if (isReasonerModel) {
        const iterationDuration = Date.now() - iterationStartTime;
        logger.info(`[Timing] Iteration ${shellIteration + 1} complete in ${iterationDuration}ms`);
        logger.info(`[R1-Shell] Iteration ${shellIteration + 1} complete, response length: ${iterationResponse.length} chars`);
        logger.info(`[R1-Shell] Response preview: ${iterationResponse.substring(0, 300).replace(/\n/g, '\\n')}...`);

        // Save iteration reasoning AND content, reset for next iteration
        if (state.currentIterationReasoning) {
          state.reasoningIterations.push(state.currentIterationReasoning);
          state.currentIterationReasoning = '';
        }
        if (state.currentIterationContent) {
          state.contentIterations.push(state.currentIterationContent);
          state.currentIterationContent = '';
        }
      }

      // Check for shell commands in THIS iteration's response AND reasoning
      const combinedForShellCheck = iterationResponse + (state.currentIterationReasoning || '');
      if (isReasonerModel && containsShellCommands(combinedForShellCheck)) {
        shellIteration++;
        lastIterationHadShellCommands = true;
        const inReasoning = containsShellCommands(state.currentIterationReasoning || '');
        const inContent = containsShellCommands(iterationResponse);
        logger.info(`[R1-Shell] Iteration ${shellIteration}: found shell commands (inContent=${inContent}, inReasoning=${inReasoning})`);

        // Parse and execute shell commands from both streams
        const commands = parseShellCommands(combinedForShellCheck);
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (commands.length > 0 && workspacePath) {
          // IMPORTANT: Flush buffer before sending shellExecuting to prevent race condition
          if (this.contentBuffer) {
            logger.info(`[Buffer] FLUSH before shellExecuting (${commands.length} commands)`);
            this.contentBuffer.flush();
          }

          // Notify frontend about shell execution
          const shellCommandsPayload = commands.map(c => ({
            command: c.command,
            description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command
          }));
          logger.info(`[Frontend] Sending shellExecuting message: ${shellCommandsPayload.length} commands`);
          this._onShellExecuting.fire({ commands: shellCommandsPayload });

          // Check "Walk on the Wild Side" setting
          const shellConfig = vscode.workspace.getConfiguration('deepseek');
          const allowAllCommands = shellConfig.get<boolean>('allowAllShellCommands') ?? false;

          // Execute commands
          const shellStartTime = Date.now();
          logger.info(`[Timing] Shell execution started at ${new Date().toISOString()}`);
          const results = await executeShellCommands(commands, workspacePath, {
            allowAllCommands
          });
          const shellDuration = Date.now() - shellStartTime;
          logger.info(`[Timing] Shell execution completed in ${shellDuration}ms`);
          state.shellResultsForHistory.push(...results);

          // Notify frontend of results
          this._onShellResults.fire({
            results: results.map(r => ({
              command: r.command,
              output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
              success: r.success
            }))
          });

          // Add to context and continue
          const resultsContext = formatShellResultsForContext(results);

          currentHistoryMessages.push({
            role: 'assistant',
            content: iterationResponse
          });

          currentHistoryMessages.push({
            role: 'user',
            content: `Shell command results:\n${resultsContext}\n\n---\nREMINDER - Your original task was:\n"${originalUserMessage}"\n\nYou have explored the codebase. Now you MUST either:\n1. Run additional shell commands if you need more information, OR\n2. Produce the code edits using properly formatted code blocks with # File: headers\n\nDo NOT just describe what you found. Complete the original task with actual code changes.`
          });

          // Update system prompt for continuation
          currentSystemPrompt = streamingSystemPrompt + `\n\nThe shell commands have been executed and results are provided.\nORIGINAL TASK: "${originalUserMessage}"\n\nYou MUST now complete this task:\n- If you need more information, run additional shell commands\n- Otherwise, produce the code edits in properly formatted code blocks with # File: headers\n- Your response is NOT complete until you provide the actual code changes\n- Do NOT end with just analysis or description - include the code edits`;

          logger.info(`[R1-Shell] Injected ${results.length} shell results for task: "${originalUserMessage.substring(0, 50)}...", continuing...`);
        }
      } else {
        // No shell commands in this iteration
        if (isReasonerModel) {
          logger.info(`[R1-Shell] No shell commands in iteration, checking for auto-continuation...`);
          logger.info(`[R1-Shell] shellIteration=${shellIteration}, autoContinuationCount=${autoContinuationCount}, lastIterationHadShellCommands=${lastIterationHadShellCommands}`);

          const hasCodeEdits = containsCodeEdits(state.accumulatedResponse);
          logger.info(`[R1-Shell] Response has code edits: ${hasCodeEdits}`);

          if (shellIteration > 0 && !hasCodeEdits && autoContinuationCount < maxAutoContinuations) {
            autoContinuationCount++;
            logger.info(`[R1-Shell] Auto-continuing (${autoContinuationCount}/${maxAutoContinuations}): shell commands were executed but no code edits produced`);

            this._onAutoContinuation.fire({
              count: autoContinuationCount,
              max: maxAutoContinuations,
              reason: 'No code edits after shell exploration'
            });

            currentHistoryMessages.push({
              role: 'assistant',
              content: iterationResponse
            });

            currentHistoryMessages.push({
              role: 'user',
              content: `You explored the codebase but didn't complete the task.\n\nORIGINAL TASK: "${originalUserMessage}"\n\nYou MUST now produce the code edits. Use the SEARCH/REPLACE format with "# File:" headers:\n\n\`\`\`<language>\n# File: path/to/file.ext\n<<<<<<< SEARCH\nexact code to find\n======= AND\nreplacement code\n>>>>>>> REPLACE\n\`\`\`\n\nDo NOT describe what to do - actually produce the code changes now.`
            });

            currentSystemPrompt = streamingSystemPrompt + `\n\nCRITICAL: The user's original task was: "${originalUserMessage}"\nYou have already explored the codebase. NOW YOU MUST produce the actual code edits.\nUse the SEARCH/REPLACE format with # File: headers. Your response MUST contain code changes.`;

            lastIterationHadShellCommands = false;
            continue;
          }

          logger.info(`[R1-Shell] Loop exiting: iteration=${shellIteration}, hasCodeEdits=${hasCodeEdits}, autoContinuations=${autoContinuationCount}/${maxAutoContinuations}`);
          const lastChars = combinedForShellCheck.slice(-200);
          logger.info(`[R1-Shell] Last 200 chars: ${lastChars.replace(/\n/g, '\\n')}`);
        }
        break;
      }
    } while (shellIteration < maxShellIterations && isReasonerModel);

    if (shellIteration >= maxShellIterations) {
      logger.warn(`[RequestOrchestrator] Reasoner shell loop limit reached (${maxShellIterations} iterations)`);
    }

    // Push final iteration's content (if the loop exited without shell commands)
    if (state.currentIterationContent) {
      state.contentIterations.push(state.currentIterationContent);
      state.currentIterationContent = '';
    }

  }

  // ── Private: History Save Pipeline ──

  private async saveToHistory(
    sessionId: string | null,
    cleanResponse: string,
    fullReasoning: string,
    model: string,
    reasoningIterations: string[],
    contentIterations: string[],
    toolCallsForHistory: Array<{ name: string; detail: string; status: string }>,
    shellResultsForHistory: ShellResult[]
  ): Promise<void> {
    // Convert shell results to tool call format for history
    const shellToolCalls = shellResultsForHistory.map(r => ({
      name: 'shell',
      detail: r.command,
      status: r.success ? 'done' : 'error'
    }));
    const allToolCalls = [...toolCallsForHistory, ...shellToolCalls];

    const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + fullReasoning);
    if (sessionId && (cleanResponse || fullReasoning)) {
      logger.info(`[HistorySave] Saving to session=${sessionId}: reasoning=${reasoningIterations.length}, toolCalls=${toolCallsForHistory.length}, shells=${shellResultsForHistory.length}, content=${cleanResponse.length} chars, model=${model}`);

      try {
        // 1. Record reasoning iterations
        for (let i = 0; i < reasoningIterations.length; i++) {
          this.conversationManager.recordAssistantReasoning(reasoningIterations[i], i);
          logger.info(`[HistorySave] Recorded reasoning iteration ${i} (${reasoningIterations[i].length} chars)`);
        }

        // 2. Record non-shell tool calls
        for (const tc of toolCallsForHistory) {
          const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(toolCallId, tc.name, { detail: tc.detail });
          this.conversationManager.recordToolResult(toolCallId, tc.detail, tc.status === 'done');
          logger.info(`[HistorySave] Recorded tool call: ${tc.name}`);
        }

        // 3. Record shell results with richer data
        for (const sr of shellResultsForHistory) {
          const shellCallId = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(shellCallId, 'shell', { command: sr.command });
          this.conversationManager.recordToolResult(shellCallId, sr.output, sr.success, sr.executionTimeMs);
          logger.info(`[HistorySave] Recorded shell: ${sr.command.substring(0, 50)}`);
        }

        // 4. Record file modifications (for restore of "Modified Files" dropdown)
        const modifiedFiles = [...new Set(
          this.diffManager.getFileChanges()
            .filter(f => f.status === 'applied')
            .map(f => f.filePath)
        )];
        for (const filePath of modifiedFiles) {
          const fileCallId = `fm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(fileCallId, '_file_modified', { filePath });
          this.conversationManager.recordToolResult(fileCallId, filePath, true);
          logger.info(`[HistorySave] Recorded file modification: ${filePath}`);
        }

        // 5. Record the assistant message with real model + finishReason
        const cleanedContentIterations = contentIterations.length > 0
          ? contentIterations.map(c => stripShellTags(stripDSML(c)).trim()).filter(c => c.length > 0)
          : undefined;
        await this.conversationManager.recordAssistantMessage(cleanResponse, model, 'stop', undefined, cleanedContentIterations);
        logger.info(`[HistorySave] Recorded assistant message (${cleanResponse.length} chars, model=${model}, contentIts=${cleanedContentIterations?.length || 0})`);
      } catch (saveError: any) {
        logger.error(`[HistorySave] FAILED to save history: ${saveError.message}`, saveError.stack);
      }
    } else {
      logger.warn(`[HistorySave] Skipped save: sessionId=${sessionId}, cleanResponse=${!!cleanResponse}, fullReasoning=${!!fullReasoning}`);
    }
  }

  // ── Private: Tool Loop ──

  private async runToolLoop(
    messages: ApiMessage[],
    systemPrompt: string,
    signal: AbortSignal,
    contextTokenCount?: number,
    contextBudget?: number
  ): Promise<{ toolMessages: ApiMessage[]; limitReached: boolean; budgetExceeded: boolean; allToolDetails: Array<{ name: string; detail: string; status: string }> }> {
    const toolMessages: ApiMessage[] = [];
    // Get max tool calls from config (100 = no limit)
    const config = vscode.workspace.getConfiguration('deepseek');
    const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
    const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
    let iterations = 0;

    // Token budget tracking for tool loop messages
    let accumulatedToolTokens = 0;
    const budgetLimit = contextBudget ?? 0;
    const baseTokenCount = contextTokenCount ?? 0;
    let budgetExceeded = false;

    // Track ALL tool calls across all iterations for return value
    const allToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    // Track tools for the CURRENT BATCH (may span multiple iterations)
    let batchToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    let toolContainerStarted = false;
    let globalToolIndex = 0;
    // Track if a file was modified in the current batch (triggers batch close)
    let fileModifiedInBatch = false;

    while (iterations < maxIterations) {
      iterations++;

      // Check if aborted
      if (signal.aborted) {
        break;
      }

      // Check if accumulated tool messages are approaching the budget
      if (budgetLimit > 0 && baseTokenCount + accumulatedToolTokens > budgetLimit * 0.95) {
        logger.warn(
          `[Context] Tool loop stopped: approaching budget ` +
          `(${(baseTokenCount + accumulatedToolTokens).toLocaleString()}/${budgetLimit.toLocaleString()} tokens, ` +
          `${iterations - 1} iterations completed)`
        );
        budgetExceeded = true;
        break;
      }

      // Build tools array
      const tools = [...workspaceTools, applyCodeEditTool];

      // Make a non-streaming call with tools
      const response = await this.deepSeekClient.chat(
        [...messages, ...toolMessages],
        systemPrompt,
        { tools }
      );

      // Check for DSML-formatted tool calls in content
      if ((!response.tool_calls || response.tool_calls.length === 0) && response.content) {
        const dsmlCalls = parseDSMLToolCalls(response.content);
        if (dsmlCalls && dsmlCalls.length > 0) {
          response.tool_calls = dsmlCalls.map(dc => ({
            id: dc.id,
            type: 'function' as const,
            function: {
              name: dc.name,
              arguments: JSON.stringify(dc.arguments)
            }
          }));
          response.content = stripDSML(response.content);
        }
      }

      // If no tool calls, we're done with the tool loop
      if (!response.tool_calls || response.tool_calls.length === 0) {
        break;
      }

      // Parse tool call details for better display
      const toolDetails = response.tool_calls.map(tc => {
        const name = tc.function.name;
        let args: Record<string, string> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (e) { /* ignore */ }

        let detail = name;
        if (name === 'read_file' && args.path) {
          detail = `read: ${args.path}`;
        } else if (name === 'search_files' && args.pattern) {
          detail = `search: ${args.pattern}`;
        } else if (name === 'grep_content' && args.query) {
          detail = `grep: "${args.query}"`;
        } else if (name === 'list_directory') {
          detail = `list: ${args.path || '.'}`;
        } else if (name === 'get_file_info' && args.path) {
          detail = `info: ${args.path}`;
        }
        return { name, detail, args };
      });

      // Add tools from this iteration to the current batch
      const newTools = toolDetails.map(t => ({ name: t.name, detail: t.detail, status: 'pending' }));
      batchToolDetails.push(...newTools);

      // Add to global tracking (for return value)
      allToolDetails.push(...newTools);

      // Start a NEW tool container OR update existing batch
      if (!toolContainerStarted) {
        logger.info(`[Frontend] Sending toolCallsStart message: ${batchToolDetails.length} tools`);
        this._onToolCallsStart.fire({ tools: [...batchToolDetails] });
        toolContainerStarted = true;
      } else {
        logger.info(`[Frontend] Sending toolCallsUpdate message: batch now has ${batchToolDetails.length} tools`);
        this._onToolCallsUpdate.fire({ tools: [...batchToolDetails] });
      }

      // Add assistant message with tool calls (required for API contract)
      toolMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      });

      // Count assistant message tokens
      if (budgetLimit > 0) {
        const assistantText = (response.content || '') + JSON.stringify(response.tool_calls);
        accumulatedToolTokens += this.deepSeekClient.estimateTokens(assistantText);
      }

      // Calculate batch-relative index for this iteration's tools
      const batchStartIndex = batchToolDetails.length - newTools.length;

      // Execute each tool call
      for (let i = 0; i < response.tool_calls.length; i++) {
        const toolCall = response.tool_calls[i];
        const detail = toolDetails[i];
        const globalIndex = globalToolIndex + i;
        const batchIndex = batchStartIndex + i;

        logger.toolCall(toolCall.function.name);

        // Update status to running
        batchToolDetails[batchIndex].status = 'running';
        allToolDetails[globalIndex].status = 'running';
        this._onToolCallUpdate.fire({
          index: batchIndex,
          status: 'running',
          detail: detail.detail
        });

        // Execute tool
        const result = await executeToolCall(toolCall);
        const success = !result.startsWith('Error:');
        logger.toolResult(toolCall.function.name, success);

        // Track ALL read files for auto-diff and inference
        if (toolCall.function.name === 'read' && success) {
          try {
            logger.info(`[RequestOrchestrator] Tool arguments raw: ${toolCall.function.arguments}`);
            const args = JSON.parse(toolCall.function.arguments);
            logger.info(`[RequestOrchestrator] Parsed args: ${JSON.stringify(args)}`);
            if (args.file_path) {
              this.fileContextManager.trackReadFile(args.file_path);
            } else {
              logger.warn(`[RequestOrchestrator] read tool called but no file_path in args`);
            }
          } catch (e) {
            logger.error(`[RequestOrchestrator] Failed to parse tool arguments: ${e}`);
          }
        }

        // Track apply_code_edit tool calls for file path extraction
        if (toolCall.function.name === 'apply_code_edit' && success) {
          try {
            logger.info(`[RequestOrchestrator] apply_code_edit tool called - args: ${toolCall.function.arguments}`);
            const args = JSON.parse(toolCall.function.arguments);
            logger.info(`[RequestOrchestrator] Parsed apply_code_edit args: ${JSON.stringify(args)}`);
            if (args.file) {
              this.fileContextManager.trackReadFile(args.file);

              if (args.code) {
                if (this.diffManager.currentEditMode === 'ask') {
                  logger.info(`[RequestOrchestrator] Triggering auto-diff for apply_code_edit in ask mode`);
                  const codeWithHeader = `# File: ${args.file}\n${args.code}`;
                  const language = args.language || 'plaintext';
                  await this.diffManager.handleAutoShowDiff(codeWithHeader, language);
                } else if (this.diffManager.currentEditMode === 'auto') {
                  logger.info(`[RequestOrchestrator] Auto-applying code edit for: ${args.file}`);
                  const applied = await this.diffManager.applyCodeDirectlyForAutoMode(args.file, args.code, args.description, true);
                  if (applied) {
                    fileModifiedInBatch = true;
                  }
                }
              }
            } else {
              logger.warn(`[RequestOrchestrator] apply_code_edit called but no file in args`);
            }
          } catch (e) {
            logger.error(`[RequestOrchestrator] Failed to parse apply_code_edit arguments: ${e}`);
          }
        }

        // Add tool result to messages
        toolMessages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id
        });

        // Count tool result tokens
        if (budgetLimit > 0) {
          accumulatedToolTokens += this.deepSeekClient.estimateTokens(result);
        }

        // Update status to done
        const finalStatus = success ? 'done' : 'error';
        batchToolDetails[batchIndex].status = finalStatus;
        allToolDetails[globalIndex].status = finalStatus;
        this._onToolCallUpdate.fire({
          index: batchIndex,
          status: finalStatus,
          detail: detail.detail
        });
      }

      // Update global index for next iteration
      globalToolIndex += response.tool_calls.length;

      // If a file was modified in this iteration, close the batch and show modified files
      if (fileModifiedInBatch) {
        this._onToolCallsEnd.fire();
        toolContainerStarted = false;
        logger.info(`[Frontend] Sent toolCallsEnd (file modified, closing batch after iteration ${iterations})`);

        this.diffManager.emitAutoAppliedChanges();

        batchToolDetails = [];
        fileModifiedInBatch = false;
      }
    }

    // Close any remaining open batch at the end of the loop
    if (toolContainerStarted) {
      this._onToolCallsEnd.fire();
      logger.info(`[Frontend] Sent toolCallsEnd (end of tool loop)`);
    }

    const limitReached = iterations >= maxIterations && maxIterations !== Infinity;
    if (limitReached || budgetExceeded) {
      const totalToolCalls = globalToolIndex;
      const reason = budgetExceeded ? 'Context budget exceeded' : 'Tool iteration limit reached';
      this._onWarning.fire({
        message: `${reason} (${iterations} iterations, ${totalToolCalls} total tool calls). The task may require multiple requests to complete.`
      });
    }

    return { toolMessages, limitReached, budgetExceeded, allToolDetails };
  }
}
