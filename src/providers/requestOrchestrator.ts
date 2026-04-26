import * as vscode from 'vscode';
import { DeepSeekClient, Message as ApiMessage, ToolCall } from '../deepseekClient';
import { getCapabilities, PromptStyle } from '../models/registry';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';
import { workspaceTools, applyCodeEditTool, createFileTool, deleteFileTool, deleteDirectoryTool, runShellTool, webSearchTool, executeToolCall } from '../tools/workspaceTools';
import { createFile as createFileCapability, deleteFile as deleteFileCapability } from '../capabilities/files';
import { formatFilesAffected } from '../capabilities/types';
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
  stripUnfencedSearchReplace,
  parseWebSearchCommands,
  isLongRunningCommand,
  containsWebSearchCommands,
  stripWebSearchTags,
  ShellResult,
  ShellCommand
} from '../tools/reasonerShellExecutor';
import { ContentTransformBuffer } from '../utils/ContentTransformBuffer';
import { StructuralEventRecorder } from '../events/StructuralEventRecorder';
import { extractCodeBlocks, hasIncompleteFence } from '../utils/codeBlocks';
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

// ── File Watcher Ignore Patterns ──
// Directories to always ignore at any depth in the file tree.
// Covers dependency, cache, and tooling directories across all major languages.
const WATCHER_IGNORE_SEGMENTS = new Set([
  // VCS
  '.git', '.svn', '.hg', 'CVS',
  // JavaScript/TypeScript
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.parcel-cache', '.cache', '.vite', '.npm', 'bower_components',
  'jspm_packages', 'web_modules', '.yarn', '.pnpm-store',
  'coverage', '.nyc_output', '.eslintcache', 'storybook-static',
  // Python
  '__pycache__', '.venv', 'venv', '.tox', '.nox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.hypothesis',
  '.pybuilder', '.eggs', 'htmlcov', '.ipynb_checkpoints',
  // Java/Kotlin
  '.gradle', '.idea', '.kotlin', '.konan',
  // C/C++
  'CMakeFiles', '.ccache', 'vcpkg_installed', '_deps',
  // C#/.NET
  '.vs', 'TestResults', 'packages',
  // Go (module cache is global, not in-project)
  // Rust
  // (target/ is root-only below)
  // PHP
  '.phpunit.cache',
  // Ruby
  '.bundle', '.yardoc', '_yardoc',
  // Swift/Objective-C
  'Pods', 'Carthage', 'DerivedData', '.swiftpm', 'xcuserdata',
  // Dart/Flutter
  '.dart_tool',
  // Elixir/Erlang
  'deps', '_build', '.elixir_ls', '.fetch', 'ebin',
  '_checkouts', '.rebar', '.rebar3', '.eunit',
  // Haskell
  '.stack-work', '.cabal-sandbox', '.hpc',
  // Scala
  '.bloop', '.metals', '.bsp',
  // Perl
  'blib', 'cover_db',
  // Lua
  'lua_modules', '.luarocks',
  // R
  'renv', 'packrat', '.Rproj.user', 'rsconnect',
  // Lisp/Scheme
  'compiled',
  // OS
  '.DS_Store',
]);

// Directories to ignore only at workspace root (could be legitimate subdirectories deeper)
const WATCHER_IGNORE_ROOT_DIRS = new Set([
  'dist', 'build', 'Build', 'out', 'output',
  'target', 'vendor', 'bin', 'obj',
  'Debug', 'Release', 'artifacts',
  'tmp', 'pkg', 'doc', 'docs',
  'local', 'inc',
]);

/** Check if a relative path should be ignored by the file watcher. */
function shouldIgnoreWatcherPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  for (const seg of segments) {
    if (WATCHER_IGNORE_SEGMENTS.has(seg)) return true;
  }
  if (segments.length > 0 && WATCHER_IGNORE_ROOT_DIRS.has(segments[0])) return true;
  return false;
}

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

  /**
   * Check if it's safe for chatProvider to flush batched tokens to the webview.
   * Returns false when the pipeline is in a state where flushing would leak
   * partial tags, show tokens during approval, or display content prematurely.
   */
  canFlushTokens(): boolean {
    return !this._approvalPending &&
           this._pendingInlineShellCommands.length === 0 &&
           !(this.contentBuffer?.isHoldingBack());
  }

  // ── State ──
  private abortController: AbortController | null = null;
  private contentBuffer: ContentTransformBuffer | null = null;
  // Tracks whether the current abort was user-initiated (vs backend error).
  // Determines which marker is shown: *[User interrupted]* vs *[Generation stopped]*.
  private _userInitiatedStop = false;
  // Queue for shell commands detected inline during streaming (legacy — being replaced by interrupt-and-resume)
  private _pendingInlineShellCommands: Array<{ command: string }> = [];
  // Track commands already executed inline (to avoid re-execution in batch)
  private _inlineExecutedCommands: Set<string> = new Set();
  // Pause token streaming during command approval
  private _approvalPending = false;
  private _heldSegments: Array<{ type: string; content: unknown; complete?: boolean }> = [];
  // Promise that resolves when inline shell execution (including any approval) completes
  private _inlineExecutionPromise: Promise<void> | null = null;
  // ── Interrupt-and-Resume Shell Execution ──
  // When ContentTransformBuffer detects a complete <shell> tag, it sets this command
  // and aborts the stream. The iteration loop detects the interrupt and executes the
  // command before starting a new API call.
  private _shellInterruptCommand: string | null = null;
  private _shellInterruptAborted = false;
  // ADR 0003: structural event recorder (extension-authored turn events).
  // Phase 1 populates it at existing emission sites for the Export Turn debug
  // command and fidelity tests; Phases 2 and 3 persist and hydrate from it.
  public readonly structuralEvents = new StructuralEventRecorder();
  // Disposables for subscriptions created by wireStructuralRecorder(). Tracked
  // so dispose() can cleanly tear them down — tests that construct multiple
  // orchestrators would otherwise leak subscribers. See ADR 0003 Phase 2.
  private _recorderDisposables: vscode.Disposable[] = [];

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

    this.wireStructuralRecorder();
  }

  /**
   * ADR 0003: subscribe the StructuralEventRecorder to existing event emitters
   * so every structural event fires once from a single place. Done as a central
   * subscription rather than scattered append() calls at each fire() site, so
   * future emission sites are captured automatically.
   *
   * Phase 1 wiring covers events the extension already fires. Later phases
   * (code-block, drawing, approval-created/resolved, thinking-*) will emit new
   * events that land through the same pipe.
   */
  private wireStructuralRecorder(): void {
    // Shell IDs are allocated here so start and complete can be paired on restore.
    // Execution is serial within a turn, so a FIFO queue is sufficient.
    const pendingShellIds: string[] = [];
    let shellCounter = 0;
    let approvalCounter = 0;
    let thinkingActive = false;

    const track = <T>(disposable: T): T => {
      this._recorderDisposables.push(disposable as unknown as vscode.Disposable);
      return disposable;
    };

    track(this.onShellExecuting(e => {
      const id = `sh-${++shellCounter}`;
      pendingShellIds.push(id);
      this._currentShellIdForRecorder = id;
      this._appendStructuralEvent({
        type: 'shell-start',
        id,
        commands: e.commands.map(c => ({ command: c.command, description: c.description })),
        iteration: this._currentIterationForRecorder,
        ts: Date.now(),
      });
    }));

    track(this.onShellResults(e => {
      const id = pendingShellIds.shift() ?? `sh-unmatched-${++shellCounter}`;
      this._currentShellIdForRecorder = null;
      this._appendStructuralEvent({
        type: 'shell-complete',
        id,
        results: e.results.map(r => ({
          output: r.output,
          success: r.success,
        })),
        ts: Date.now(),
      });
    }));

    track(this.onIterationStart(e => {
      // Only emit iteration-end when we're transitioning OUT of a real
      // iteration. The very first onIterationStart fires with iteration=1 to
      // signal "starting iteration 1" — there's no prior iteration to end.
      // _currentIterationForRecorder starts at 0 (virtual "before anything"),
      // so the condition guards against phantom iteration-end(0) events.
      if (this._currentIterationForRecorder > 0) {
        this._flushCodeBlocksForIteration(this._currentIterationForRecorder);
        this._appendStructuralEvent({
          type: 'iteration-end',
          iteration: this._currentIterationForRecorder,
          ts: Date.now(),
        });
      }
      this._currentIterationForRecorder = e.iteration;
      // Phase 2.5 fix #4: if the prior iteration ended with an unclosed fence
      // (e.g. R1 opened ``` but didn't close before an interrupt), carry the
      // substring from the open-fence onward into the next iteration so the
      // closing fence in iteration N+1 still pairs with its opener.
      const carry = this._carryForwardIfIncompleteFence();
      this._iterationContentAccum = carry;
      this._iterationCodeBlocksEmitted = 0;
    }));

    // Phase 2.5 fix #8: ordering matters. A content token must emit
    // thinking-complete BEFORE text-append so hydration renders the thinking
    // block as closed when the first visible text appears. Likewise, a
    // reasoning token following content must emit thinking-start BEFORE
    // thinking-content. Both cases are handled inline inside the single
    // subscription instead of layered separate handlers (which fired in
    // registration order and reversed the desired event sequence).
    const closeThinking = () => {
      if (thinkingActive) {
        thinkingActive = false;
        this._appendStructuralEvent({
          type: 'thinking-complete',
          iteration: this._currentIterationForRecorder,
          ts: Date.now(),
        });
      }
    };

    track(this.onStreamToken(e => {
      closeThinking();
      this._appendStructuralEvent({
        type: 'text-append',
        content: e.token,
        iteration: this._currentIterationForRecorder,
        ts: Date.now(),
      });
      this._iterationContentAccum += e.token;
    }));

    track(this.onStreamReasoning(e => {
      if (!thinkingActive) {
        thinkingActive = true;
        this._appendStructuralEvent({
          type: 'thinking-start',
          iteration: this._currentIterationForRecorder,
          ts: Date.now(),
        });
      }
      this._appendStructuralEvent({
        type: 'thinking-content',
        content: e.token,
        iteration: this._currentIterationForRecorder,
        ts: Date.now(),
      });
    }));

    track(this.onIterationStart(() => closeThinking()));
    track(this.onEndResponse(() => closeThinking()));

    // Phase 2.5 fix #6: emit file-modified events live as DiffManager applies
    // or rejects edits. Previously these only landed during the end-of-turn
    // save backfill; Phase 3 hydration needs them in-stream.
    track(this.diffManager.onCodeApplied(e => {
      if (!e.filePath) return;
      this._appendStructuralEvent({
        type: 'file-modified',
        path: e.filePath,
        status: e.success ? 'applied' : 'failed',
        editMode: this.diffManager.currentEditMode,
        ts: Date.now(),
      });
    }));
    track(this.diffManager.onEditRejected(e => {
      this._appendStructuralEvent({
        type: 'file-modified',
        path: e.filePath,
        status: 'rejected',
        editMode: this.diffManager.currentEditMode,
        ts: Date.now(),
      });
    }));

    // Phase 2.5 fix #5: mirror Chat-model tool call events into the recorder.
    // Without this, hydration of Chat turns loses all tool call rendering.
    track(this.onToolCallsStart(e => {
      this._appendStructuralEvent({
        type: 'tool-batch-start',
        tools: e.tools.map(t => ({ name: t.name, detail: t.detail })),
        ts: Date.now(),
      });
    }));
    track(this.onToolCallsUpdate(e => {
      this._appendStructuralEvent({
        type: 'tool-batch-update',
        tools: e.tools.map(t => ({ name: t.name, detail: t.detail, status: t.status })),
        ts: Date.now(),
      });
    }));
    track(this.onToolCallUpdate(e => {
      this._appendStructuralEvent({
        type: 'tool-update',
        index: e.index,
        status: e.status,
        ts: Date.now(),
      });
    }));
    track(this.onToolCallsEnd(() => {
      this._appendStructuralEvent({
        type: 'tool-batch-complete',
        ts: Date.now(),
      });
    }));

    if (this.commandApprovalManager) {
      track(this.commandApprovalManager.onApprovalRequired(e => {
        const id = `ap-${++approvalCounter}`;
        this._currentApprovalIdForRecorder = id;
        this._appendStructuralEvent({
          type: 'approval-created',
          id,
          command: e.command,
          prefix: e.prefix,
          shellId: this._currentShellIdForRecorder ?? 'unknown',
          ts: Date.now(),
        });
      }));
      track(this.commandApprovalManager.onApprovalResolved(e => {
        const id = this._currentApprovalIdForRecorder ?? `ap-unmatched-${++approvalCounter}`;
        this._currentApprovalIdForRecorder = null;
        this._appendStructuralEvent({
          type: 'approval-resolved',
          id,
          decision: e.decision,
          persistent: e.persistent,
          ts: Date.now(),
        });
      }));
    }
  }

  /**
   * Phase 2.5 fix #7: external hook for drawing events. DrawingServer is owned
   * by ChatProvider, so ChatProvider forwards each received image into the
   * structural event stream via this method. No-op if no turn is active.
   */
  recordDrawing(imageDataUrl: string): void {
    this._appendStructuralEvent({
      type: 'drawing',
      imageDataUrl,
      ts: Date.now(),
    });
  }

  /**
   * ADR 0003 Phase 2: single emit point that appends to the in-memory recorder
   * and also writes the event to the events table (if a turn is active with a
   * session). Keeps emission sites small and ensures live and persisted streams
   * stay byte-for-byte identical.
   */
  private _appendStructuralEvent(event: import('../../shared/events/TurnEvent').TurnEvent): void {
    this.structuralEvents.append(event);
    const turnId = this._currentTurnId;
    const sessionId = this._currentSessionIdForRecorder;
    if (turnId && sessionId) {
      try {
        this.conversationManager.recordStructuralEvent(
          sessionId, turnId, this._structuralEventIndex++, event as unknown as Record<string, unknown>
        );
      } catch (err: any) {
        // Persist errors should never break the turn — just log and continue.
        logger.warn(`[StructuralEvent] failed to persist: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Emit code-block events for any new fenced blocks that appeared in the
   * iteration's accumulated content. Called at iteration boundaries and
   * end-of-turn. Uses shared/parsing/codeBlocks so the webview and extension
   * agree on what counts as a code block (ADR 0003).
   */
  private _flushCodeBlocksForIteration(iteration: number): void {
    const blocks = extractCodeBlocks(this._iterationContentAccum);
    for (let i = this._iterationCodeBlocksEmitted; i < blocks.length; i++) {
      const b = blocks[i];
      this._appendStructuralEvent({
        type: 'code-block',
        language: b.language,
        content: b.content,
        iteration,
        ts: Date.now(),
      });
    }
    this._iterationCodeBlocksEmitted = blocks.length;
  }

  /**
   * Phase 2.5 fix #4: return the open-fence remainder of the current iteration's
   * accumulated content if a fence opened but never closed, else empty string.
   * The remainder seeds the next iteration's accumulator so a block spanning
   * two iterations parses as one on the N+1 flush.
   */
  private _carryForwardIfIncompleteFence(): string {
    const { incomplete, lastOpenIndex } = hasIncompleteFence(this._iterationContentAccum);
    if (!incomplete || lastOpenIndex < 0) return '';
    return this._iterationContentAccum.slice(lastOpenIndex);
  }

  // Tracks the iteration number the recorder should stamp on shell-start events.
  // Updated by the onIterationStart subscription in wireStructuralRecorder().
  private _currentIterationForRecorder = 0;
  // Current in-flight shell id, used to correlate approval-created events with
  // the shell that triggered them.
  private _currentShellIdForRecorder: string | null = null;
  // Current in-flight approval id, used to pair approval-created with approval-resolved.
  private _currentApprovalIdForRecorder: string | null = null;
  // Per-iteration accumulated content text, for code-block extraction on boundaries.
  private _iterationContentAccum = '';
  // How many code blocks have already been emitted from the current iteration's
  // accumulated content (so we don't re-emit earlier blocks each flush).
  private _iterationCodeBlocksEmitted = 0;
  // ADR 0003 Phase 2: turn-scoped correlation id for incremental persistence.
  private _currentTurnId: string | null = null;
  // Monotonic index of the next structural event row to write for this turn.
  private _structuralEventIndex = 0;
  // Session id copy for the recorder subscription (avoids threading through every emit).
  private _currentSessionIdForRecorder: string | null = null;

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

    // ADR 0003: begin structural event recording for this turn. turnId is
    // derived from sessionId + timestamp since we don't yet have a persisted
    // turn row. Reset ALL per-turn recorder state — not just iteration — to
    // prevent stale shell/approval IDs or buffered content from a prior turn
    // leaking into this one (Phase 2.5 gap #8).
    this._currentIterationForRecorder = 0;
    this._currentShellIdForRecorder = null;
    this._currentApprovalIdForRecorder = null;
    this._iterationContentAccum = '';
    this._iterationCodeBlocksEmitted = 0;
    const turnId = `${sessionId ?? 'no-session'}-${Date.now()}`;
    this._currentTurnId = turnId;
    this._currentSessionIdForRecorder = sessionId;
    this._structuralEventIndex = 0;
    this.structuralEvents.startTurn(turnId, sessionId);

    // Phase 2: write a placeholder assistant_message with status='in_progress'
    // so a crash mid-turn leaves a recoverable record on disk (the structural
    // event rows complete the picture).
    if (sessionId && !options?.skipRecord) {
      await this.conversationManager.recordAssistantMessage(
        sessionId, '', this.deepSeekClient.getModel(), 'stop',
        undefined, undefined, undefined,
        { status: 'in_progress', turnId }
      );
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

    // Create abort controller for this request (mutable — shell interrupt replaces it)
    this.abortController = new AbortController();
    let signal = this.abortController.signal;
    this._userInitiatedStop = false;

    // Get the current correlation ID for cross-boundary tracing
    const correlationId = logger.getCurrentCorrelationId();

    this._onStartResponse.fire({
      isReasoner: isReasonerModel,
      correlationId: correlationId || undefined
    });

    // Reset interrupt state
    this._shellInterruptCommand = null;
    this._shellInterruptAborted = false;

    // Initialize content transform buffer for debounced streaming
    this.contentBuffer = new ContentTransformBuffer({
      debounceMs: 150,
      debug: false,
      log: (msg) => logger.debug(msg),
      // Interrupt-and-resume: when a complete <shell> tag is detected, abort the stream
      onShellDetected: isReasonerModel ? (command: string, _textBefore: string) => {
        logger.info(`[R1-Shell] Interrupt: detected shell command "${command.substring(0, 60)}..." — aborting stream`);
        this._shellInterruptCommand = command;
        this._shellInterruptAborted = true;
        // Abort the HTTP stream — streamChat will throw AbortError
        if (this.abortController) {
          this.abortController.abort();
        }
      } : undefined,
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
              // With interrupt-and-resume, shell segments are handled by onShellDetected
              // and never reach onFlush. This is a safety fallback only.
              if (!isReasonerModel && segment.complete && Array.isArray(segment.content)) {
                logger.warn(`[ContentBuffer] Shell segment in onFlush (unexpected with interrupt-and-resume)`);
              }
              break;
            case 'thinking':
              logger.debug(`[ContentBuffer] Detected thinking tags, handled separately`);
              break;
            case 'web_search':
              logger.debug(`[ContentBuffer] Detected web_search tags, will be handled after iteration`);
              break;
            case 'dsml':
              // DSML tool-call blocks are suppressed from the streaming display.
              // `parseDSMLToolCalls` converts them to structured `tool_calls`
              // at end-of-response so the tool loop still executes.
              logger.debug(`[ContentBuffer] Suppressed DSML tool-call block from stream`);
              break;
          }
        }
      }
    });

    // Log the API request
    const model = this.deepSeekClient.getModel();
    const hasAttachments = attachments && attachments.length > 0;
    // performance.now() — monotonic, immune to wall-clock lurches (WSL2
    // sleep/resume can produce negative durations with Date.now()).
    const requestStartTime = performance.now();

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

      // ── Pipeline selection ────────────────────────────────────────────
      // Three paths today:
      //   1. `streamingToolCalls: true`  — single streaming pipeline that
      //      emits content + reasoning + tool_calls in parallel and dispatches
      //      tools inline (Phase 4.5). Replaces the runToolLoop + streamAndIterate
      //      split for V4-thinking, V4 non-thinking, and any custom model
      //      that opts in.
      //   2. `!isReasonerModel` (chat model, flag off) — legacy path:
      //      `runToolLoop` runs a non-streaming probe to collect tool messages,
      //      then `streamAndIterate` streams the final no-tools answer.
      //   3. R1 reasoner — `streamAndIterate` directly (no tool loop; R1's
      //      `<shell>` XML transport is parsed inline during streaming).
      const caps = getCapabilities(model);

      if (caps.streamingToolCalls) {
        const { allToolDetails: toolDetails } = await this.runStreamingToolCallsLoop(
          contextMessages, systemPrompt, signal, streamState, contextResult.budget
        );
        toolCallsForHistory = toolDetails;
        // No streamAndIterate fallthrough — the streaming loop already emitted
        // everything (content + reasoning + tool dispatches) and ran to
        // `finish_reason: 'stop'`. The "exploration phase complete" prompt
        // amendment is also dropped: there's no separate exploration phase.
      } else {
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

        // Run streaming + shell iteration loop (mutates streamState in-place).
        await this.streamAndIterate(
          contextMessages, streamingSystemPrompt, signal, message, isReasonerModel,
          streamState, contextResult.budget
        );
      }

      // Flush and reset the content buffer before finalizing
      if (this.contentBuffer) {
        logger.info(`[Buffer] FLUSH before endResponse (final)`);
        this.contentBuffer.flush();
        logger.info(`[Buffer] RESET after final flush`);
        this.contentBuffer.reset();
      }

      // Final code block detection — catches blocks released by the buffer's
      // final flush that were missed during streaming (debounce/holdback timing)
      await this.diffManager.handleCodeBlockDetection(streamState.accumulatedResponse);

      // Strip any DSML markup, shell tags, and web search tags from the final response
      let cleanResponse = stripDSML(streamState.accumulatedResponse);
      cleanResponse = stripShellTags(cleanResponse);
      cleanResponse = stripWebSearchTags(cleanResponse);

      // Unfenced SEARCH/REPLACE Detection (Fallback)
      // Process the edits first, then strip the markers from displayed content
      // so raw <<<SEARCH...>>>REPLACE blocks don't leak into the chat UI.
      if (this.diffManager.currentEditMode !== 'manual') {
        await this.diffManager.detectAndProcessUnfencedEdits(cleanResponse);
      }
      cleanResponse = stripUnfencedSearchReplace(cleanResponse);

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

      // ADR 0003 Phase 3: webview no longer returns a consolidated event log —
      // the extension is the sole author of structural events. No receiver to prepare.

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

      // ADR 0003: flush any remaining code blocks for the last iteration, emit
      // a final iteration-end (only if a real iteration ran — Chat-model turns
      // never fire onIterationStart, so skip the boundary marker for them),
      // then drain the turn.
      if (this._currentIterationForRecorder > 0) {
        this._flushCodeBlocksForIteration(this._currentIterationForRecorder);
        this._appendStructuralEvent({
          type: 'iteration-end',
          iteration: this._currentIterationForRecorder,
          ts: Date.now(),
        });
      }
      this.structuralEvents.drainTurn();

      // History Save Pipeline
      await this.saveToHistory(
        sessionId, cleanResponse, streamState.fullReasoning, model,
        streamState.reasoningIterations, streamState.contentIterations,
        toolCallsForHistory, streamState.shellResultsForHistory
      );

      // Log successful response
      const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + streamState.fullReasoning);
      logger.apiResponse(tokenCount, Math.round(performance.now() - requestStartTime));

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
        const userInitiated = this._userInitiatedStop;
        const marker = userInitiated ? '*[User interrupted]*' : '*[Generation stopped]*';
        this._userInitiatedStop = false;

        const partialContent = streamState.accumulatedResponse || streamState.fullResponse;

        // Option A: For user-initiated stops, save ONLY the marker (drop the partial content).
        // The partial text was already streamed live but the user explicitly stopped — they
        // don't want it persisted. Reasoning iterations and file modifications are still saved
        // via their own paths. Backend aborts keep partial content for forensics.
        // See: docs/architecture/decisions/0001-stop-button-discards-partial.md
        const savedText = userInitiated
          ? marker
          : (partialContent
              ? `${stripUnfencedSearchReplace(stripWebSearchTags(stripShellTags(stripDSML(partialContent))))}\n\n${marker}`
              : marker);

        if (sessionId && (partialContent || streamState.fullReasoning)) {
          for (let i = 0; i < streamState.reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(sessionId!, streamState.reasoningIterations[i], i);
          }
          await this.conversationManager.recordAssistantMessage(
            sessionId!, savedText, model, 'stop', undefined, undefined, undefined,
            // Phase 2: mark interrupted so hydration can show the partial with
            // an "[Interrupted]" affordance distinct from a clean completion.
            { status: 'interrupted', turnId: this._currentTurnId ?? undefined }
          );
          logger.info(`[RequestOrchestrator] Saved ${userInitiated ? 'marker-only' : 'partial response'} to history`);
        }

        // Fire marker as a stream token so the live UI sees it via the normal token flow,
        // then fire endResponse so the streaming turn ends cleanly with the marker included.
        this._onStreamToken.fire({ token: `\n\n${marker}` });
        this._onEndResponse.fire({
          role: 'assistant',
          content: savedText,
          reasoning_content: streamState.fullReasoning || undefined,
          finish_reason: 'stop'
        } as any);

        // ADR 0003 Phase 2.5: flush trailing code blocks and emit a final
        // iteration-end before draining, matching the success path. Skip the
        // boundary marker for turns that never entered a real iteration
        // (Chat model, or early aborts before any iteration-start fires).
        if (this._currentIterationForRecorder > 0) {
          this._flushCodeBlocksForIteration(this._currentIterationForRecorder);
          this._appendStructuralEvent({
            type: 'iteration-end',
            iteration: this._currentIterationForRecorder,
            ts: Date.now(),
          });
        }
        this.structuralEvents.drainTurn();

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

      // Finalize the in_progress assistant_message with status='interrupted'
      // and an error marker. Without this, ConversationManager hydration sees
      // a turn whose only assistant_message row is status='in_progress' and
      // synthesizes a `shutdown-interrupted` event — surfacing the misleading
      // "*[Interrupted by shutdown]*" marker on a turn that actually died to
      // an API error. Mirrors the abort path above ([line ~950]) but with a
      // marker that names the real cause.
      if (sessionId) {
        const partialContent = streamState.accumulatedResponse || streamState.fullResponse || '';
        const errorMarker = `*[API error: ${errorMessage}]*`;
        const savedText = partialContent
          ? `${stripUnfencedSearchReplace(stripWebSearchTags(stripShellTags(stripDSML(partialContent))))}\n\n${errorMarker}`
          : errorMarker;
        try {
          for (let i = 0; i < streamState.reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(sessionId, streamState.reasoningIterations[i], i);
          }
          await this.conversationManager.recordAssistantMessage(
            sessionId, savedText, model, 'stop', undefined, undefined, undefined,
            { status: 'interrupted', turnId: this._currentTurnId ?? undefined }
          );
          logger.info(`[RequestOrchestrator] Saved error-finalized turn to history`);
        } catch (saveError: any) {
          logger.error(`[RequestOrchestrator] Failed to finalize errored turn: ${saveError.message}`);
        }
        // Surface the marker live too, so the user sees the cause of the
        // failure inline instead of a silent stop.
        this._onStreamToken.fire({ token: `\n\n${errorMarker}` });
        this._onEndResponse.fire({
          role: 'assistant',
          content: savedText,
          reasoning_content: streamState.fullReasoning || undefined,
          finish_reason: 'stop'
        } as any);
      }

      // ADR 0003 Phase 3 follow-up: drain the structural recorder on non-abort
      // error paths too, so a crashed/failed turn leaves a lastCompletedTurn
      // inspectable via `Moby: Export Turn as JSON`. Without this, the recorder
      // stays mid-turn until the next handleMessage discards it silently.
      if (this._currentIterationForRecorder > 0) {
        this._flushCodeBlocksForIteration(this._currentIterationForRecorder);
        this._appendStructuralEvent({
          type: 'iteration-end',
          iteration: this._currentIterationForRecorder,
          ts: Date.now(),
        });
      }
      this.structuralEvents.drainTurn();
    } finally {
      const wasAborted = this.abortController === null || signal.aborted;
      this.abortController = null;
      // Clean up content buffer — only flush if NOT aborted (user stop or shell interrupt).
      // Flushing during abort would dump partial tags/content into the UI.
      if (this.contentBuffer) {
        if (!wasAborted) {
          logger.info(`[Buffer] FLUSH in finally block (cleanup)`);
          this.contentBuffer.flush();
        } else {
          logger.info(`[Buffer] SKIP flush in finally block (aborted)`);
        }
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
    this._userInitiatedStop = true;
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
    this._recorderDisposables.forEach(d => d.dispose());
    this._recorderDisposables = [];
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
    const promptStyle: PromptStyle = getCapabilities(this.deepSeekClient.getModel()).promptStyle ?? 'standard';

    // ── 1. Identity + Conversational Gate ──
    let systemPrompt = buildIdentityAndGate(promptStyle);

    // ── 2. Model-specific capabilities ──
    const wsState = await this.webSearchManager.getSettings();
    const webSearchAutoAvailable = wsState.mode === 'auto' && wsState.configured;
    const runShellAvailable = getCapabilities(this.deepSeekClient.getModel()).shellProtocol === 'native-tool';
    if (isReasonerModel) {
      systemPrompt += getReasonerShellPrompt({ webSearchAvailable: webSearchAutoAvailable });
    } else {
      systemPrompt += buildToolGuidance(promptStyle, webSearchAutoAvailable, runShellAvailable);
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

    // Manual-mode web search: pre-fetch and inject into the system prompt.
    // The explicit "do not call web_search" guidance below is load-bearing
    // for weak tool-calling models (7B / 14B local) that pattern-match on
    // prior assistant turns in history — they'll otherwise emit a
    // web_search tool call this turn despite the tool not being in the
    // schema. Telling them explicitly stops the loop.
    const webSearchContext = await this.webSearchManager.searchForMessage(message);
    if (webSearchContext) {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      systemPrompt += `\n\n--- WEB SEARCH RESULTS (${today}) ---\n${webSearchContext}\n--- END WEB SEARCH RESULTS ---\n\nThese results were retrieved for you. Use them to answer the user's question — do not call the web_search tool, it is unavailable this turn.\n`;
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
          approvedCommands.push({ ...cmd, approvalStatus: 'auto' });
          continue;
        }

        if (!this.commandApprovalManager) {
          approvedCommands.push({ ...cmd, approvalStatus: 'auto' });
          continue;
        }

        const decision = this.commandApprovalManager.checkCommand(cmd.command);
        if (decision === 'allowed') {
          approvedCommands.push({ ...cmd, approvalStatus: 'auto' });
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
            approvedCommands.push({ ...cmd, approvalStatus: 'user-allowed' });
          } else {
            blockedResults.push({
              command: cmd.command,
              output: `Command rejected by user: ${cmd.command}`,
              success: false,
              executionTimeMs: 0,
              approvalStatus: 'user-blocked'
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
          if (!shouldIgnoreWatcherPath(relativePath)) {
            modifiedFiles.add(relativePath);
          }
        };
        shellFileWatcher.onDidChange(trackChange);
        shellFileWatcher.onDidCreate(trackChange);
        shellFileWatcher.onDidDelete((uri: vscode.Uri) => {
          const relativePath = vscode.workspace.asRelativePath(uri, false);
          if (!shouldIgnoreWatcherPath(relativePath)) {
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
    },
    contextBudgetTokens: number
  ): Promise<void> {
    // Reasoner shell loop - run shell commands if R1 outputs them
    const shellConfig = vscode.workspace.getConfiguration('moby');
    const configuredShellLimit = shellConfig.get<number>('maxShellIterations') ?? 100;
    const maxShellIterations = configuredShellLimit >= 100 ? Infinity : configuredShellLimit;
    const configuredFileEditLoops = shellConfig.get<number>('maxFileEditLoops') ?? 100;
    const maxFileEditLoops = configuredFileEditLoops >= 100 ? Infinity : configuredFileEditLoops;
    let shellIteration = 0;
    let currentSystemPrompt = streamingSystemPrompt;
    let currentHistoryMessages = [...contextMessages];

    // Auto-continuation tracking for R1 — separate counters per reason
    const maxZeroContentRetries = 2;      // C6: R1 put shell tags in reasoning but no content
    const maxFailedEditRetries = 3;       // C9: code edits failed to apply, re-read file
    const maxNudgeContinuations = 4;      // C10: shell ran but no edits produced, nudge to finish
    let zeroContentRetries = 0;
    let failedEditRetries = 0;
    let nudgeContinuations = 0;
    let postEditContinuations = 0;
    let lastIterationHadShellCommands = false;

    // Token budget tracking for injected shell/web search results
    let accumulatedIterationTokens = 0;
    const iterationBudget = 60_000;  // Safety cap: ~60k tokens of injected context
    let budgetExceeded = false;       // Soft-stop: skip execution but let R1 finish

    do {
      // Check abort at the start of each iteration
      if (signal.aborted) break;

      // ── Context window pressure check ──
      // Estimate total tokens in currentHistoryMessages + system prompt.
      // If approaching the context window limit, soft-stop to avoid API rejection.
      if (shellIteration > 0 && contextBudgetTokens > 0 && !budgetExceeded) {
        const systemTokens = this.deepSeekClient.estimateTokens(currentSystemPrompt);
        let contextTokens = systemTokens;
        for (const msg of currentHistoryMessages) {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          contextTokens += this.deepSeekClient.estimateTokens(text);
        }
        const usageRatio = contextTokens / contextBudgetTokens;
        if (usageRatio > 0.90) {
          logger.warn(`[R1-Budget] Context window pressure: ${contextTokens.toLocaleString()}/${contextBudgetTokens.toLocaleString()} tokens (${(usageRatio * 100).toFixed(1)}%) — soft-stop`);
          budgetExceeded = true;
          this._onWarning.fire({
            message: `Context window nearly full (${(usageRatio * 100).toFixed(0)}%). Completing with available information.`
          });
        } else if (usageRatio > 0.70) {
          logger.info(`[R1-Budget] Context pressure: ${(usageRatio * 100).toFixed(1)}% (${contextTokens.toLocaleString()}/${contextBudgetTokens.toLocaleString()})`);
        }
      }

      // Track iteration-specific response
      let iterationResponse = '';
      // Reset inline shell tracking for this iteration
      this._pendingInlineShellCommands = [];
      this._inlineExecutedCommands.clear();
      this._inlineExecutionPromise = null;

      // Timing metrics for debugging — performance.now() throughout so
      // durations stay positive even if Date.now() lurches mid-iteration.
      const iterationStartTime = performance.now();
      let firstReasoningTokenTime: number | null = null;
      let firstContentTokenTime: number | null = null;

      logger.info(`[Iteration] Starting iteration ${shellIteration + 1}, messages in context: ${currentHistoryMessages.length}`);
      logger.info(`[Timing] Iteration ${shellIteration + 1} started at ${new Date().toISOString()}`);
      if (isReasonerModel) {
        logger.setIteration(shellIteration + 1);
        this._onIterationStart.fire({ iteration: shellIteration + 1 });
      } else {
        logger.setIteration(shellIteration + 1);
      }

      // ── Stream with interrupt-and-resume support ──
      // The ContentTransformBuffer may abort the stream when it detects a <shell> tag.
      // If that happens, we catch the AbortError, execute the command, inject results,
      // and `continue` back to the do/while loop for a new API call.
      try {
        const _response = await this.deepSeekClient.streamChat(
          currentHistoryMessages,
          async (token) => {
            // Track timing for first content token
            if (!firstContentTokenTime) {
              firstContentTokenTime = performance.now();
              const waitTime = Math.round(firstContentTokenTime - iterationStartTime);
              const afterReasoning = firstReasoningTokenTime
                ? Math.round(firstContentTokenTime - firstReasoningTokenTime)
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

            // Use content buffer for debounced streaming (filters shell tags).
            // For Reasoner: the buffer's onShellDetected callback will abort the stream
            // when a <shell> tag is found (interrupt-and-resume flow).
            if (this.contentBuffer) {
              this.contentBuffer.append(token);
            } else {
              this._onStreamToken.fire({ token });
            }

            // Detect complete code blocks and auto-handle in "ask" or "auto" mode
            if (!this._shellInterruptAborted) {
              await this.diffManager.handleCodeBlockDetection(state.accumulatedResponse);
            }
          },
          currentSystemPrompt,
          // Reasoning callback for deepseek-reasoner
          isReasonerModel ? (reasoningToken) => {
            if (!firstReasoningTokenTime) {
              firstReasoningTokenTime = performance.now();
              const waitTime = Math.round(firstReasoningTokenTime - iterationStartTime);
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

        // ── Shell Interrupt Race: stream completed before abort() threw ──
        // If onShellDetected set the flag but the stream finished naturally (short response),
        // the catch block is never entered. Handle it here identically.
        if (this._shellInterruptAborted && this._shellInterruptCommand) {
          const shellCommand = this._shellInterruptCommand;
          this._shellInterruptCommand = null;
          this._shellInterruptAborted = false;

          logger.info(`[R1-Shell] Interrupt (post-stream): stream finished before abort — executing: "${shellCommand.substring(0, 80)}..."`);

          if (this.contentBuffer) {
            this.contentBuffer.flush();
            this.contentBuffer.reset();
          }

          // Create a new abort controller for the next iteration
          this.abortController = new AbortController();
          signal = this.abortController.signal;

          if (budgetExceeded) {
            logger.info(`[R1-Shell] Post-stream interrupt skipped — budget exceeded`);
            const partialResponse = stripShellTags(state.currentIterationContent || '');
            if (partialResponse.trim()) {
              currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
            }
            currentHistoryMessages.push({
              role: 'user',
              content: `Context budget reached. The shell command "${shellCommand.substring(0, 60)}..." was not executed. Please complete your response with the information you already have.`
            });
            state.currentIterationContent = '';
            state.currentIterationReasoning = '';
            iterationResponse = '';
            firstContentTokenTime = null;
            firstReasoningTokenTime = null;
            shellIteration++;
            continue;
          }

          const commands = parseShellCommands(`<shell>${shellCommand}</shell>`);
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (commands.length > 0 && workspacePath) {
            if (isLongRunningCommand(commands[0].command)) {
              logger.info(`[R1-Shell] Skipping long-running command: "${commands[0].command.substring(0, 60)}..."`);
              const shellPayload = commands.map(c => ({ command: c.command, description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command }));
              this._onShellExecuting.fire({ commands: shellPayload });
              const skipMessage = `Skipped: "${commands[0].command}" is a long-running command. The user can start it manually.`;
              this._onShellResults.fire({ results: [{ command: commands[0].command, output: skipMessage, success: true }] });
              const partialResponse = stripShellTags(state.currentIterationContent || '');
              if (partialResponse.trim()) {
                currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
              }
              currentHistoryMessages.push({ role: 'user', content: `${skipMessage}\n\n[Continue]\nContinue with your next step. Do not re-run commands that have already succeeded.` });
              state.currentIterationContent = '';
              state.currentIterationReasoning = '';
              iterationResponse = '';
              firstContentTokenTime = null;
              firstReasoningTokenTime = null;
              shellIteration++;
              lastIterationHadShellCommands = true;
              continue;
            }

            const shellPayload = commands.map(c => ({ command: c.command, description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command }));
            this._onShellExecuting.fire({ commands: shellPayload });

            const allowAllCommands = vscode.workspace.getConfiguration('moby').get<boolean>('allowAllShellCommands') ?? false;
            let approved = true;
            let approvalStatus: ShellCommand['approvalStatus'] = 'auto';
            if (!allowAllCommands && this.commandApprovalManager) {
              const decision = this.commandApprovalManager.checkCommand(commands[0].command);
              if (decision !== 'allowed') {
                const userApproval = await this.commandApprovalManager.requestApproval(commands[0].command);
                approved = userApproval.decision === 'allowed';
                approvalStatus = approved ? 'user-allowed' : 'user-blocked';
              }
            }

            let resultsContext = '';
            if (approved) {
              const modifiedFiles = new Set<string>();
              let shellFileWatcher: vscode.FileSystemWatcher | undefined;
              try {
                shellFileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspacePath, '**/*'));
                const trackChange = (uri: vscode.Uri) => {
                  const relativePath = vscode.workspace.asRelativePath(uri, false);
                  if (!shouldIgnoreWatcherPath(relativePath)) { modifiedFiles.add(relativePath); }
                };
                shellFileWatcher.onDidChange(trackChange);
                shellFileWatcher.onDidCreate(trackChange);
              } catch { /* watcher optional */ }

              const taggedCommands = commands.map(c => ({ ...c, approvalStatus }));
              const results = await executeShellCommands(taggedCommands, workspacePath, { allowAllCommands, signal });
              state.shellResultsForHistory.push(...results);

              await new Promise(resolve => setTimeout(resolve, 100));
              if (shellFileWatcher) {
                shellFileWatcher.dispose();
                if (modifiedFiles.size > 0) {
                  logger.info(`[R1-Shell] Post-stream interrupt: File watcher detected ${modifiedFiles.size} modified files`);
                  this.diffManager.registerShellModifiedFiles([...modifiedFiles]);
                }
              }

              this._onShellResults.fire({
                results: results.map(r => ({ command: r.command, output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''), success: r.success }))
              });
              resultsContext = formatShellResultsForContext(results, {
                modifiedFiles: [...modifiedFiles],
                workspacePath
              });
              if (commandsCreateFiles(commands)) state.shellCreatedFiles = true;
              if (commandsDeleteFiles(commands)) state.shellDeletedFiles = true;
            } else {
              resultsContext = `Shell command rejected by user: ${commands[0].command}\n`;
            }

            const partialResponse = stripShellTags(state.currentIterationContent || '');
            if (partialResponse.trim()) {
              currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
            }
            currentHistoryMessages.push({
              role: 'user',
              content: `[Shell output]\n${resultsContext}\n[Continue]\nThe command above was executed as you requested. Continue with your next step. Do not re-run commands that have already succeeded.`
            });

            const injectedTokens = this.deepSeekClient.estimateTokens(resultsContext);
            accumulatedIterationTokens += injectedTokens;
            logger.info(`[R1-Shell] Post-stream interrupt: injected ${injectedTokens} tokens (total: ${accumulatedIterationTokens.toLocaleString()}/${iterationBudget.toLocaleString()})`);

            if (accumulatedIterationTokens > iterationBudget) {
              budgetExceeded = true;
            }

            state.currentIterationContent = '';
            state.currentIterationReasoning = '';
            iterationResponse = '';
            firstContentTokenTime = null;
            firstReasoningTokenTime = null;
            shellIteration++;
            lastIterationHadShellCommands = true;
            continue;
          }
          continue;
        }
      } catch (streamError: any) {
        // ── Shell Interrupt: ContentTransformBuffer detected a <shell> tag and aborted ──
        if (this._shellInterruptAborted && this._shellInterruptCommand) {
          const shellCommand = this._shellInterruptCommand;
          this._shellInterruptCommand = null;
          this._shellInterruptAborted = false;

          // Flush any buffered text to the UI
          if (this.contentBuffer) {
            this.contentBuffer.flush();
            this.contentBuffer.reset();
          }

          // Create a new abort controller (the old one is aborted)
          this.abortController = new AbortController();
          signal = this.abortController.signal;

          // Budget exceeded — skip execution, let R1 finish with what it has
          if (budgetExceeded) {
            logger.info(`[R1-Shell] Interrupt caught but budget exceeded — skipping execution, letting R1 finish`);
            const partialResponse = stripShellTags(state.currentIterationContent || '');
            if (partialResponse.trim()) {
              currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
            }
            currentHistoryMessages.push({
              role: 'user',
              content: `Context budget reached. The shell command "${shellCommand.substring(0, 60)}..." was not executed. Please complete your response with the information you already have. Do not run more commands.`
            });
            state.currentIterationContent = '';
            state.currentIterationReasoning = '';
            iterationResponse = '';
            firstContentTokenTime = null;
            firstReasoningTokenTime = null;
            shellIteration++;
            continue;
          }

          logger.info(`[R1-Shell] Interrupt caught — executing: "${shellCommand.substring(0, 80)}..."`);

          // Parse the command (heredoc-aware)
          const commands = parseShellCommands(`<shell>${shellCommand}</shell>`);
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (commands.length > 0 && workspacePath) {
            // Check for long-running commands (servers, watch modes, etc.)
            // These are never executed — they would spawn processes that never exit.
            if (isLongRunningCommand(commands[0].command)) {
              logger.info(`[R1-Shell] Skipping long-running command: "${commands[0].command.substring(0, 60)}..."`);

              // Notify frontend with a "skipped" shell segment
              const shellPayload = commands.map(c => ({
                command: c.command,
                description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command
              }));
              this._onShellExecuting.fire({ commands: shellPayload });

              const skipMessage = `Skipped: "${commands[0].command}" is a long-running server/watch command that would run indefinitely. The user can start it manually in their terminal.`;

              // Send result to frontend
              this._onShellResults.fire({
                results: [{ command: commands[0].command, output: skipMessage, success: true }]
              });

              // Inject into context so R1 knows it was skipped
              const partialResponse = stripShellTags(state.currentIterationContent || '');
              if (partialResponse.trim()) {
                currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
              }
              currentHistoryMessages.push({ role: 'user', content: `${skipMessage}\n\n[Continue]\nContinue with your next step. Do not re-run commands that have already succeeded.` });

              state.currentIterationContent = '';
              state.currentIterationReasoning = '';
              iterationResponse = '';
              firstContentTokenTime = null;
              firstReasoningTokenTime = null;

              shellIteration++;
              lastIterationHadShellCommands = true;
              continue;
            }

            // Notify frontend
            const shellPayload = commands.map(c => ({
              command: c.command,
              description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command
            }));
            this._onShellExecuting.fire({ commands: shellPayload });

            // Command approval
            const allowAllCommands = vscode.workspace.getConfiguration('moby')
              .get<boolean>('allowAllShellCommands') ?? false;

            let approved = true;
            let approvalStatus: ShellCommand['approvalStatus'] = 'auto';
            if (!allowAllCommands && this.commandApprovalManager) {
              const decision = this.commandApprovalManager.checkCommand(commands[0].command);
              if (decision !== 'allowed') {
                const userApproval = await this.commandApprovalManager.requestApproval(commands[0].command);
                approved = userApproval.decision === 'allowed';
                approvalStatus = approved ? 'user-allowed' : 'user-blocked';
              }
            }

            let resultsContext = '';
            if (approved) {
              // File watcher
              const modifiedFiles = new Set<string>();
              let shellFileWatcher: vscode.FileSystemWatcher | undefined;
              try {
                shellFileWatcher = vscode.workspace.createFileSystemWatcher(
                  new vscode.RelativePattern(workspacePath, '**/*')
                );
                const trackChange = (uri: vscode.Uri) => {
                  const relativePath = vscode.workspace.asRelativePath(uri, false);
                  if (!shouldIgnoreWatcherPath(relativePath)) {
                    modifiedFiles.add(relativePath);
                  }
                };
                shellFileWatcher.onDidChange(trackChange);
                shellFileWatcher.onDidCreate(trackChange);
              } catch { /* watcher optional */ }

              // Execute
              const taggedCommands = commands.map(c => ({ ...c, approvalStatus }));
              const results = await executeShellCommands(taggedCommands, workspacePath, { allowAllCommands, signal });
              state.shellResultsForHistory.push(...results);

              // Wait for file watcher
              await new Promise(resolve => setTimeout(resolve, 100));
              if (shellFileWatcher) {
                shellFileWatcher.dispose();
                if (modifiedFiles.size > 0) {
                  logger.info(`[R1-Shell] Interrupt: File watcher detected ${modifiedFiles.size} modified files: ${[...modifiedFiles].join(', ')}`);
                  this.diffManager.registerShellModifiedFiles([...modifiedFiles]);
                }
              }

              // Send results to frontend
              this._onShellResults.fire({
                results: results.map(r => ({
                  command: r.command,
                  output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
                  success: r.success
                }))
              });

              resultsContext = formatShellResultsForContext(results, {
                modifiedFiles: [...modifiedFiles],
                workspacePath
              });
              if (commandsCreateFiles(commands)) state.shellCreatedFiles = true;
              if (commandsDeleteFiles(commands)) state.shellDeletedFiles = true;
            } else {
              resultsContext = `Shell command rejected by user: ${commands[0].command}\n`;
            }

            // Inject partial response + result into context for resume
            const partialResponse = stripShellTags(state.currentIterationContent || '');
            if (partialResponse.trim()) {
              currentHistoryMessages.push({ role: 'assistant', content: partialResponse.trim() });
            }
            currentHistoryMessages.push({
              role: 'user',
              content: `[Shell output]\n${resultsContext}\n[Continue]\nThe command above was executed as you requested. Continue with your next step. Do not re-run commands that have already succeeded.`
            });

            const injectedTokens = this.deepSeekClient.estimateTokens(resultsContext);
            accumulatedIterationTokens += injectedTokens;
            logger.info(`[R1-Shell] Interrupt: injected ${injectedTokens} tokens (total: ${accumulatedIterationTokens.toLocaleString()}/${iterationBudget.toLocaleString()}), resuming with new API call`);

            if (accumulatedIterationTokens > iterationBudget) {
              logger.warn(`[R1-Budget] Budget exceeded after interrupt — next iteration will skip execution`);
              budgetExceeded = true;
            }

            // Reset iteration state
            state.currentIterationContent = '';
            state.currentIterationReasoning = '';
            iterationResponse = '';
            firstContentTokenTime = null;
            firstReasoningTokenTime = null;

            shellIteration++;
            lastIterationHadShellCommands = true;
            continue; // ← New API call
          }
          continue;
        }

        // Not a shell interrupt — re-throw for the outer catch
        throw streamError;
      }

      // Iteration boundary log — applies to every multi-iteration loop, not just R1.
      const iterationDuration = Math.round(performance.now() - iterationStartTime);
      logger.info(`[Timing] Iteration ${shellIteration + 1} complete in ${iterationDuration}ms`);
      logger.info(`[Iteration] Iteration ${shellIteration + 1} complete, response length: ${iterationResponse.length} chars`);
      logger.info(`[Iteration] Response preview: ${iterationResponse.substring(0, 300).replace(/\n/g, '\\n')}...`);

      // R1-only: save iteration reasoning/content for the per-iteration replay UI.
      if (isReasonerModel) {
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

      // Check for shell commands AND web search tags in THIS iteration's content response ONLY.
      // Reasoning content is excluded — R1's thinking often contains <shell> tags as part of
      // planning ("Let me check... <shell>pwd</shell>") which are NOT commands to execute.
      const combinedForShellCheck = iterationResponse;
      // Shell commands are handled by interrupt-and-resume (onShellDetected) during streaming.
      // The batch path is only needed for non-reasoner models (which don't use interrupt-and-resume).
      const hasShell = false; // Disabled: interrupt-and-resume catches shell tags during streaming
      const hasWebSearch = !budgetExceeded && isReasonerModel && this.webSearchManager.getMode() === 'auto' && containsWebSearchCommands(combinedForShellCheck);

      // Zero-content recovery: R1 sometimes reasons about shell commands but produces
      // no content output. Instead of guessing from reasoning, auto-continue so the model
      // can produce a proper response with commands in the content stream.
      if (isReasonerModel && !iterationResponse.trim() && state.currentIterationReasoning &&
          containsShellCommands(state.currentIterationReasoning) && zeroContentRetries < maxZeroContentRetries) {
        zeroContentRetries++;
        logger.info(`[R1-Shell] Zero-content response with shell commands in reasoning — auto-continuing (${zeroContentRetries}/${maxZeroContentRetries})`);

        this._onAutoContinuation.fire({
          count: zeroContentRetries,
          max: maxZeroContentRetries,
          reason: 'Zero-content response — reasoning contained shell commands'
        });

        currentHistoryMessages.push({
          role: 'assistant',
          content: state.currentIterationReasoning
        });

        currentHistoryMessages.push({
          role: 'user',
          content: `Your reasoning included shell commands but you didn't produce any output. Please provide your response — include any shell commands you want to run using <shell> tags in your response, not just in your thinking.`
        });

        lastIterationHadShellCommands = false;
        shellIteration++;
        continue;
      }

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
            // Default to 'auto' when the gate is bypassed (allowAllCommands or
            // no approval manager) — the executor's blocklist won't second-
            // guess commands that have already been auto-approved.
            let approvedCommands: ShellCommand[] = commands.map(c => ({ ...c, approvalStatus: 'auto' }));
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
                  approvedCommands.push({ ...cmd, approvalStatus: 'auto' });
                } else if (decision === 'blocked') {
                  logger.info(`[CommandApproval] BLOCKED: "${cmd.command}"`);
                  blockedResults.push({
                    command: cmd.command,
                    output: 'Command blocked by security rules.',
                    success: false,
                    executionTimeMs: 0,
                    approvalStatus: 'rule-blocked'
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
                    approvedCommands.push({ ...cmd, approvalStatus: 'user-allowed' });
                  } else {
                    logger.info(`[CommandApproval] DENIED${result.persistent ? ' (always)' : ''}: "${cmd.command}"`);
                    blockedResults.push({
                      command: cmd.command,
                      output: 'Command blocked by user.',
                      success: false,
                      executionTimeMs: 0,
                      approvalStatus: 'user-blocked'
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
            const shellStartTime = performance.now();
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
            const shellDuration = Math.round(performance.now() - shellStartTime);
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

            resultsContext += formatShellResultsForContext(results, {
              modifiedFiles: [...modifiedFiles],
              deletedFiles: [...deletedFiles],
              workspacePath
            });
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
          logger.warn(`[R1-Budget] Iteration budget exceeded (${accumulatedIterationTokens.toLocaleString()}/${iterationBudget.toLocaleString()} tokens) — soft-stop, one final iteration allowed`);
          this._onWarning.fire({
            message: `Context budget reached (${accumulatedIterationTokens.toLocaleString()} tokens). Completing with available information.`
          });
          budgetExceeded = true;
          // Don't break — fall through to inject results and let R1 do one final iteration.
          // The budgetExceeded flag will prevent further shell/web search execution on the next pass.
        }

        // Add to context and continue
        currentHistoryMessages.push({
          role: 'assistant',
          content: iterationResponse
        });

        currentHistoryMessages.push({
          role: 'user',
          content: `[Shell output]\n${resultsContext}\n[Continue]\nThe commands above were executed as you requested. Continue with your next step. If you have enough information, produce the code changes or answer. Do not re-run commands that have already succeeded.`
        });

        // Update system prompt for continuation
        currentSystemPrompt = streamingSystemPrompt + `\n\nThe ${hasShell ? 'shell commands' : 'web searches'} have been executed and results are provided.\nORIGINAL TASK: "${originalUserMessage}"\n\nYou MUST now complete this task:\n- If you need more information, run additional shell commands or web searches\n- If the task requires code changes, produce them using properly formatted code blocks with # File: headers\n- If the task is a question, provide a clear answer based on your findings\n- Do NOT end with just shell commands or analysis — finish the task`;
      } else {
        // No shell commands in this iteration
        if (isReasonerModel) {
          logger.info(`[R1-Shell] No shell commands in iteration, checking for auto-continuation...`);
          logger.info(`[R1-Shell] shellIteration=${shellIteration}, nudges=${nudgeContinuations}, zeroContent=${zeroContentRetries}, failedEdits=${failedEditRetries}, lastIterationHadShellCommands=${lastIterationHadShellCommands}, shellCreatedFiles=${state.shellCreatedFiles}, shellDeletedFiles=${state.shellDeletedFiles}`);

          // Scope to the current iteration only. Using state.accumulatedResponse
          // caused a stale-signal loop: once any earlier iteration produced
          // SEARCH/REPLACE blocks, every subsequent iteration (even pure
          // "Task complete" summaries) read hasCodeEdits=true and re-fired the
          // post-edit continuation. Per-iteration measures what we actually
          // care about: did this turn of the loop introduce new edits?
          const hasCodeEdits = containsCodeEdits(iterationResponse);
          const failedApplies = this.diffManager.getFailedAutoApplyCount();
          logger.info(`[R1-Shell] Response has code edits: ${hasCodeEdits}, failedApplies: ${failedApplies}`);

          // Code edits were produced but failed to apply — nudge to re-read or create
          if (hasCodeEdits && failedApplies > 0 && failedEditRetries < maxFailedEditRetries) {
            failedEditRetries++;
            this.diffManager.resetFailedAutoApplyCount();
            logger.info(`[R1-Shell] Auto-continuing (${failedEditRetries}/${maxFailedEditRetries}): code edits failed to apply (${failedApplies} failed)`);

            this._onAutoContinuation.fire({
              count: failedEditRetries,
              max: maxFailedEditRetries,
              reason: `${failedApplies} file edit(s) failed — re-reading file`
            });

            currentHistoryMessages.push({
              role: 'assistant',
              content: iterationResponse
            });

            currentHistoryMessages.push({
              role: 'user',
              content: `Your code edit failed to apply because the file content has changed since you last read it. Please re-read the file using a shell command (e.g., cat filename) to see its current content, then try the edit again with the correct SEARCH block.`
            });

            lastIterationHadShellCommands = false;
            continue;
          }

          if (shellIteration > 0 && !hasCodeEdits && nudgeContinuations < maxNudgeContinuations) {
            nudgeContinuations++;
            logger.info(`[R1-Shell] Auto-continuing (${nudgeContinuations}/${maxNudgeContinuations}): shell commands were executed but no code edits produced`);

            this._onAutoContinuation.fire({
              count: nudgeContinuations,
              max: maxNudgeContinuations,
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

          // C11: File edits produced — give the model a chance to continue working
          // (e.g., run install/build commands after writing files). Bounded by the
          // user-configurable "File Edit Loops" budget. If the model has nothing
          // more to do, the next iteration will exit naturally via zeroContent or nudge.
          if (hasCodeEdits && postEditContinuations < maxFileEditLoops) {
            postEditContinuations++;
            logger.info(`[R1-Shell] Auto-continuing (${postEditContinuations}/${maxFileEditLoops === Infinity ? '∞' : maxFileEditLoops}): file edits produced, allowing follow-up work`);

            this._onAutoContinuation.fire({
              count: postEditContinuations,
              max: maxFileEditLoops === Infinity ? maxNudgeContinuations : maxFileEditLoops,
              reason: 'File edits produced, allowing follow-up work'
            });

            currentHistoryMessages.push({
              role: 'assistant',
              content: iterationResponse
            });

            currentHistoryMessages.push({
              role: 'user',
              content: `Continue if there is more work to do (e.g., running install/build commands, creating additional files, verifying the result). Otherwise, briefly confirm completion.`
            });

            lastIterationHadShellCommands = false;
            continue;
          }

          logger.info(`[R1-Shell] Loop exiting: iteration=${shellIteration}, hasCodeEdits=${hasCodeEdits}, nudges=${nudgeContinuations}/${maxNudgeContinuations}, zeroContent=${zeroContentRetries}/${maxZeroContentRetries}, failedEdits=${failedEditRetries}/${maxFailedEditRetries}, postEdit=${postEditContinuations}/${maxFileEditLoops === Infinity ? '∞' : maxFileEditLoops}`);
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

        // ADR 0003 Phase 3: the webview no longer returns consolidated turn
        // events. Structural events were written live from the extension side.
        // file-modified status patching (previously step 5b) is also gone —
        // Phase 2.5 live emission already carries the resolved status.

        // Record the assistant message as the final authoritative row for this turn.
        await this.conversationManager.recordAssistantMessage(
          sessionId, cleanResponse, model, 'stop', undefined, undefined, undefined,
          { status: 'complete', turnId: this._currentTurnId ?? undefined }
        );
        logger.info(`[HistorySave] sessionId=${sessionId!.substring(0, 8)} Recorded assistant message (${cleanResponse.length} chars, model=${model})`);

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

  // ── Private: Tool Dispatch ──

  /**
   * Execute a single tool call and return the model-facing result string,
   * plus signals for the caller's batch lifecycle. Phase 4.5 — extracted from
   * `runToolLoop`'s inline dispatch so the upcoming streaming-tool-calls loop
   * can call the same code without duplicating ~370 lines of branching.
   *
   * Per-tool behavior:
   *   - `web_search`  — routed through `WebSearchManager.searchByQuery`.
   *   - `read`        — tracked via `FileContextManager.trackReadFile`.
   *   - `edit_file`   — synthesizes SEARCH/REPLACE blocks, then routes to
   *                     `DiffManager` per current edit mode (ask waits for
   *                     approval, auto applies directly, manual opens diff).
   *   - `write_file`  — same mode triage, calls `createFileCapability` in auto.
   *   - `run_shell`   — full R1-parity pipeline: `parseShellCommands`,
   *                     long-running guard, `CommandApprovalManager`, file
   *                     watcher with absolute-path ground truth (ADR 0004).
   *   - `delete_file` / `delete_directory` — register pending deletion in
   *                     ask/manual, direct capability call in auto.
   *   - everything else (read-only ops) — passed through to
   *                     `executeToolCall` from `workspaceTools.ts`.
   *
   * Return shape:
   *   - `result`      — content for the `tool` role message in the next
   *                     request. May be an error string starting with
   *                     "Error:" — caller treats that as a failed call.
   *   - `fileModified` — this call modified files; caller folds this into
   *                     its `fileModifiedInBatch` accumulator and emits
   *                     `diffManager.emitAutoAppliedChanges()` once the
   *                     batch closes.
   *   - `closesBatch` — ask-mode approval closed the tool batch. Caller
   *                     should fire `_onToolCallsEnd` and reset its local
   *                     batch state. (We don't fire it here because the
   *                     batch state — `toolContainerStarted`,
   *                     `batchToolDetails` — lives in the caller's loop.)
   */
  private async dispatchToolCall(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<{ result: string; fileModified: boolean; closesBatch: boolean }> {
    let fileModified = false;
    let closesBatch = false;

    // ── Initial result: web_search routes through WebSearchManager,
    // everything else flows through workspaceTools.executeToolCall.
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

    if (!success) {
      return { result, fileModified, closesBatch };
    }

    // ── Per-tool special handling. Each branch may overwrite `result` with
    // the actual outcome (ask-mode approval text, auto-apply success/failure,
    // shell stdout/stderr, etc.) and toggle the lifecycle flags.

    if (toolCall.function.name === 'read') {
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

    if (toolCall.function.name === 'edit_file') {
      try {
        logger.info(`[RequestOrchestrator] edit_file tool called - args: ${toolCall.function.arguments}`);
        const args = JSON.parse(toolCall.function.arguments);
        logger.info(`[RequestOrchestrator] Parsed edit_file args: ${JSON.stringify(args)}`);
        if (args.file) {
          this.fileContextManager.trackReadFile(args.file);

          // Build SEARCH/REPLACE block string from the structured `edits`
          // array. The DiffEngine downstream still parses this format, so
          // synthesizing it here keeps that infrastructure unchanged
          // while the model-facing schema is structured (no free-form
          // code that the engine had to guess about).
          const editsArray = Array.isArray(args.edits) ? args.edits as Array<{ search?: string; replace?: string }> : null;
          const code = editsArray
            ? editsArray.map(e =>
                `<<<<<<< SEARCH\n${e.search ?? ''}\n=======\n${e.replace ?? ''}\n>>>>>>> REPLACE`
              ).join('\n\n')
            : '';

          if (!editsArray || editsArray.length === 0) {
            result = `edit_file failed for ${args.file}: missing or empty 'edits' array. Resend the call with at least one {search, replace} pair, or use write_file for a full-file rewrite.`;
          } else if (code) {
            if (this.diffManager.currentEditMode === 'ask') {
              logger.info(`[RequestOrchestrator] Triggering blocking diff for edit_file in ask mode`);
              const codeWithHeader = `# File: ${args.file}\n${code}`;
              const language = args.language || 'plaintext';
              await this.diffManager.handleAskModeDiff(codeWithHeader, language);

              // Wait for user approval before continuing tool loop
              const approvalResults = await this.diffManager.waitForPendingApprovals();
              if (approvalResults.length > 0) {
                const r = approvalResults[0];
                if (r.approved) {
                  const wsFolder = vscode.workspace.workspaceFolders?.[0];
                  const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.file).fsPath : undefined;
                  result = `Code edit applied to ${args.file}. User accepted the changes.` +
                    (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.file, action: 'modified' }]) : '');
                } else {
                  result = `Code edit rejected for ${args.file}. User rejected the changes. Please try a different approach.`;
                }
              }
              closesBatch = true;
            } else if (this.diffManager.currentEditMode === 'auto') {
              logger.info(`[RequestOrchestrator] Auto-applying code edit for: ${args.file}`);
              const applied = await this.diffManager.applyCodeDirectlyForAutoMode(args.file, code, args.description, true);
              if (applied) {
                fileModified = true;
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.file).fsPath : undefined;
                result = `Code edit applied to ${args.file}.` +
                  (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.file, action: 'modified' }]) : '');
              } else {
                // Auto-apply failed — either stale content or the search
                // text didn't match the current file. The model needs
                // both signals: re-read, and double-check the search
                // text matches verbatim.
                result = `edit_file failed for ${args.file}: one or more SEARCH snippets did not match the current file (the file may have changed since you last read it, or the SEARCH text is not verbatim). Re-read the file, then resend with SEARCH text that quotes the current contents exactly.`;
              }
            } else if (this.diffManager.currentEditMode === 'manual') {
              logger.info(`[RequestOrchestrator] Opening diff for manual review: ${args.file}`);
              const codeWithHeader = `# File: ${args.file}\n${code}`;
              const language = args.language || 'plaintext';
              await this.diffManager.showDiff(codeWithHeader, language);
            }
          }
        } else {
          logger.warn(`[RequestOrchestrator] edit_file called but no file in args`);
        }
      } catch (e) {
        logger.error(`[RequestOrchestrator] Failed to parse edit_file arguments: ${e}`);
      }
    }

    if (toolCall.function.name === 'write_file') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        if (!args.path || typeof args.content !== 'string') {
          result = `Error: write_file requires "path" and "content" arguments`;
        } else {
          const editMode = this.diffManager.currentEditMode;
          if (editMode === 'ask' || editMode === 'manual') {
            logger.info(`[RequestOrchestrator] write_file (${editMode}) — routing through diff approval for ${args.path}`);
            const codeWithHeader = `# File: ${args.path}\n${args.content}`;
            const language = args.language || 'plaintext';
            if (editMode === 'ask') {
              await this.diffManager.handleAskModeDiff(codeWithHeader, language);
              const approvalResults = await this.diffManager.waitForPendingApprovals();
              const approved = approvalResults[0]?.approved ?? false;
              if (approved) {
                this.fileContextManager.trackReadFile(args.path);
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.path).fsPath : undefined;
                result = `Created file ${args.path}. User accepted the changes.` +
                  (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.path, action: 'created' }]) : '');
              } else {
                result = `Create file rejected for ${args.path}. User rejected the creation.`;
              }
              closesBatch = true;
            } else {
              // manual — open diff, no blocking approval
              await this.diffManager.showDiff(codeWithHeader, language);
              result = `Opened diff for ${args.path}. User will apply manually.`;
            }
          } else {
            // auto mode — call capability directly
            const capResult = await createFileCapability(args.path, args.content);
            if (capResult.status === 'success') {
              this.fileContextManager.trackReadFile(args.path);
              this.diffManager.registerToolCreatedFile(args.path, args.description || 'Created by write_file');
              fileModified = true;
              result = `Created file ${args.path}.` + formatFilesAffected(capResult.filesAffected);
            } else {
              result = `Error: ${capResult.error}`;
            }
          }
        }
      } catch (e: any) {
        logger.error(`[RequestOrchestrator] Failed to handle write_file: ${e.message ?? e}`);
        result = `Error: Failed to process write_file — ${e.message ?? e}`;
      }
    }

    if (toolCall.function.name === 'run_shell') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const commandStr = typeof args.command === 'string' ? args.command : '';
        if (!commandStr.trim()) {
          result = `Error: run_shell requires a non-empty "command" argument.`;
        } else {
          // Reuse the same parser the <shell> path uses — keeps long-running
          // rejection, heredoc handling, and ShellCommand shape consistent.
          const parsed = parseShellCommands(`<shell>${commandStr}</shell>`);
          if (parsed.length === 0) {
            result = `Error: run_shell could not parse the command "${commandStr.substring(0, 80)}".`;
          } else if (isLongRunningCommand(parsed[0].command)) {
            // Same policy as R1's path: refuse rather than execute and hang.
            result = `Skipped long-running command "${parsed[0].command}". This command starts a server, watch mode, or REPL that wouldn't return on its own. Ask the user to run it manually.`;
            this._onShellExecuting.fire({ commands: [{ command: parsed[0].command, description: 'Skipped (long-running)' }] });
            this._onShellResults.fire({ results: [{ command: parsed[0].command, output: result, success: true }] });
          } else {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const workspacePath = workspaceFolder?.uri.fsPath ?? process.cwd();

            // Approval flow — identical decision tree to the R1 inline path.
            const allowAllCommands = vscode.workspace.getConfiguration('moby').get<boolean>('allowAllShellCommands') ?? false;
            let approvedCommand: ShellCommand | null = null;
            let blockedResult: ShellResult | null = null;

            if (allowAllCommands || !this.commandApprovalManager) {
              approvedCommand = { ...parsed[0], approvalStatus: 'auto' };
            } else {
              const decision = this.commandApprovalManager.checkCommand(parsed[0].command);
              if (decision === 'allowed') {
                approvedCommand = { ...parsed[0], approvalStatus: 'auto' };
              } else {
                const userApproval = await this.commandApprovalManager.requestApproval(parsed[0].command);
                if (userApproval.decision === 'allowed') {
                  approvedCommand = { ...parsed[0], approvalStatus: 'user-allowed' };
                } else {
                  blockedResult = {
                    command: parsed[0].command,
                    output: `Command rejected by user: ${parsed[0].command}`,
                    success: false,
                    executionTimeMs: 0,
                    approvalStatus: 'user-blocked'
                  };
                }
              }
            }

            // Notify the frontend before execution so the shell dropdown
            // appears with the running command.
            const preview = parsed[0].command.length > 50
              ? parsed[0].command.substring(0, 50) + '...'
              : parsed[0].command;
            this._onShellExecuting.fire({ commands: [{ command: parsed[0].command, description: preview }] });

            // File watcher — captures modified/deleted paths so the tool
            // result can list absolute paths (ADR 0004).
            const modifiedFiles = new Set<string>();
            const deletedFiles = new Set<string>();
            let shellFileWatcher: vscode.FileSystemWatcher | null = null;
            try {
              shellFileWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(workspacePath, '**/*')
              );
              const trackChange = (uri: vscode.Uri) => {
                const rel = vscode.workspace.asRelativePath(uri, false);
                if (!shouldIgnoreWatcherPath(rel)) modifiedFiles.add(rel);
              };
              shellFileWatcher.onDidChange(trackChange);
              shellFileWatcher.onDidCreate(trackChange);
              shellFileWatcher.onDidDelete((uri: vscode.Uri) => {
                const rel = vscode.workspace.asRelativePath(uri, false);
                if (!shouldIgnoreWatcherPath(rel)) {
                  deletedFiles.add(rel);
                  modifiedFiles.delete(rel);
                }
              });
            } catch {
              shellFileWatcher = null;
            }

            let executedResults: ShellResult[] = [];
            if (approvedCommand) {
              executedResults = await executeShellCommands([approvedCommand], workspacePath, { allowAllCommands, signal });
            }

            // Drain watcher events that arrived during execution.
            if (shellFileWatcher) {
              await new Promise(resolve => setTimeout(resolve, 100));
              shellFileWatcher.dispose();
              if (modifiedFiles.size > 0) {
                this.diffManager.registerShellModifiedFiles([...modifiedFiles]);
              }
              if (deletedFiles.size > 0) {
                this.diffManager.registerShellDeletedFiles([...deletedFiles]);
              }
            }

            const allResults = blockedResult ? [blockedResult, ...executedResults] : executedResults;

            this._onShellResults.fire({
              results: allResults.map(r => ({
                command: r.command,
                output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
                success: r.success
              }))
            });

            // Format with absolute-path ground truth so the model sees
            // the same shape as R1's <shell> results.
            result = formatShellResultsForContext(allResults, {
              modifiedFiles: [...modifiedFiles],
              deletedFiles: [...deletedFiles],
              workspacePath,
            });
            if (modifiedFiles.size > 0 || deletedFiles.size > 0) {
              fileModified = true;
            }
          }
        }
      } catch (e: any) {
        logger.error(`[RequestOrchestrator] run_shell failed: ${e.message ?? e}`);
        result = `Error: run_shell failed — ${e.message ?? e}`;
      }
    }

    if (toolCall.function.name === 'delete_file') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        if (!args.path) {
          result = `Error: delete_file requires a "path" argument`;
        } else {
          const editMode = this.diffManager.currentEditMode;
          if (editMode === 'ask' || editMode === 'manual') {
            const diffId = this.diffManager.registerPendingDeletion(args.path);
            const approvalResults = await this.diffManager.waitForPendingApprovals();
            const approved = approvalResults.find(r => r.diffId === diffId)?.approved ?? false;
            if (approved) {
              fileModified = true;
              const wsFolder = vscode.workspace.workspaceFolders?.[0];
              const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.path).fsPath : undefined;
              result = `Deleted file ${args.path}. User accepted the deletion.` +
                (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.path, action: 'deleted' }]) : '');
            } else {
              result = `Delete file rejected for ${args.path}. User declined the deletion.`;
            }
            closesBatch = true;
          } else {
            // auto mode — direct capability call
            const capResult = await deleteFileCapability(args.path);
            if (capResult.status === 'success') {
              this.diffManager.registerToolDeletedFile(args.path);
              fileModified = true;
              result = `Deleted file ${args.path}.` + formatFilesAffected(capResult.filesAffected);
            } else {
              result = `Error: ${capResult.error}`;
            }
          }
        }
      } catch (e: any) {
        logger.error(`[RequestOrchestrator] Failed to handle delete_file: ${e.message ?? e}`);
        result = `Error: Failed to process delete_file — ${e.message ?? e}`;
      }
    }

    if (toolCall.function.name === 'delete_directory') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        if (!args.path) {
          result = `Error: delete_directory requires a "path" argument`;
        } else {
          const recursive = args.recursive === 'true';
          const editMode = this.diffManager.currentEditMode;
          if (editMode === 'ask' || editMode === 'manual') {
            const diffId = this.diffManager.registerPendingDirectoryDeletion(args.path, recursive);
            const approvalResults = await this.diffManager.waitForPendingApprovals();
            const approvalOutcome = approvalResults.find(r => r.diffId === diffId);
            const approved = approvalOutcome?.approved ?? false;
            if (approved) {
              fileModified = true;
              const wsFolder = vscode.workspace.workspaceFolders?.[0];
              const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.path).fsPath : undefined;
              result = `Deleted directory ${args.path}${recursive ? ' (recursive)' : ''}. User accepted the deletion.` +
                (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.path, action: 'deleted' }]) : '');
            } else {
              // Distinguish user reject vs capability failure so the model
              // gets a useful error (e.g. "directory not empty, try recursive=true").
              result = `Delete directory rejected for ${args.path}. User declined the deletion (or the directory was not empty and recursive=false).`;
            }
            closesBatch = true;
          } else {
            // auto mode — direct capability call via DiffManager wrapper
            // so the Modified Files dropdown updates on success.
            const outcome = await this.diffManager.deleteDirectoryDirect(args.path, recursive);
            if (outcome.status === 'applied') {
              fileModified = true;
              const wsFolder = vscode.workspace.workspaceFolders?.[0];
              const absPath = wsFolder ? vscode.Uri.joinPath(wsFolder.uri, args.path).fsPath : undefined;
              result = `Deleted directory ${args.path}${recursive ? ' (recursive)' : ''}.` +
                (absPath ? formatFilesAffected([{ absolutePath: absPath, relativePath: args.path, action: 'deleted' }]) : '');
            } else {
              // Surface the capability-level error (e.g. "not empty").
              result = `Error: Failed to delete directory ${args.path}. ${recursive ? '' : 'Set recursive="true" if the directory is not empty.'}`;
            }
          }
        }
      } catch (e: any) {
        logger.error(`[RequestOrchestrator] Failed to handle delete_directory: ${e.message ?? e}`);
        result = `Error: Failed to process delete_directory — ${e.message ?? e}`;
      }
    }

    return { result, fileModified, closesBatch };
  }

  // ── Private: Streaming Tool-Calls Loop (Phase 4.5) ──

  /**
   * Unified streaming pipeline for native-tool models with
   * `streamingToolCalls: true`. Replaces the today's `runToolLoop`
   * (non-streaming probe) + `streamAndIterate` (no-tools final summary)
   * split with a single streamed loop:
   *
   *   while (more turns):
   *     stream content + reasoning + tool_calls deltas in parallel
   *     if finish_reason === 'tool_calls':
   *       dispatch each tool, append tool messages, continue
   *     else (finish_reason === 'stop'):
   *       break
   *
   * Why this exists: today V4-thinking does most of its reasoning inside
   * the non-streaming `chat()` calls in `runToolLoop`. The reasoning
   * arrives fully formed but we never feed it to the UI's
   * `_onStreamReasoning` channel, so users see no thinking text on tool
   * turns. Streaming the tool-decision phase fixes that and also removes
   * the duplicate-generation cost on no-tool turns (today: a full reply
   * is generated twice — once non-streaming with tools attached, then
   * again streamed without tools).
   *
   * Mutates `state` in place with the same fields `streamAndIterate` does
   * so `handleMessage`'s post-processing (cleanResponse, onEndResponse,
   * saveToHistory) is identical regardless of which loop ran.
   */
  private async runStreamingToolCallsLoop(
    contextMessages: ApiMessage[],
    systemPrompt: string,
    signal: AbortSignal,
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
    },
    contextBudgetTokens: number,
  ): Promise<{ allToolDetails: Array<{ name: string; detail: string; status: string }>; limitReached: boolean; budgetExceeded: boolean }> {
    const config = vscode.workspace.getConfiguration('moby');
    const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
    const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
    let iterations = 0;

    const budgetLimit = contextBudgetTokens;
    let accumulatedTokens = 0;
    let budgetExceeded = false;

    const allToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    let batchToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    let toolContainerStarted = false;
    let globalToolIndex = 0;
    let fileModifiedInBatch = false;

    // Working messages — start from the caller's context, append assistant +
    // tool turns as we iterate. The caller's `contextMessages` is not mutated.
    const currentMessages: ApiMessage[] = [...contextMessages];

    while (iterations < maxIterations) {
      iterations++;

      if (signal.aborted) break;

      // Soft-stop on context budget pressure (parity with runToolLoop).
      if (budgetLimit > 0) {
        const baseTokens = this.deepSeekClient.estimateTokens(JSON.stringify(currentMessages));
        if (baseTokens + accumulatedTokens > budgetLimit * 0.95) {
          logger.warn(
            `[StreamingToolCalls] Loop stopped: approaching budget ` +
            `(${(baseTokens + accumulatedTokens).toLocaleString()}/${budgetLimit.toLocaleString()} tokens, ` +
            `${iterations - 1} iterations completed)`
          );
          budgetExceeded = true;
          break;
        }
      }

      // Build tools array — same composition as runToolLoop.
      const wsState = await this.webSearchManager.getSettings();
      const includeWebSearch = wsState.mode === 'auto' && wsState.configured;
      const includeRunShell = getCapabilities(this.deepSeekClient.getModel()).shellProtocol === 'native-tool';
      const tools = [
        ...workspaceTools,
        applyCodeEditTool,
        createFileTool,
        deleteFileTool,
        deleteDirectoryTool,
        ...(includeRunShell ? [runShellTool] : []),
        ...(includeWebSearch ? [webSearchTool] : [])
      ];

      logger.info(`[StreamingToolCalls] Iteration ${iterations}, messages=${currentMessages.length}, tools=${tools.length}`);

      // Emit per-iteration tracer event (parity with streamAndIterate).
      this._onIterationStart.fire({ iteration: iterations });

      const iterStartTime = performance.now();
      let firstReasoningTime: number | null = null;
      let firstContentTime: number | null = null;

      // Reset per-iteration accumulators on the shared state object.
      state.currentIterationContent = '';
      state.currentIterationReasoning = '';

      // Mark the batch position at the start of this iteration so we can
      // tell which tools were pre-announced via the streaming callback
      // (between this point and the post-stream enrichment).
      const iterationStartBatchSize = batchToolDetails.length;

      // ── The stream ────────────────────────────────────────────────────
      // streamChat fires onToken/onReasoning live (this is the whole point
      // of Phase 4.5 — V4-thinking's reasoning surfaces during the tool-
      // decision phase, not after) and accumulates `delta.tool_calls` into
      // `response.tool_calls`. Returns when the API emits [DONE] or the
      // stream ends naturally with `finish_reason: 'stop' | 'tool_calls'`.
      //
      // `onToolCallStreaming` fires the moment a new tool's metadata
      // (id + name) arrives in the stream, well before its argument deltas
      // finish accumulating. We push a placeholder with name-only detail
      // and fire the batch-start (or update) event so the UI shows
      // "preparing write_file" instead of a silent gap. Args fill in once
      // the stream resolves.
      const response = await this.deepSeekClient.streamChat(
        currentMessages,
        (token) => {
          if (firstContentTime === null) {
            firstContentTime = performance.now();
            const wait = Math.round(firstContentTime - iterStartTime);
            logger.info(`[StreamingToolCalls] First content token after ${wait}ms (iter ${iterations})`);
          }
          state.accumulatedResponse += token;
          state.fullResponse += token;
          state.currentIterationContent += token;
          this._onStreamToken.fire({ token });
          // Live code-block detection (used by ask/auto edit modes).
          this.diffManager.handleCodeBlockDetection(state.accumulatedResponse);
        },
        systemPrompt,
        (reasoningToken) => {
          if (firstReasoningTime === null) {
            firstReasoningTime = performance.now();
            const wait = Math.round(firstReasoningTime - iterStartTime);
            logger.info(`[StreamingToolCalls] First reasoning token after ${wait}ms (iter ${iterations})`);
          }
          state.fullReasoning += reasoningToken;
          state.currentIterationReasoning += reasoningToken;
          this._onStreamReasoning.fire({ token: reasoningToken });
        },
        {
          tools,
          signal,
          onToolCallStreaming: (toolCall) => {
            const name = toolCall.function.name;
            logger.info(`[StreamingToolCalls] Pre-announce tool: ${name} (id=${toolCall.id}) — args still streaming`);
            const placeholder = { name, detail: name, status: 'pending' as const };
            batchToolDetails.push(placeholder);
            allToolDetails.push(placeholder);
            // Deep-clone the snapshot — handlers that capture this list
            // would otherwise see post-mutation state once we enrich
            // detail strings after the stream resolves.
            const snapshot = batchToolDetails.map(t => ({ ...t }));
            if (!toolContainerStarted) {
              this._onToolCallsStart.fire({ tools: snapshot });
              toolContainerStarted = true;
            } else {
              this._onToolCallsUpdate.fire({ tools: snapshot });
            }
          },
        }
      );

      // Per-iteration history (used by the chat replay UI).
      if (state.currentIterationReasoning) {
        state.reasoningIterations.push(state.currentIterationReasoning);
      }
      if (state.currentIterationContent) {
        state.contentIterations.push(state.currentIterationContent);
      }

      const toolCalls = response.tool_calls ?? [];

      // Terminal turn — model produced its final answer. Loop ends.
      if (response.finish_reason !== 'tool_calls' || toolCalls.length === 0) {
        logger.info(`[StreamingToolCalls] Iteration ${iterations} terminal (finish_reason=${response.finish_reason ?? 'unknown'}, tool_calls=${toolCalls.length})`);
        break;
      }

      logger.info(`[StreamingToolCalls] Iteration ${iterations} produced ${toolCalls.length} tool call(s)`);

      // Build enriched detail strings now that argument deltas have fully
      // accumulated (during streaming we only had the tool name).
      const enrichedDetails = toolCalls.map(tc => {
        const name = tc.function.name;
        let args: Record<string, string> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
        let detail = name;
        if (name === 'read_file' && args.path) detail = `read: ${args.path}`;
        else if (name === 'find_files' && args.pattern) detail = `find: ${args.pattern}`;
        else if (name === 'grep' && args.query) detail = `grep: "${args.query}"`;
        else if (name === 'list_directory') detail = `list: ${args.path || '.'}`;
        else if (name === 'file_metadata' && args.path) detail = `metadata: ${args.path}`;
        else if (name === 'web_search' && args.query) detail = `search web: "${args.query}"`;
        else if (name === 'edit_file' && args.file) detail = `edit: ${args.file}`;
        else if (name === 'write_file' && args.path) detail = `write: ${args.path}`;
        else if (name === 'delete_file' && args.path) detail = `delete: ${args.path}`;
        else if (name === 'delete_directory' && args.path) detail = `delete: ${args.path}${args.recursive === 'true' ? ' (recursive)' : ''}`;
        else if (name === 'run_shell' && args.command) detail = `run: ${args.command.length > 50 ? args.command.substring(0, 50) + '...' : args.command}`;
        return { name, detail };
      });

      // Reconcile pre-announced placeholders (from `onToolCallStreaming`) with
      // the resolved tool list. Common case: streaming announced one
      // placeholder per tool — we just enrich detail strings in place.
      // Defensive fallback: if streaming missed any (shouldn't happen for
      // streamingToolCalls models, but the API contract doesn't guarantee
      // delta order), push the missing ones now.
      const preAnnouncedCount = batchToolDetails.length - iterationStartBatchSize;
      if (preAnnouncedCount < toolCalls.length) {
        for (let i = preAnnouncedCount; i < toolCalls.length; i++) {
          const tool = { ...enrichedDetails[i], status: 'pending' as const };
          batchToolDetails.push(tool);
          allToolDetails.push(tool);
        }
      }
      // Enrich placeholder details for all tools added this iteration.
      for (let i = 0; i < toolCalls.length; i++) {
        const batchPos = iterationStartBatchSize + i;
        const globalPos = allToolDetails.length - toolCalls.length + i;
        batchToolDetails[batchPos].detail = enrichedDetails[i].detail;
        allToolDetails[globalPos].detail = enrichedDetails[i].detail;
      }
      // Fire batch event with enriched details. Streaming callback fired
      // start (or update) earlier with name-only details; this update
      // surfaces the now-known specifics (paths, queries, etc.). Deep-
      // clone so subsequent status mutations (running → done) don't leak
      // backwards into the captured event payload.
      const enrichedSnapshot = batchToolDetails.map(t => ({ ...t }));
      if (!toolContainerStarted) {
        // No streaming pre-announce happened (streaming callback never
        // fired). Fall back to the legacy "fire start at end" pattern.
        logger.info(`[StreamingToolCalls] Starting tool container with ${batchToolDetails.length} tool(s) (no streaming pre-announce)`);
        this._onToolCallsStart.fire({ tools: enrichedSnapshot });
        toolContainerStarted = true;
      } else {
        this._onToolCallsUpdate.fire({ tools: enrichedSnapshot });
      }

      // Append assistant turn. `reasoning_content` rides along when V4-
      // thinking is active so the next request includes it (the wire-format
      // serializer in DeepSeekClient gates outbound inclusion on the active
      // model's `reasoningEcho === 'required'`).
      currentMessages.push({
        role: 'assistant',
        content: response.content || '',
        reasoning_content: response.reasoning_content,
        tool_calls: toolCalls,
      });

      if (budgetLimit > 0) {
        const assistantText = (response.content || '') + JSON.stringify(toolCalls);
        accumulatedTokens += this.deepSeekClient.estimateTokens(assistantText);
      }

      const batchStartIndex = iterationStartBatchSize;

      // Dispatch each tool call via the shared helper. Same UI status
      // lifecycle as runToolLoop: pending → running → done/error.
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const detail = enrichedDetails[i];
        const globalIndex = globalToolIndex + i;
        const batchIndex = batchStartIndex + i;

        logger.toolCall(toolCall.function.name);

        batchToolDetails[batchIndex].status = 'running';
        allToolDetails[globalIndex].status = 'running';
        this._onToolCallUpdate.fire({ index: batchIndex, status: 'running', detail: detail.detail });

        const dispatch = await this.dispatchToolCall(toolCall, signal);
        const result = dispatch.result;
        const success = !result.startsWith('Error:');

        if (dispatch.fileModified) fileModifiedInBatch = true;
        if (dispatch.closesBatch && toolContainerStarted) {
          this._onToolCallsEnd.fire();
          toolContainerStarted = false;
          batchToolDetails = [];
        }

        currentMessages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });

        if (budgetLimit > 0) {
          accumulatedTokens += this.deepSeekClient.estimateTokens(result);
        }

        const finalStatus = success ? 'done' : 'error';
        allToolDetails[globalIndex].status = finalStatus;
        if (batchIndex < batchToolDetails.length) {
          batchToolDetails[batchIndex].status = finalStatus;
          this._onToolCallUpdate.fire({ index: batchIndex, status: finalStatus, detail: detail.detail });
        }
      }

      globalToolIndex += toolCalls.length;

      if (fileModifiedInBatch) {
        this.diffManager.emitAutoAppliedChanges();
        fileModifiedInBatch = false;
      }

      // Close the tool batch at the iteration boundary. Each streamChat
      // call is one "decision point" — its tool calls (one or many parallel)
      // belong in one dropdown; the next iteration's calls are a separate
      // decision and should render as their own dropdown. Mirrors what
      // `MessageTurnActor.startThinkingIteration` does for Modified Files
      // (it nulls `_currentPendingGroup` so the next file modification
      // opens a fresh group). Without this close, V4-thinking turns that
      // run 10+ iterations all collapse into one giant "Used 11 tools"
      // dropdown, hiding the thinking that happened between each decision.
      if (toolContainerStarted) {
        logger.info(`[StreamingToolCalls] Closing tool batch at iteration ${iterations} boundary (${batchToolDetails.length} tool(s))`);
        this._onToolCallsEnd.fire();
        toolContainerStarted = false;
        batchToolDetails = [];
      }
    }

    // Defensive — if the loop exited mid-batch (e.g. abort during dispatch),
    // close it now. Normal exit already closed at the iteration boundary.
    if (toolContainerStarted) {
      this._onToolCallsEnd.fire();
    }

    const limitReached = iterations >= maxIterations && maxIterations !== Infinity;
    return { allToolDetails, limitReached, budgetExceeded };
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

      // Build tools array. `web_search` is included when mode='auto' and a
      // provider is configured. `run_shell` is included for native-tool-
      // calling models that have `shellProtocol: 'native-tool'` (V3 chat,
      // V4 family, custom natives). R1 stays on the `<shell>` XML transport
      // — its `shellProtocol: 'xml-shell'` keeps the schema out of the
      // tools array and the existing parser owns its dispatch.
      const toolLoopWsState = await this.webSearchManager.getSettings();
      const includeWebSearch = toolLoopWsState.mode === 'auto' && toolLoopWsState.configured;
      const includeRunShell = getCapabilities(this.deepSeekClient.getModel()).shellProtocol === 'native-tool';
      const tools = [
        ...workspaceTools,
        applyCodeEditTool,
        createFileTool,
        deleteFileTool,
        deleteDirectoryTool,
        ...(includeRunShell ? [runShellTool] : []),
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
        } else if (name === 'find_files' && args.pattern) {
          detail = `find: ${args.pattern}`;
        } else if (name === 'grep' && args.query) {
          detail = `grep: "${args.query}"`;
        } else if (name === 'list_directory') {
          detail = `list: ${args.path || '.'}`;
        } else if (name === 'file_metadata' && args.path) {
          detail = `metadata: ${args.path}`;
        } else if (name === 'web_search' && args.query) {
          detail = `search web: "${args.query}"`;
        } else if (name === 'edit_file' && args.file) {
          detail = `edit: ${args.file}`;
        } else if (name === 'write_file' && args.path) {
          detail = `write: ${args.path}`;
        } else if (name === 'delete_file' && args.path) {
          detail = `delete: ${args.path}`;
        } else if (name === 'delete_directory' && args.path) {
          detail = `delete: ${args.path}${args.recursive === 'true' ? ' (recursive)' : ''}`;
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

      // Add assistant message with tool calls (required for API contract).
      // Preserve `reasoning_content` when the model returned it — V4-thinking
      // requires it be echoed back on every subsequent request that includes
      // this assistant turn, otherwise the API 400s with
      //   "The `reasoning_content` in the thinking mode must be passed back"
      // The wire-format serializer in DeepSeekClient gates the actual outbound
      // inclusion on the ACTIVE model's `reasoningEcho === 'required'` so we
      // don't leak the field to non-thinking models mid-session.
      const assistantMsg: ApiMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      };
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content;
      }
      toolMessages.push(assistantMsg);

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

        // Phase 4.5 — dispatch the tool call. Helper handles all per-tool
        // branches (web_search, read tracking, edit_file, write_file,
        // run_shell, delete_file, delete_directory) and returns the
        // model-facing result plus lifecycle flags. Caller still owns the
        // tool-batch UI lifecycle (running→done status, container open/close)
        // because that state is loop-local.
        const dispatch = await this.dispatchToolCall(toolCall, signal);
        const result = dispatch.result;
        const success = !result.startsWith('Error:');
        if (dispatch.fileModified) {
          fileModifiedInBatch = true;
        }
        if (dispatch.closesBatch && toolContainerStarted) {
          this._onToolCallsEnd.fire();
          toolContainerStarted = false;
          logger.info(`[Frontend] Sent toolCallsEnd (ask mode approval, closing batch after iteration ${iterations})`);
          batchToolDetails = [];
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

      // If a file was modified in this iteration, emit auto-applied changes
      // so the Modified Files UI updates — but keep the batch open. Consecutive
      // tool calls with no streamed text between them should render as one
      // dropdown rather than fragmenting into "Used 1 tool" rows per file.
      if (fileModifiedInBatch) {
        this.diffManager.emitAutoAppliedChanges();
        fileModifiedInBatch = false;
      }

      // Close the tool batch at the iteration boundary. Mirrors
      // runStreamingToolCallsLoop — each non-streaming chat() call is one
      // "decision point" whose tools belong in one dropdown. Without this close,
      // every iteration collapses into one giant "Used N tools" batch.
      if (toolContainerStarted) {
        logger.info(`[ToolLoop] Closing tool batch at iteration ${iterations} boundary (${batchToolDetails.length} tool(s))`);
        this._onToolCallsEnd.fire();
        toolContainerStarted = false;
        batchToolDetails = [];
      }
    }

    // Defensive — if the loop exited mid-batch (e.g. abort during dispatch),
    // close it now. Normal exit already closed at the iteration boundary.
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

// ──────────────────────────────────────────────────────────────────────
// System Prompt Sections (Phase 3.5 infrastructure)
// ──────────────────────────────────────────────────────────────────────
//
// Two functions, one per section that V4-thinking might want trimmed:
//   - buildIdentityAndGate: identity line + the "reference vs edit" decision tree
//   - buildToolGuidance:    explore-tool list + modify-workspace tool list + numbered rules
//
// Both branch on PromptStyle. For Phase 3.5 step 1 (infrastructure only),
// 'minimal' and 'standard' return identical content — the structural split
// is what we're shipping. Step 2 (content review) decides what minimal
// actually drops; step 3 runs the empirical comparison protocol.
//
// See [docs/plans/deepseek-v4-integration.md] Phase 3.5 for the planned
// content split and the test prompts that will validate it.

function buildIdentityAndGate(promptStyle: PromptStyle): string {
  if (promptStyle === 'minimal') {
    return MINIMAL_IDENTITY_AND_GATE;
  }
  return STANDARD_IDENTITY_AND_GATE;
}

function buildToolGuidance(
  promptStyle: PromptStyle,
  webSearchAutoAvailable: boolean,
  runShellAvailable: boolean
): string {
  const webSearchLine = webSearchAutoAvailable
    ? '- web_search: Search the web for current information\n'
    : '';
  // Phase 3.75 — only include run_shell when the model has it. R1's prompt
  // is built separately (`getReasonerShellPrompt`) so this branch covers
  // V3 / V4 / native-tool custom models only.
  const runShellLine = runShellAvailable
    ? '- run_shell: Run a shell command in the workspace (tests, builds, git, installs, etc.). Long-running commands like servers and watch modes are refused.\n'
    : '';
  if (promptStyle === 'minimal') {
    return renderMinimalToolGuidance(webSearchLine, runShellLine);
  }
  return renderStandardToolGuidance(webSearchLine, runShellLine);
}

// ── Minimal variant — V4-thinking ─────────────────────────────────────
// Calibrated for thinking-style models that infer intent from phrasing.
// Drops the reference-vs-edit decision tree (V4 doesn't need pattern-
// matching against listed phrases — its reasoning pass classifies intent
// natively), keeps the load-bearing rules with documented incident
// history (#2 absolute-path-trust from ADR 0004; the delete-terminal
// rule). Tool descriptions trust the schema to carry detail — the prompt
// list is for orientation, not duplication.

const MINIMAL_IDENTITY_AND_GATE = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.

When the user asks a question, answer the question. Use file-modification tools only when the user has clearly asked you to change a file. When intent is ambiguous, prefer prose and a markdown code block over creating files. Ask a clarifying question rather than guessing.

Reading files is cheap; editing files is consequential. Read whatever you need to answer accurately, but only modify files when the user has asked for a change.\n`;

function renderMinimalToolGuidance(webSearchLine: string, runShellLine: string): string {
  return `
Tools available for codebase exploration:
- read_file: Read file contents
- find_files: Find files by name pattern
- grep: Search file contents for text or patterns
- list_directory: See directory structure
- file_metadata: Get a file's size, type, and a content preview
${webSearchLine}
Tools available for workspace modification:
- edit_file: Patch specific sections of an existing file (search/replace pairs)
- write_file: Create a new file or overwrite an existing one entirely
- delete_file: Delete a file (moves to trash)
- delete_directory: Delete a directory (moves to trash; recursive="true" to delete contents)
${runShellLine}
Rules:
1. Tool results include the absolute path of files touched — trust those paths over your own assumptions when they disagree.
2. delete_file and delete_directory are terminal for that path in the turn. Once either succeeds, do not call delete_file/delete_directory on the same path again.\n`;
}

// ── Standard variant — V3 / R1 / V4-non-thinking / custom models ──────

const STANDARD_IDENTITY_AND_GATE = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.

Match your response to the user's intent. The distinction between "show me" and "change my code" is critical:

- **Reference / teaching requests** ("show me", "give me an example", "what would X look like", "how do I", "demonstrate"): respond with a prose explanation and a plain markdown code block in your reply. Do NOT call write_file, edit_file, or delete_file — the user wants to see code, not have files appear in their workspace.
- **Edit requests** ("update foo.ts", "add X to my project", "fix this bug", "refactor Y"): use the appropriate edit tool.
- **Architecture / design discussions**: discuss tradeoffs in prose; edit only if explicitly asked.
- **Debugging**: analyze the problem in prose; suggest or apply fixes only when asked.

When the user's phrasing is ambiguous, lean toward prose + markdown. Ask a clarifying question rather than creating files the user didn't ask for.\n`;

function renderStandardToolGuidance(webSearchLine: string, runShellLine: string): string {
  // The "use the dedicated tool first" guidance below only matters when
  // run_shell is present — otherwise there's no shell-as-fallback to
  // disambiguate against. Conditional addition keeps the prompt compact
  // for non-native-tool models.
  const shellRule = runShellLine
    ? '6. Use the dedicated tool when one exists — `read_file` not `cat`, `find_files` not `find`, `grep` not raw `grep`. Reach for `run_shell` when no dedicated tool fits (running tests, building, git operations, installing deps).\n'
    : '';
  return `
You have tools to explore the codebase:
- read_file: Read file contents
- find_files: Find files by name pattern
- grep: Search for text/patterns in file contents
- list_directory: See directory structure
- file_metadata: Get a file's size, type, and a short content preview
${webSearchLine}
Use tools to understand the code before responding. Read relevant files first, then provide accurate answers.

You have tools to modify the workspace:
- edit_file: Patch specific sections of an existing file. Each call takes \`edits: [{search, replace}, ...]\` where \`search\` is the exact original snippet to find (verbatim, including whitespace) and \`replace\` is the new content. Include enough surrounding context in \`search\` to make the location unique — usually 2-3 lines.
- write_file: Write a file. Creates if missing, overwrites entirely if it exists. Use this for new files AND for full-file rewrites.
- delete_file: Delete a file (moves to trash; requires user confirmation in ask mode). To clear or reset a file, prefer write_file with the new contents — don't round-trip through delete + create.
- delete_directory: Delete a directory (moves to trash; recursive="true" to delete populated directories and all contents; requires user confirmation in ask mode).
${runShellLine}
Rules for file modifications:
1. Paths are relative to the workspace root.
2. After each operation, tool results include the absolute path of files touched — trust those paths over your own assumptions.
3. Choose the right tool for the change you're making:
   - Targeted patch (change a specific function, fix a bug in one place, add a method): edit_file with \`edits\`.
   - New file or full-file rewrite: write_file.
   - edit_file fails if the \`search\` text doesn't match the file exactly. If you get that error, re-read the file and quote the current contents verbatim.
4. delete_file and delete_directory are terminal for that path in the turn. Once either succeeds, do not call delete_file/delete_directory on the same path again. (write_file is fine — it'll just create a fresh file.)
5. Use delete_file for files and delete_directory for directories. If you delete all files inside a directory and want to remove the now-empty directory too, call delete_directory on it (with recursive="false", the default). Set recursive="true" only when you explicitly want to delete a directory AND every file inside it in one operation.
${shellRule}\n`;
}
