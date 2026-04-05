import * as vscode from 'vscode';
import { DeepSeekClient, Message as ApiMessage } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';
import { workspaceTools, applyCodeEditTool, webSearchTool, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { DiffManager } from './diffManager';
import { WebSearchManager } from './webSearchManager';
import { FileContextManager } from './fileContextManager';
import {
  parseShellCommands,
  containsShellCommands,
  containsCodeEdits,
  commandsCreateFiles,
  commandsDeleteFiles,
  executeShellCommands,
  formatShellResultsForContext,
  getReasonerShellPrompt,
  stripShellTags,
  parseWebSearchCommands,
  containsWebSearchCommands,
  stripWebSearchTags,
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
import type { CommandApprovalManager } from './commandApprovalManager';
import type { SavedPromptManager } from './savedPromptManager';
import type { PlanManager } from './planManager';

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

  // ── Events (fork support) ──
  private readonly _onTurnSequenceUpdate = new vscode.EventEmitter<{ userSequence?: number; assistantSequence?: number }>();

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
  readonly onTurnSequenceUpdate = this._onTurnSequenceUpdate.event;
  readonly onError = this._onError.event;
  readonly onWarning = this._onWarning.event;

  // ── State ──
  private abortController: AbortController | null = null;
  private contentBuffer: ContentTransformBuffer | null = null;
  // Queue for shell commands detected inline during streaming
  private _pendingInlineShellCommands: Array<{ command: string }> = [];
  // Track commands already executed inline (to avoid re-execution in batch)
  private _inlineExecutedCommands: Set<string> = new Set();
  // Pause token streaming during command approval
  private _approvalPending = false;
  private _heldSegments: Array<{ type: string; content: unknown; complete?: boolean }> = [];
  // Promise that resolves when inline shell execution (including any approval) completes
  private _inlineExecutionPromise: Promise<void> | null = null;
  // CQRS: Deferred turn events from webview (set before endResponse, resolved when webview sends back)
  private _turnEventsResolve: ((events: Array<Record<string, unknown>>) => void) | null = null;
  private _turnEventsPromise: Promise<Array<Record<string, unknown>>> | null = null;

  constructor(
    private deepSeekClient: DeepSeekClient,
    private conversationManager: ConversationManager,
    private statusBar: StatusBar,
    private diffManager: DiffManager,
    private webSearchManager: WebSearchManager,
    private fileContextManager: FileContextManager,
    private commandApprovalManager?: CommandApprovalManager,
    private savedPromptManager?: SavedPromptManager,
    private planManager?: PlanManager,
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
    attachments?: Array<{ content: string; name: string; size: number }>,
    options?: { skipRecord?: boolean }
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
      const session = await this.conversationManager.createSession(
        message,
        this.deepSeekClient.getModel()
      );
      sessionId = session.id;

      this._onSessionCreated.fire({
        sessionId: session.id,
        model: this.deepSeekClient.getModel()
      });
    }

    // Save user message to history (UI already shows it from frontend)
    // Skip when re-sending after fork (message already in event store)
    if (sessionId && !options?.skipRecord) {
      await this.conversationManager.recordUserMessage(sessionId, message);
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
      shellCreatedFiles: false,
      shellDeletedFiles: false,
    };

    // Clear file changes tracking for this response
    this.diffManager.clearResponseFileChanges();
    this.diffManager.resetFailedAutoApplyCount();

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
        // SYNCHRONOUS pre-scan: if this batch contains a shell command that needs approval,
        // set _approvalPending BEFORE processing any segments (including text before the shell tag).
        // This prevents the race condition where text fires to the UI before the async approval starts.
        if (!this._approvalPending) {
          const allowAllCommands = vscode.workspace.getConfiguration('moby')
            .get<boolean>('allowAllShellCommands') ?? false;

          if (!allowAllCommands && this.commandApprovalManager) {
            for (const seg of segments) {
              if (seg.type === 'shell' && seg.complete && Array.isArray(seg.content)) {
                const cmds = seg.content as Array<{ command: string }>;
                for (const cmd of cmds) {
                  const parsed = parseShellCommands(`<shell>${cmd.command}</shell>`);
                  for (const pc of parsed) {
                    const decision = this.commandApprovalManager.checkCommand(pc.command);
                    if (decision !== 'allowed') {
                      logger.info(`[ContentBuffer] Shell command needs approval — holding all segments`);
                      this._approvalPending = true;
                      break;
                    }
                  }
                  if (this._approvalPending) break;
                }
                if (this._approvalPending) break;
              }
            }
          }
        }

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const nextSegment = segments[i + 1];

          // Hold text segments while waiting for command approval.
          // Shell segments still get queued — the approval check happens in executeInlineShellCommands.
          if (this._approvalPending && segment.type === 'text') {
            this._heldSegments.push({ type: segment.type, content: segment.content, complete: segment.complete });
            continue;
          }

          switch (segment.type) {
            case 'text': {
              let text = segment.content as string;
              // Trim trailing newlines before shell/web_search segments to reduce visual gaps
              if (nextSegment && (nextSegment.type === 'shell' || nextSegment.type === 'web_search')) {
                text = text.replace(/\n+$/, '');
              }
              if (text) {
                this._onStreamToken.fire({ token: text });
              }
              break;
            }
            case 'shell':
              if (segment.complete && Array.isArray(segment.content)) {
                // Queue for inline execution during streaming
                for (const cmd of segment.content as Array<{ command: string }>) {
                  this._pendingInlineShellCommands.push(cmd);
                }
                logger.debug(`[ContentBuffer] Queued ${(segment.content as Array<{ command: string }>).length} shell command(s) for inline execution`);
              }
              break;
            case 'thinking':
              logger.debug(`[ContentBuffer] Detected thinking tags, handled separately`);
              break;
            case 'web_search':
              logger.debug(`[ContentBuffer] Detected web_search tags, will be handled after iteration`);
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
      const sessionMessages = sessionId
        ? await this.conversationManager.getSessionMessagesCompat(sessionId)
        : [];
      const messageCount = sessionMessages.length || 1;
      logger.apiRequest(model, messageCount, hasAttachments);

      // Build messages array - handle multimodal content if attachments present
      const historyMessages: ApiMessage[] = [];
      for (const msg of sessionMessages) {
        historyMessages.push({
          role: msg.role,
          content: msg.content,
          eventId: msg.eventId
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
      const snapshotSummary = sessionId
        ? this.conversationManager.getLatestSnapshotSummary(sessionId)
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

      // Strip any DSML markup, shell tags, and web search tags from the final response
      let cleanResponse = stripDSML(streamState.accumulatedResponse);
      cleanResponse = stripShellTags(cleanResponse);
      cleanResponse = stripWebSearchTags(cleanResponse);

      // Unfenced SEARCH/REPLACE Detection (Fallback)
      if (this.diffManager.currentEditMode !== 'manual') {
        await this.diffManager.detectAndProcessUnfencedEdits(cleanResponse);
      }

      // End-of-response blocking: wait for any remaining pending approvals in ask mode
      if (this.diffManager.currentEditMode === 'ask') {
        const finalApprovals = await this.diffManager.waitForPendingApprovals();
        if (finalApprovals.length > 0) {
          const feedbackLines = finalApprovals.map(r =>
            r.approved ? `✓ User ACCEPTED changes to ${r.filePath}` : `✗ User REJECTED changes to ${r.filePath}`
          );
          logger.info(`[RequestOrchestrator] End-of-response approval results:\n${feedbackLines.join('\n')}`);
        }
      }

      // Prepare to receive turn events from webview (must be before endResponse.fire)
      this.prepareTurnEventsReceiver();

      // Finalize response
      this._onEndResponse.fire({
        role: 'assistant',
        content: cleanResponse,
        reasoning_content: streamState.fullReasoning || undefined,
        reasoning_iterations: streamState.reasoningIterations.length > 0 ? streamState.reasoningIterations : undefined,
        content_iterations: streamState.contentIterations.length > 0
          ? streamState.contentIterations.map((text, i) => ({ text, iterationIndex: i }))
          : undefined,
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
          const cleanPartialResponse = stripWebSearchTags(stripShellTags(stripDSML(partialContent)));

          // Record reasoning iterations that completed
          for (let i = 0; i < streamState.reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(sessionId!, streamState.reasoningIterations[i], i);
          }

          // Record the partial assistant message
          const partialText = cleanPartialResponse
            ? `${cleanPartialResponse}\n\n*[Generation stopped]*`
            : '*[Generation stopped]*';
          await this.conversationManager.recordAssistantMessage(sessionId!, partialText, model, 'stop');
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

  /** Check if a request is currently in progress. */
  isGenerating(): boolean {
    return this.abortController !== null;
  }

  /** Abort current request. */
  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      logger.apiAborted();
    }
    this.diffManager.cancelPendingApprovals();
    this.commandApprovalManager?.cancelPendingApproval();
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
    const customSystemPrompt = this.savedPromptManager?.getActiveContent() || '';
    const editMode = this.diffManager.currentEditMode;

    // ── 1. Identity + Conversational Gate ──
    let systemPrompt = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.

Match your response to the user's intent:
- Questions about code → explain clearly, no edits needed
- Requests for changes → use the edit format described below
- Architecture or design discussions → discuss tradeoffs, only edit if asked
- Debugging help → analyze the problem, suggest fixes only when appropriate
Not every message needs a code edit.\n`;

    // ── 2. Model-specific capabilities ──
    const wsState = await this.webSearchManager.getSettings();
    const webSearchAutoAvailable = wsState.mode === 'auto' && wsState.configured;
    if (isReasonerModel) {
      systemPrompt += getReasonerShellPrompt({ webSearchAvailable: webSearchAutoAvailable });
    } else {
      const webSearchLine = webSearchAutoAvailable
        ? '- web_search: Search the web for current information\n'
        : '';
      systemPrompt += `
You have tools to explore the codebase:
- read_file: Read file contents
- search_files: Find files by name pattern
- grep_content: Search for text/patterns in files
- list_directory: See directory structure
- get_file_info: Get file metadata
${webSearchLine}
Use tools to understand the code before responding. Read relevant files first, then provide accurate answers.\n`;
    }

    // ── 3. Edit format (compact) ──
    const editModeDescriptions: Record<string, string> = {
      manual: 'Code blocks are shown for reference. The user will apply changes manually.',
      ask: 'Code blocks trigger a diff view for the user to review and accept/reject.',
      auto: 'Code blocks are automatically applied without user confirmation.'
    };

    systemPrompt += `
**Code Edit Format** (edit mode: ${editMode})
${editModeDescriptions[editMode]}

When making code edits, use this exact format inside a fenced code block:

\`\`\`<language>
# File: path/to/file.ext
<<<<<<< SEARCH
exact code to find (copy verbatim)
=======
replacement code
>>>>>>> REPLACE
\`\`\`

Rules: "# File:" header is required. SEARCH must match the file exactly. For new files, leave SEARCH empty.\n`;

    // ── 4. Dynamic context ──
    const editorContext = await editorContextProvider();
    if (editorContext) {
      systemPrompt += `\n${editorContext}`;
    }

    const modifiedFilesContext = this.diffManager.getModifiedFilesContext();
    if (modifiedFilesContext) {
      systemPrompt += modifiedFilesContext;
    }

    // Auto web search
    const webSearchContext = await this.webSearchManager.searchForMessage(message);
    if (webSearchContext) {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      systemPrompt += `\n\n--- WEB SEARCH RESULTS (${today}) ---\n${webSearchContext}\n--- END WEB SEARCH RESULTS ---\n`;
    }

    // ── 5. Active plans ──
    if (this.planManager) {
      const plansContext = await this.planManager.getActivePlansContext();
      if (plansContext) {
        systemPrompt += plansContext;
      }
    }

    // ── 6. Custom instructions (at the END for recency bias) ──
    if (customSystemPrompt.trim()) {
      systemPrompt += `\n--- USER CUSTOM INSTRUCTIONS ---\nThe following instructions from the user take priority over defaults:\n\n${customSystemPrompt.trim()}\n--- END CUSTOM INSTRUCTIONS ---\n`;
    }

    return systemPrompt;
  }

  // ── Private: Inline Shell Execution (during streaming) ──

  /**
   * Execute shell commands that were detected inline during streaming.
   * Called from the streaming token callback when ContentTransformBuffer
   * detects complete <shell>...</shell> tags.
   *
   * Each command gets its own dropdown in the UI, appearing inline
   * with the surrounding text rather than batched at the end.
   */
  private async executeInlineShellCommands(
    workspacePath: string,
    signal: AbortSignal,
    state: { shellResultsForHistory: ShellResult[]; shellCreatedFiles: boolean; shellDeletedFiles: boolean }
  ): Promise<void> {
    while (this._pendingInlineShellCommands.length > 0) {
      if (signal.aborted) break;

      const rawCmd = this._pendingInlineShellCommands.shift()!;

      // Parse with heredoc-aware parser (keeps multi-line commands together)
      const parsedCommands = parseShellCommands(`<shell>${rawCmd.command}</shell>`);
      if (parsedCommands.length === 0) continue;

      // Track the raw content for dedup against batch path
      this._inlineExecutedCommands.add(rawCmd.command);

      // Detect file creation/deletion from command patterns (more reliable than file watcher on WSL2)
      if (commandsCreateFiles(parsedCommands)) {
        state.shellCreatedFiles = true;
      }
      if (commandsDeleteFiles(parsedCommands)) {
        state.shellDeletedFiles = true;
      }

      // Flush buffer before sending shell notification
      if (this.contentBuffer) {
        this.contentBuffer.flush();
      }

      // Notify frontend — single dropdown for all commands in this <shell> tag
      const shellPayload = parsedCommands.map(c => ({
        command: c.command,
        description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command
      }));
      this._onShellExecuting.fire({ commands: shellPayload });

      // Command approval + execution for each parsed command
      const allowAllCommands = vscode.workspace.getConfiguration('moby')
        .get<boolean>('allowAllShellCommands') ?? false;

      const approvedCommands: typeof parsedCommands = [];
      const blockedResults: ShellResult[] = [];

      for (const cmd of parsedCommands) {
        if (allowAllCommands) {
          approvedCommands.push(cmd);
          continue;
        }

        if (!this.commandApprovalManager) {
          approvedCommands.push(cmd);
          continue;
        }

        const decision = this.commandApprovalManager.checkCommand(cmd.command);
        if (decision === 'allowed') {
          approvedCommands.push(cmd);
        } else {
          // Both 'blocked' and 'ask' show the approval prompt — gives user the chance to override
          // Note: _approvalPending was already set synchronously in onFlush pre-scan
          const userApproval = await this.commandApprovalManager.requestApproval(cmd.command);
          this._approvalPending = false;

          // Flush text segments that were held during approval
          if (this._heldSegments.length > 0) {
            for (const held of this._heldSegments) {
              if (held.type === 'text' && held.content) {
                this._onStreamToken.fire({ token: held.content as string });
              }
            }
            this._heldSegments = [];
          }

          if (userApproval.decision === 'allowed') {
            approvedCommands.push(cmd);
          } else {
            blockedResults.push({
              command: cmd.command,
              output: `Command rejected by user: ${cmd.command}`,
              success: false,
              executionTimeMs: 0
            });
          }
        }
      }

      // Safety: clear approval flag if pre-scan set it but no approval was needed
      // (e.g., command became allowed between pre-scan and execution)
      if (this._approvalPending) {
        this._approvalPending = false;
        if (this._heldSegments.length > 0) {
          for (const held of this._heldSegments) {
            if (held.type === 'text' && held.content) {
              this._onStreamToken.fire({ token: held.content as string });
            }
          }
          this._heldSegments = [];
        }
      }

      // File watcher
      const modifiedFiles = new Set<string>();
      const deletedFiles = new Set<string>();
      let shellFileWatcher: vscode.FileSystemWatcher | null = null;
      try {
        shellFileWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(workspacePath, '**/*')
        );
        const trackChange = (uri: vscode.Uri) => {
          const relativePath = vscode.workspace.asRelativePath(uri, false);
          if (!relativePath.startsWith('.git/')) {
            modifiedFiles.add(relativePath);
          }
        };
        shellFileWatcher.onDidChange(trackChange);
        shellFileWatcher.onDidCreate(trackChange);
        shellFileWatcher.onDidDelete((uri: vscode.Uri) => {
          const relativePath = vscode.workspace.asRelativePath(uri, false);
          if (!relativePath.startsWith('.git/')) {
            deletedFiles.add(relativePath);
            modifiedFiles.delete(relativePath);
          }
        });
      } catch {
        shellFileWatcher = null;
      }

      // Execute approved commands
      const executedResults = approvedCommands.length > 0
        ? await executeShellCommands(approvedCommands, workspacePath, { allowAllCommands, signal })
        : [];
      const allResults = [...blockedResults, ...executedResults];

      // Dispose watcher and register modified/deleted files
      if (shellFileWatcher) {
        await new Promise(resolve => setTimeout(resolve, 100));
        shellFileWatcher.dispose();
        if (modifiedFiles.size > 0) {
          logger.info(`[R1-Shell] Inline: File watcher detected ${modifiedFiles.size} modified files: ${[...modifiedFiles].join(', ')}`);
          this.diffManager.registerShellModifiedFiles([...modifiedFiles]);
          state.shellCreatedFiles = true;
        }
        if (deletedFiles.size > 0) {
          logger.info(`[R1-Shell] Inline: File watcher detected ${deletedFiles.size} deleted files: ${[...deletedFiles].join(', ')}`);
          this.diffManager.registerShellDeletedFiles([...deletedFiles]);
          state.shellDeletedFiles = true;
        }
      }

      state.shellResultsForHistory.push(...allResults);

      // Notify frontend of results
      this._onShellResults.fire({
        results: allResults.map(r => ({
          command: r.command,
          output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
          success: r.success
        }))
      });

      // Also track individual parsed commands for batch dedup
      for (const cmd of parsedCommands) {
        this._inlineExecutedCommands.add(cmd.command);
      }

      logger.info(`[R1-Shell] Inline executed ${allResults.length} command(s) from <shell> tag`);
    }
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
      shellCreatedFiles: boolean;
      shellDeletedFiles: boolean;
    }
  ): Promise<void> {
    // Reasoner shell loop - run shell commands if R1 outputs them
    const shellConfig = vscode.workspace.getConfiguration('moby');
    const configuredShellLimit = shellConfig.get<number>('maxShellIterations') ?? 100;
    const maxShellIterations = configuredShellLimit >= 100 ? Infinity : configuredShellLimit;
    let shellIteration = 0;
    let currentSystemPrompt = streamingSystemPrompt;
    let currentHistoryMessages = [...contextMessages];

    // Auto-continuation tracking for R1
    const maxAutoContinuations = 2;
    let autoContinuationCount = 0;
    let lastIterationHadShellCommands = false;

    // Token budget tracking for injected shell/web search results
    let accumulatedIterationTokens = 0;
    const iterationBudget = 60_000;  // Safety cap: ~60k tokens of injected context

    do {
      // Check abort at the start of each iteration
      if (signal.aborted) break;

      // Track iteration-specific response
      let iterationResponse = '';
      // Reset inline shell tracking for this iteration
      this._pendingInlineShellCommands = [];
      this._inlineExecutedCommands.clear();
      this._inlineExecutionPromise = null;

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

          // Execute any shell commands detected inline by ContentTransformBuffer
          if (isReasonerModel && this._pendingInlineShellCommands.length > 0) {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspacePath) {
              // Store the promise so the iteration loop can await it after streaming completes
              this._inlineExecutionPromise = this.executeInlineShellCommands(workspacePath, signal, state);
              await this._inlineExecutionPromise;
              this._inlineExecutionPromise = null;
            }
          }

          // Detect complete code blocks and auto-handle in "ask" or "auto" mode
          await this.diffManager.handleCodeBlockDetection(state.accumulatedResponse);
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

      // BLOCKING: Wait for any pending inline shell execution (including command approval)
      // The onToken callback may have started executeInlineShellCommands which awaits
      // user approval, but streamChat doesn't await the onToken callback — so the
      // inline execution may still be pending when streamChat returns.
      if (this._inlineExecutionPromise) {
        logger.info('[R1-Shell] Waiting for pending inline shell execution to complete before continuing...');
        await this._inlineExecutionPromise;
        this._inlineExecutionPromise = null;
      }

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

      // BLOCKING APPROVAL: In ask mode, wait for user to approve/reject all diffs from this iteration
      if (this.diffManager.currentEditMode === 'ask') {
        if (this.contentBuffer) {
          this.contentBuffer.flush();
        }

        const approvalResults = await this.diffManager.waitForPendingApprovals();
        if (approvalResults.length > 0) {
          const feedbackLines = approvalResults.map(r =>
            r.approved
              ? `✓ User ACCEPTED changes to ${r.filePath}`
              : `✗ User REJECTED changes to ${r.filePath}`
          );
          const feedback = feedbackLines.join('\n');
          logger.info(`[RequestOrchestrator] Ask mode approval results:\n${feedback}`);

          // Inject as user message so the LLM sees the results
          currentHistoryMessages.push({
            role: 'assistant',
            content: iterationResponse
          });
          currentHistoryMessages.push({
            role: 'user',
            content: `Edit approval results:\n${feedback}\n\n${
              approvalResults.some(r => !r.approved)
                ? 'Some edits were rejected. Please adjust your approach based on this feedback.'
                : 'All edits were accepted.'
            }\n\nOriginal task: "${originalUserMessage}"`
          });

          // Force another iteration so the LLM can react
          shellIteration++;
          lastIterationHadShellCommands = true;
          continue;
        }
      }

      // Check for shell commands AND web search tags in THIS iteration's response AND reasoning
      const combinedForShellCheck = iterationResponse + (state.currentIterationReasoning || '');
      const hasShell = isReasonerModel && containsShellCommands(combinedForShellCheck);
      const hasWebSearch = isReasonerModel && this.webSearchManager.getMode() === 'auto' && containsWebSearchCommands(combinedForShellCheck);

      if (hasShell || hasWebSearch) {
        shellIteration++;
        lastIterationHadShellCommands = true;

        let resultsContext = '';

        // Include results from inline-executed commands (already executed during streaming)
        if (this._inlineExecutedCommands.size > 0) {
          const inlineResults = state.shellResultsForHistory.filter(r => this._inlineExecutedCommands.has(r.command));
          if (inlineResults.length > 0) {
            resultsContext += formatShellResultsForContext(inlineResults);
            logger.info(`[R1-Shell] Including ${inlineResults.length} inline-executed results in context`);
          }
        }

        // ── Execute shell commands ──
        if (hasShell) {
          const inReasoning = containsShellCommands(state.currentIterationReasoning || '');
          const inContent = containsShellCommands(iterationResponse);
          logger.info(`[R1-Shell] Iteration ${shellIteration}: found shell commands (inContent=${inContent}, inReasoning=${inReasoning})`);

          // Filter out commands already executed inline during streaming
          const allCommands = parseShellCommands(combinedForShellCheck);
          const commands = allCommands.filter(c => !this._inlineExecutedCommands.has(c.command));
          if (commands.length < allCommands.length) {
            logger.info(`[R1-Shell] Skipping ${allCommands.length - commands.length} commands already executed inline`);
          }
          if (commandsCreateFiles(commands)) {
            state.shellCreatedFiles = true;
            logger.info(`[R1-Shell] Shell commands include file creation (heredoc/redirect)`);
          }
          if (commandsDeleteFiles(commands)) {
            state.shellDeletedFiles = true;
            logger.info(`[R1-Shell] Shell commands include file deletion (rm/unlink)`);
          }
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

            // Check allowAllShellCommands setting
            const shellConfig = vscode.workspace.getConfiguration('moby');
            const allowAllCommands = shellConfig.get<boolean>('allowAllShellCommands') ?? false;

            // ── Command Approval Gate ──
            // If bypass mode is off and CommandApprovalManager is available,
            // filter commands through the approval system before execution.
            let approvedCommands = commands;
            const blockedResults: ShellResult[] = [];

            logger.info(`[CommandApproval] Gate entered: ${commands.length} commands, bypass=${allowAllCommands}`);
            tracer.trace('command.check', 'gate.enter', {
              data: { commandCount: commands.length, bypass: allowAllCommands }
            });

            if (!allowAllCommands && this.commandApprovalManager) {
              approvedCommands = [];
              let askedCount = 0;
              for (const cmd of commands) {
                const decision = this.commandApprovalManager.checkCommand(cmd.command);
                if (decision === 'allowed') {
                  logger.debug(`[CommandApproval] ALLOWED (rule match): "${cmd.command}"`);
                  approvedCommands.push(cmd);
                } else if (decision === 'blocked') {
                  logger.info(`[CommandApproval] BLOCKED: "${cmd.command}"`);
                  blockedResults.push({
                    command: cmd.command,
                    output: 'Command blocked by security rules.',
                    success: false,
                    executionTimeMs: 0,
                  });
                } else {
                  // 'ask' — block and wait for user approval via webview
                  askedCount++;
                  logger.info(`[CommandApproval] Requesting approval: "${cmd.command}"`);

                  // Flush content buffer so the approval widget appears after streamed content
                  if (this.contentBuffer) {
                    this.contentBuffer.flush();
                  }

                  const result = await this.commandApprovalManager.requestApproval(cmd.command);

                  if (result.decision === 'allowed') {
                    logger.info(`[CommandApproval] APPROVED${result.persistent ? ' (always)' : ''}: "${cmd.command}"`);
                    approvedCommands.push(cmd);
                  } else {
                    logger.info(`[CommandApproval] DENIED${result.persistent ? ' (always)' : ''}: "${cmd.command}"`);
                    blockedResults.push({
                      command: cmd.command,
                      output: 'Command blocked by user.',
                      success: false,
                      executionTimeMs: 0,
                    });
                  }
                }
              }

              // Gate summary
              logger.info(`[CommandApproval] Gate result: ${approvedCommands.length} approved, ${blockedResults.length} blocked, ${askedCount} asked of ${commands.length} total`);
              tracer.trace('command.check', 'gate.result', {
                data: { total: commands.length, approved: approvedCommands.length, blocked: blockedResults.length, asked: askedCount }
              });
            } else if (allowAllCommands) {
              logger.info(`[CommandApproval] Bypass active (allowAllShellCommands=true), skipping ${commands.length} commands`);
              tracer.trace('command.check', 'gate.bypass', {
                data: { commandCount: commands.length }
              });
            }

            // Execute approved commands with file change detection
            const shellStartTime = Date.now();
            logger.info(`[Timing] Shell execution started at ${new Date().toISOString()}`);

            // Watch for file changes during shell execution
            const modifiedFiles = new Set<string>();
            const deletedFiles = new Set<string>();
            let shellFileWatcher: vscode.FileSystemWatcher | null = null;
            if (workspacePath) {
              try {
                shellFileWatcher = vscode.workspace.createFileSystemWatcher(
                  new vscode.RelativePattern(workspacePath, '**/*')
                );
                const trackChange = (uri: vscode.Uri) => {
                  const relativePath = vscode.workspace.asRelativePath(uri, false);
                  if (!relativePath.startsWith('.git/')) {
                    modifiedFiles.add(relativePath);
                  }
                };
                shellFileWatcher.onDidChange(trackChange);
                shellFileWatcher.onDidCreate(trackChange);
                shellFileWatcher.onDidDelete((uri: vscode.Uri) => {
                  const relativePath = vscode.workspace.asRelativePath(uri, false);
                  if (!relativePath.startsWith('.git/')) {
                    deletedFiles.add(relativePath);
                    modifiedFiles.delete(relativePath);
                  }
                });
              } catch {
                // File watcher not available (e.g., in tests)
                shellFileWatcher = null;
              }
            }

            const executedResults = approvedCommands.length > 0
              ? await executeShellCommands(approvedCommands, workspacePath, { allowAllCommands, signal })
              : [];
            const results = [...blockedResults, ...executedResults];
            const shellDuration = Date.now() - shellStartTime;
            logger.info(`[Timing] Shell execution completed in ${shellDuration}ms`);

            // Dispose watcher and notify DiffManager of modified/deleted files
            if (shellFileWatcher) {
              // Wait for OS file system notifications to arrive
              await new Promise(resolve => setTimeout(resolve, 100));
              shellFileWatcher.dispose();
              if (modifiedFiles.size > 0) {
                logger.info(`[R1-Shell] File watcher detected ${modifiedFiles.size} modified files: ${[...modifiedFiles].join(', ')}`);
                this.diffManager.registerShellModifiedFiles([...modifiedFiles]);
                state.shellCreatedFiles = true;
              }
              if (deletedFiles.size > 0) {
                logger.info(`[R1-Shell] File watcher detected ${deletedFiles.size} deleted files: ${[...deletedFiles].join(', ')}`);
                this.diffManager.registerShellDeletedFiles([...deletedFiles]);
                state.shellDeletedFiles = true;
              }
            }
            state.shellResultsForHistory.push(...results);

            // Notify frontend of results
            this._onShellResults.fire({
              results: results.map(r => ({
                command: r.command,
                output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
                success: r.success
              }))
            });

            resultsContext += formatShellResultsForContext(results);
            logger.info(`[R1-Shell] Injected ${results.length} shell results for task: "${originalUserMessage.substring(0, 50)}...", continuing...`);
          }
        }

        // ── Execute web searches ──
        if (hasWebSearch) {
          const webQueries = parseWebSearchCommands(combinedForShellCheck);
          logger.info(`[R1-WebSearch] Iteration ${shellIteration}: found ${webQueries.length} web search queries`);
          tracer.trace('state.publish', 'reasoner.webSearch.detected', {
            data: { iteration: shellIteration, queryCount: webQueries.length }
          });

          if (this.contentBuffer) {
            this.contentBuffer.flush();
          }

          // Notify frontend — reuse shell UI for web search display
          const webSearchPayload = webQueries.map(q => ({
            command: `web_search: "${q.query}"`,
            description: `search web: "${q.query.substring(0, 50)}${q.query.length > 50 ? '...' : ''}"`
          }));
          this._onShellExecuting.fire({ commands: webSearchPayload });

          // Execute each web search query
          const webResults: Array<{ command: string; output: string; success: boolean }> = [];
          for (const q of webQueries) {
            const searchResult = await this.webSearchManager.searchByQuery(q.query);
            const success = !searchResult.startsWith('Error:');
            webResults.push({
              command: `web_search: "${q.query}"`,
              output: searchResult.substring(0, 500) + (searchResult.length > 500 ? '...' : ''),
              success
            });

            // Add full result to context
            resultsContext += `\n--- Web Search Results for: "${q.query}" ---\n${searchResult}\n--- End Web Search Results ---\n`;
          }

          // Notify frontend of web search results
          this._onShellResults.fire({ results: webResults });
          logger.info(`[R1-WebSearch] Completed ${webQueries.length} web searches`);
          tracer.trace('state.publish', 'reasoner.webSearch.complete', {
            data: {
              iteration: shellIteration,
              queryCount: webQueries.length,
              successCount: webResults.filter(r => r.success).length
            }
          });
        }

        // Count tokens for injected context (parity with tool loop budget tracking)
        const injectedTokens = this.deepSeekClient.estimateTokens(resultsContext + iterationResponse);
        accumulatedIterationTokens += injectedTokens;
        logger.info(`[R1-Budget] Iteration ${shellIteration}: +${injectedTokens.toLocaleString()} tokens injected (total: ${accumulatedIterationTokens.toLocaleString()}/${iterationBudget.toLocaleString()})`);

        if (accumulatedIterationTokens > iterationBudget) {
          logger.warn(`[R1-Budget] Iteration budget exceeded (${accumulatedIterationTokens.toLocaleString()}/${iterationBudget.toLocaleString()} tokens) — stopping iteration loop`);
          this._onWarning.fire({
            message: `Shell/web search iteration budget exceeded (${accumulatedIterationTokens.toLocaleString()} tokens). The response may be incomplete.`
          });
          break;
        }

        // Add to context and continue
        currentHistoryMessages.push({
          role: 'assistant',
          content: iterationResponse
        });

        currentHistoryMessages.push({
          role: 'user',
          content: `${hasShell ? 'Shell command' : 'Web search'} results:\n${resultsContext}\n\n---\nREMINDER - Your original task was:\n"${originalUserMessage}"\n\nYou have explored/searched. Now you MUST either:\n1. Run additional shell commands or web searches if you need more information, OR\n2. If the task requires code changes, produce them using properly formatted code blocks with # File: headers, OR\n3. If the task is a question, provide a clear answer based on your findings.\n\nDo NOT end with just shell commands or analysis — complete the task.`
        });

        // Update system prompt for continuation
        currentSystemPrompt = streamingSystemPrompt + `\n\nThe ${hasShell ? 'shell commands' : 'web searches'} have been executed and results are provided.\nORIGINAL TASK: "${originalUserMessage}"\n\nYou MUST now complete this task:\n- If you need more information, run additional shell commands or web searches\n- If the task requires code changes, produce them using properly formatted code blocks with # File: headers\n- If the task is a question, provide a clear answer based on your findings\n- Do NOT end with just shell commands or analysis — finish the task`;
      } else {
        // No shell commands in this iteration
        if (isReasonerModel) {
          logger.info(`[R1-Shell] No shell commands in iteration, checking for auto-continuation...`);
          logger.info(`[R1-Shell] shellIteration=${shellIteration}, autoContinuationCount=${autoContinuationCount}, lastIterationHadShellCommands=${lastIterationHadShellCommands}, shellCreatedFiles=${state.shellCreatedFiles}, shellDeletedFiles=${state.shellDeletedFiles}`);

          const hasCodeEdits = containsCodeEdits(state.accumulatedResponse);
          const failedApplies = this.diffManager.getFailedAutoApplyCount();
          logger.info(`[R1-Shell] Response has code edits: ${hasCodeEdits}, failedApplies: ${failedApplies}`);

          // Code edits were produced but files don't exist — nudge to create them
          if (hasCodeEdits && failedApplies > 0 && autoContinuationCount < maxAutoContinuations) {
            autoContinuationCount++;
            this.diffManager.resetFailedAutoApplyCount();
            logger.info(`[R1-Shell] Auto-continuing (${autoContinuationCount}/${maxAutoContinuations}): code edits failed to apply (${failedApplies} files not found)`);

            this._onAutoContinuation.fire({
              count: autoContinuationCount,
              max: maxAutoContinuations,
              reason: `${failedApplies} file(s) not found — requesting file creation`
            });

            currentHistoryMessages.push({
              role: 'assistant',
              content: iterationResponse
            });

            currentHistoryMessages.push({
              role: 'user',
              content: `The files you referenced don't exist yet. Please create them using shell commands.\n\nFor example:\ncat > filename.ext << 'MOBY_EOF'\n<file contents>\nMOBY_EOF\n\nCreate all ${failedApplies} file(s) now.`
            });

            lastIterationHadShellCommands = false;
            continue;
          }

          if (shellIteration > 0 && !hasCodeEdits && !state.shellCreatedFiles && !state.shellDeletedFiles && autoContinuationCount < maxAutoContinuations) {
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
              content: `You explored the codebase but didn't complete the task.\n\nORIGINAL TASK: "${originalUserMessage}"\n\nYou MUST now produce the code edits. Use the SEARCH/REPLACE format with "# File:" headers:\n\n\`\`\`<language>\n# File: path/to/file.ext\n<<<<<<< SEARCH\nexact code to find\n=======\nreplacement code\n>>>>>>> REPLACE\n\`\`\`\n\nDo NOT describe what to do - actually produce the code changes now.`
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

  // ── CQRS: Turn Events from Webview ──

  /**
   * Set up a promise that will resolve when the webview sends back its
   * consolidated turn events. Called just before firing endResponse.
   */
  private prepareTurnEventsReceiver(): void {
    this._turnEventsPromise = new Promise<Array<Record<string, unknown>>>((resolve) => {
      this._turnEventsResolve = resolve;
      // Timeout: if webview doesn't respond within 2s, save without turn events
      setTimeout(() => {
        if (this._turnEventsResolve === resolve) {
          logger.warn('[RequestOrchestrator] turnEventsForSave timeout — saving without webview events');
          resolve([]);
          this._turnEventsResolve = null;
        }
      }, 2000);
    });
  }

  /**
   * Called by ChatProvider when the webview sends turnEventsForSave.
   * Resolves the pending promise so saveToHistory can proceed with the events.
   */
  receiveTurnEvents(events: Array<Record<string, unknown>>): void {
    if (this._turnEventsResolve) {
      logger.info(`[RequestOrchestrator] Received ${events.length} turn events from webview`);
      this._turnEventsResolve(events);
      this._turnEventsResolve = null;
    } else {
      logger.warn(`[RequestOrchestrator] Received turn events but no pending receiver`);
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
          this.conversationManager.recordAssistantReasoning(sessionId, reasoningIterations[i], i);
          logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded reasoning iteration ${i} (${reasoningIterations[i].length} chars)`);
        }

        // 2. Record non-shell tool calls
        for (const tc of toolCallsForHistory) {
          const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(sessionId, toolCallId, tc.name, { detail: tc.detail });
          this.conversationManager.recordToolResult(sessionId, toolCallId, tc.detail, tc.status === 'done');
          logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded tool call: ${tc.name}`);
        }

        // 3. Record shell results with richer data
        for (const sr of shellResultsForHistory) {
          const shellCallId = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(sessionId, shellCallId, 'shell', { command: sr.command });
          this.conversationManager.recordToolResult(sessionId, shellCallId, sr.output, sr.success, sr.executionTimeMs);
          logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded shell: ${sr.command.substring(0, 50)}`);
        }

        // 4. Record file modifications (for restore of "Modified Files" dropdown)
        const modifiedFiles = [...new Set(
          this.diffManager.getFileChanges()
            .filter(f => f.status === 'applied')
            .map(f => f.filePath)
        )];
        const currentEditMode = this.diffManager.currentEditMode;
        for (const filePath of modifiedFiles) {
          const fileCallId = `fm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.conversationManager.recordToolCall(sessionId, fileCallId, '_file_modified', { filePath, editMode: currentEditMode });
          this.conversationManager.recordToolResult(sessionId, fileCallId, filePath, true);
          logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded file modification: ${filePath} (editMode=${currentEditMode})`);
        }

        // 5. Await turn events from webview (CQRS: webview's event log is the source of truth)
        const turnEvents = this._turnEventsPromise ? await this._turnEventsPromise : [];
        this._turnEventsPromise = null;
        logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Received ${turnEvents.length} consolidated turn events from webview`);

        // 5b. Update file-modified events with resolved statuses from DiffManager.
        // 5b. Patch file-modified events with resolved statuses.
        // During ask mode, files are accepted/rejected DURING the response (before save).
        // The turnEvents still have status='pending' — patch them with the actual outcomes.
        const fileChanges = this.diffManager.getFileChanges();
        const fileModifiedEvents = turnEvents.filter((te: any) => te.type === 'file-modified');
        logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Step 5b: ${fileModifiedEvents.length} file-modified events in turnEvents, ${fileChanges.length} fileChanges from DiffManager`);
        if (fileChanges.length > 0) {
          logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} DiffManager fileChanges: ${fileChanges.map(f => `${f.filePath}:${f.status}`).join(', ')}`);
        }
        for (const te of turnEvents) {
          if ((te as any).type === 'file-modified' && (te as any).status === 'pending') {
            const resolved = fileChanges.find(f => f.filePath === (te as any).path);
            if (resolved && (resolved.status === 'applied' || resolved.status === 'rejected')) {
              logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Step 5b: patching ${(te as any).path} pending → ${resolved.status}`);
              (te as any).status = resolved.status;
            } else {
              logger.warn(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Step 5b: ${(te as any).path} still pending — no matching fileChange found`);
            }
          }
        }

        // 6. Record the assistant message with turn events
        await this.conversationManager.recordAssistantMessage(sessionId, cleanResponse, model, 'stop', undefined, undefined, turnEvents);
        logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded assistant message (${cleanResponse.length} chars, model=${model}, turnEvents=${turnEvents.length})`);

        // Fire turn sequence update so webview can show fork buttons on live turns
        const seqs = this.conversationManager.getRecentTurnSequences(sessionId);
        this._onTurnSequenceUpdate.fire(seqs);
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
    const config = vscode.workspace.getConfiguration('moby');
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

      // Build tools array (include web_search only when mode is 'auto' and Tavily is configured)
      const toolLoopWsState = await this.webSearchManager.getSettings();
      const includeWebSearch = toolLoopWsState.mode === 'auto' && toolLoopWsState.configured;
      const tools = [
        ...workspaceTools,
        applyCodeEditTool,
        ...(includeWebSearch ? [webSearchTool] : [])
      ];

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
        } else if (name === 'web_search' && args.query) {
          detail = `search web: "${args.query}"`;
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

        // Execute tool — intercept web_search to route through WebSearchManager
        let result: string;
        if (toolCall.function.name === 'web_search') {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            result = await this.webSearchManager.searchByQuery(args.query || '');
          } catch (e: any) {
            result = `Error: Failed to execute web search — ${e.message}`;
          }
        } else {
          result = await executeToolCall(toolCall);
        }
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
                  logger.info(`[RequestOrchestrator] Triggering blocking diff for apply_code_edit in ask mode`);
                  const codeWithHeader = `# File: ${args.file}\n${args.code}`;
                  const language = args.language || 'plaintext';
                  await this.diffManager.handleAskModeDiff(codeWithHeader, language);

                  // Wait for user approval before continuing tool loop
                  const approvalResults = await this.diffManager.waitForPendingApprovals();
                  if (approvalResults.length > 0) {
                    const r = approvalResults[0];
                    result = r.approved
                      ? `Code edit applied to ${args.file}. User accepted the changes.`
                      : `Code edit rejected for ${args.file}. User rejected the changes. Please try a different approach.`;
                  }

                  // Close the current tool batch after approval so retries render in a fresh batch
                  if (toolContainerStarted) {
                    this._onToolCallsEnd.fire();
                    toolContainerStarted = false;
                    logger.info(`[Frontend] Sent toolCallsEnd (ask mode approval, closing batch after iteration ${iterations})`);
                    batchToolDetails = [];
                  }
                } else if (this.diffManager.currentEditMode === 'auto') {
                  logger.info(`[RequestOrchestrator] Auto-applying code edit for: ${args.file}`);
                  const applied = await this.diffManager.applyCodeDirectlyForAutoMode(args.file, args.code, args.description, true);
                  if (applied) {
                    fileModifiedInBatch = true;
                  }
                } else if (this.diffManager.currentEditMode === 'manual') {
                  logger.info(`[RequestOrchestrator] Opening diff for manual review: ${args.file}`);
                  const codeWithHeader = `# File: ${args.file}\n${args.code}`;
                  const language = args.language || 'plaintext';
                  await this.diffManager.showDiff(codeWithHeader, language);
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

        // Update status to done (skip batch update if batch was closed mid-loop, e.g., ask mode approval)
        const finalStatus = success ? 'done' : 'error';
        allToolDetails[globalIndex].status = finalStatus;
        if (batchIndex < batchToolDetails.length) {
          batchToolDetails[batchIndex].status = finalStatus;
          this._onToolCallUpdate.fire({
            index: batchIndex,
            status: finalStatus,
            detail: detail.detail
          });
        } else {
          logger.debug(`[ToolLoop] Skipping batch UI update — batch was closed (batchIndex=${batchIndex}, batchLen=${batchToolDetails.length})`);
        }
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
