import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { DeepSeekClient } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { tracer, type TraceCategory } from '../tracing';
import { webviewLogStore } from '../logging/WebviewLogStore';
import { TavilyClient } from '../clients/tavilyClient';
import { WebSearchProviderRegistry } from '../clients/webSearchProviderRegistry';
import { WebSearchManager } from './webSearchManager';
import { FileContextManager } from './fileContextManager';
import { DiffManager } from './diffManager';
import { SettingsManager } from './settingsManager';
import { RequestOrchestrator } from './requestOrchestrator';
import { CommandApprovalManager } from './commandApprovalManager';
import { DrawingServer } from './drawingServer';
import { SavedPromptManager } from './savedPromptManager';
import { PlanManager } from './planManager';
import { TokenService } from '../services/tokenService';
import { qrcodegen } from '../vendor/qrcodegen';
import { getCapabilities, getAllRegisteredModels, supportsManualMode, MODEL_REGISTRY } from '../models/registry';

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-chat-view';
  private _view?: vscode.WebviewView;
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private conversationManager: ConversationManager;
  private currentSessionId: string | null = null;
  private readonly instanceId: string = uuidv4();
  private disposables: vscode.Disposable[] = [];
  /** Reference to the Tavily client for Tavily-specific concerns (credit
   *  stats, plan/usage API) that don't belong on the generic provider
   *  interface. Resolved from the registry so there's one instance. */
  private tavilyClient: TavilyClient;
  private webSearchRegistry: WebSearchProviderRegistry;

  // Message queuing during post-response summarization
  private _summarizing = false;
  private _pendingMessages: Array<{ message: string; attachments?: Array<{ content: string; name: string; size: number }> }> = [];
  private _lastPendingDiffCount = 0;
  private webSearchManager: WebSearchManager;
  private fileContextManager: FileContextManager;
  private diffManager: DiffManager;
  private settingsManager: SettingsManager;
  private requestOrchestrator: RequestOrchestrator;
  private commandApprovalManager: CommandApprovalManager;
  private savedPromptManager: SavedPromptManager;
  private planManager: PlanManager;
  private drawingServer: DrawingServer | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    deepSeekClient: DeepSeekClient,
    statusBar: StatusBar,
    conversationManager: ConversationManager,
    webSearchRegistry: WebSearchProviderRegistry,
    drawingServer?: DrawingServer
  ) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.conversationManager = conversationManager;
    this.webSearchRegistry = webSearchRegistry;
    this.tavilyClient = webSearchRegistry.getTavilyClient();
    this.drawingServer = drawingServer || null;

    // Create managers
    this.webSearchManager = new WebSearchManager(this.webSearchRegistry);
    this.fileContextManager = new FileContextManager();
    const config = vscode.workspace.getConfiguration('moby');
    // Initialize web search mode from persisted setting
    const webSearchMode = (config.get<string>('webSearchMode') || 'auto') as 'off' | 'manual' | 'auto';
    this.webSearchManager.setMode(webSearchMode);
    const editMode = (config.get<string>('editMode') || 'manual') as 'manual' | 'ask' | 'auto';
    this.diffManager = new DiffManager(new DiffEngine(), this.fileContextManager, editMode);
    this.settingsManager = new SettingsManager(this.deepSeekClient);
    // Create command approval manager (uses the same encrypted DB + globalState for cross-instance version counter)
    this.commandApprovalManager = new CommandApprovalManager(
      this.conversationManager.getDatabase(),
      this.conversationManager.getGlobalState()
    );
    this.savedPromptManager = new SavedPromptManager(
      this.conversationManager.getDatabase()
    );
    this.planManager = new PlanManager();
    this.requestOrchestrator = new RequestOrchestrator(
      this.deepSeekClient, this.conversationManager, this.statusBar,
      this.diffManager, this.webSearchManager, this.fileContextManager,
      this.commandApprovalManager, this.savedPromptManager, this.planManager
    );

    // Wire manager events → webview
    this.wireEvents();

    // Subscribe to session changes (cross-panel sync)
    this.disposables.push(
      this.conversationManager.onSessionsChangedEvent(() => {
        this.sendHistorySessions();
      })
    );

    // Load current session
    this.loadCurrentSession();

    // Track when new files are opened (for live modal updates)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (this.fileContextManager.isModalOpen) {
          const validSchemes = ['file', 'vscode-remote'];
          if (validSchemes.includes(document.uri.scheme) && !document.isClosed) {
            const relativePath = vscode.workspace.asRelativePath(document.uri);

            if (!relativePath.startsWith('extension-output-') &&
                !relativePath.includes('[') &&
                !document.isUntitled) {
              logger.info(`[ChatProvider] File opened while modal open: ${relativePath} - refreshing list`);
              this.fileContextManager.sendOpenFiles();
            }
          }
        }
      })
    );
  }

  // ── Manager Event Wiring ──

  private wireEvents(): void {
    // WebSearchManager → webview
    this.webSearchManager.onSearching((progress) => {
      this._view?.webview.postMessage({ type: 'webSearching', current: progress.current, total: progress.total });
    });
    this.webSearchManager.onSearchComplete(() => {
      this._view?.webview.postMessage({ type: 'webSearchComplete' });
    });
    this.webSearchManager.onSearchCached(() => {
      this._view?.webview.postMessage({ type: 'webSearchCached' });
    });
    this.webSearchManager.onSearchError(e => {
      this._view?.webview.postMessage({ type: 'warning', message: `Web search failed: ${e.message}` });
    });
    this.webSearchManager.onToggled(d => {
      this._view?.webview.postMessage({ type: 'webSearchToggled', enabled: d.enabled });
    });
    this.webSearchManager.onModeChanged(d => {
      this._view?.webview.postMessage({ type: 'webSearchModeChanged', mode: d.mode });
    });

    // FileContextManager → webview
    this.fileContextManager.onOpenFiles(data => {
      this._view?.webview.postMessage({ type: 'openFiles', files: data.files });
    });
    this.fileContextManager.onSearchResults(data => {
      this._view?.webview.postMessage({ type: 'searchResults', results: data.results });
    });
    this.fileContextManager.onFileContent(data => {
      this._view?.webview.postMessage({ type: 'fileContent', filePath: data.filePath, content: data.content });
    });

    // PlanManager → webview
    this.planManager.onPlanState(data => {
      this._view?.webview.postMessage({ type: 'planState', plans: data.plans });
    });

    // DiffManager → webview
    this.diffManager.onDiffListChanged(data => {
      // Detect diff removal: if pending diffs decreased, a diff tab was closed
      const pendingCount = data.diffs.filter(d => d.status === 'pending').length;
      if (pendingCount < this._lastPendingDiffCount) {
        this._view?.webview.postMessage({ type: 'diffClosed' });
      }
      this._lastPendingDiffCount = pendingCount;
      this._view?.webview.postMessage({ type: 'diffListChanged', diffs: data.diffs, editMode: data.editMode, source: 'diff-status' });
    });
    this.diffManager.onAutoAppliedFilesChanged(data => {
      this._view?.webview.postMessage({ type: 'diffListChanged', diffs: data.diffs, editMode: data.editMode, source: 'diff-engine' });
    });
    this.diffManager.onCodeApplied(data => {
      this._view?.webview.postMessage({ type: 'codeApplied', success: data.success, error: data.error, filePath: data.filePath });
    });
    this.diffManager.onActiveDiffChanged(data => {
      this._view?.webview.postMessage({ type: 'activeDiffChanged', filePath: data.filePath });
    });
    this.diffManager.onDiffClosed(() => {
      this._view?.webview.postMessage({ type: 'diffClosed' });
    });
    this.diffManager.onWarning(data => {
      this._view?.webview.postMessage({ type: 'warning', message: data.message });
    });
    this.diffManager.onEditConfirm(data => {
      this._view?.webview.postMessage({ type: 'showEditConfirm', filePath: data.filePath, code: data.code, language: data.language });
    });
    this.diffManager.onEditRejected(data => {
      this._view?.webview.postMessage({ type: 'editRejected', filePath: data.filePath });
    });
    this.diffManager.onWaitingForApproval(data => {
      this._view?.webview.postMessage({ type: 'waitingForApproval', filePaths: data.filePaths });
    });

    // DrawingServer → webview
    if (this.drawingServer) {
      this.drawingServer.onImageReceived(event => {
        this._view?.webview.postMessage({
          type: 'drawingReceived',
          imageDataUrl: event.imageDataUrl,
          timestamp: event.timestamp
        });
        // ADR 0003 Phase 2.5 #7: also record into the structural event stream
        // so hydration can replay the drawing in turn order.
        this.requestOrchestrator.recordDrawing(event.imageDataUrl);
      });
      this.drawingServer.onAsciiReceived(event => {
        this._view?.webview.postMessage({
          type: 'asciiDrawingReceived',
          text: event.text,
          timestamp: event.timestamp
        });
      });
    }

    // SettingsManager → webview
    this.settingsManager.onSettingsChanged(async snapshot => {
      if (this._view) {
        const wsState = await this.webSearchManager.getSettings();
        // Re-evaluate apiKeyConfigured on every settings change because the
        // check is per-model: switching from DeepSeek to a local Ollama
        // entry with an `apiKey: "ollama"` placeholder flips the flag true,
        // and the reverse flips it false. Without this, the send button
        // stays stuck at its initial state across model switches.
        const apiKeyConfigured = await this.deepSeekClient.isApiKeyConfigured();
        this._view.webview.postMessage({
          type: 'settings',
          ...snapshot,
          apiKeyConfigured,
          webSearch: {
            searchDepth: wsState.settings.searchDepth,
            creditsPerPrompt: wsState.settings.creditsPerPrompt,
            maxResultsPerSearch: wsState.settings.maxResultsPerSearch,
            cacheDuration: wsState.settings.cacheDuration,
            mode: wsState.mode,
            configured: wsState.configured,
            provider: wsState.provider,
            providerStatus: wsState.providerStatus
          }
        });
        const config = vscode.workspace.getConfiguration('moby');
        let editMode = (config.get<string>('editMode') || 'manual') as 'manual' | 'ask' | 'auto';
        // Manual mode requires the model to emit SEARCH/REPLACE in text for
        // the Apply button. Models whose primary edit channel is native-tool
        // bypass that path entirely — auto-switch to ask.
        if (!supportsManualMode(this.deepSeekClient.getModel()) && editMode === 'manual') {
          editMode = 'ask';
        }
        if (editMode !== this.diffManager.currentEditMode) {
          this.diffManager.setEditMode(editMode);
          this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });
        }
      }
    });
    this.settingsManager.onModelChanged(data => {
      this._view?.webview.postMessage({ type: 'modelChanged', model: data.model });
    });
    this.settingsManager.onSettingsReset(() => {
      this.webSearchManager.resetToDefaults();
      this._view?.webview.postMessage({ type: 'settingsReset' });
    });

    // RequestOrchestrator → webview
    this.requestOrchestrator.onStartResponse(d => {
      this._view?.webview.postMessage({ type: 'startResponse', ...d });
    });
    // Batch tokens before sending to webview (reduces ~20,000 postMessages to ~200-400).
    // Tokens accumulate for up to 50ms, then flush as a single concatenated message.
    // This dramatically reduces: gateway calls, CQRS events, EventStateManager publishes,
    // DOM updates, and layout reflows — all of which previously ran per-token.
    let pendingContentTokens = '';
    let contentFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingReasoningTokens = '';
    let reasoningFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushContentTokens = () => {
      // Don't flush if the pipeline is holding back content (partial tags,
      // approval pending, or shell execution in progress)
      if (pendingContentTokens && !this.requestOrchestrator.canFlushTokens()) {
        // Re-schedule — tokens stay buffered, try again next tick
        contentFlushTimer = setTimeout(flushContentTokens, 50);
        return;
      }
      if (pendingContentTokens) {
        this._view?.webview.postMessage({ type: 'streamToken', token: pendingContentTokens });
        pendingContentTokens = '';
      }
      contentFlushTimer = null;
    };

    const flushReasoningTokens = () => {
      if (pendingReasoningTokens) {
        this._view?.webview.postMessage({ type: 'streamReasoning', token: pendingReasoningTokens });
        pendingReasoningTokens = '';
      }
      reasoningFlushTimer = null;
    };

    this.requestOrchestrator.onStreamToken(d => {
      pendingContentTokens += d.token;
      if (!contentFlushTimer) {
        contentFlushTimer = setTimeout(flushContentTokens, 50);
      }
    });
    this.requestOrchestrator.onStreamReasoning(d => {
      pendingReasoningTokens += d.token;
      if (!reasoningFlushTimer) {
        reasoningFlushTimer = setTimeout(flushReasoningTokens, 50);
      }
    });
    this.requestOrchestrator.onEndResponse(d => {
      // Flush any pending batched tokens before signaling end
      flushContentTokens();
      flushReasoningTokens();
      this._view?.webview.postMessage({ type: 'endResponse', message: d });
    });
    this.requestOrchestrator.onGenerationStopped(() => {
      // Discard any pending tokens — don't flush partial content when user stops.
      // This prevents raw text/tags from dumping into the UI on abort.
      pendingContentTokens = '';
      pendingReasoningTokens = '';
      if (contentFlushTimer) {
        clearTimeout(contentFlushTimer);
        contentFlushTimer = null;
      }
      if (reasoningFlushTimer) {
        clearTimeout(reasoningFlushTimer);
        reasoningFlushTimer = null;
      }
      this._view?.webview.postMessage({ type: 'generationStopped', userStopped: true });
    });
    this.requestOrchestrator.onIterationStart(d => {
      // Flush tokens before iteration boundary (ensures text renders before shell/tool segments)
      flushContentTokens();
      flushReasoningTokens();
      this._view?.webview.postMessage({ type: 'iterationStart', iteration: d.iteration });
    });
    this.requestOrchestrator.onAutoContinuation(d => {
      this._view?.webview.postMessage({ type: 'autoContinuation', ...d });
    });
    this.requestOrchestrator.onToolCallsStart(d => {
      flushContentTokens();
      this._view?.webview.postMessage({ type: 'toolCallsStart', tools: d.tools });
    });
    this.requestOrchestrator.onToolCallsUpdate(d => {
      this._view?.webview.postMessage({ type: 'toolCallsUpdate', tools: d.tools });
    });
    this.requestOrchestrator.onToolCallUpdate(d => {
      this._view?.webview.postMessage({ type: 'toolCallUpdate', ...d });
    });
    this.requestOrchestrator.onToolCallsEnd(() => {
      this._view?.webview.postMessage({ type: 'toolCallsEnd' });
    });
    this.requestOrchestrator.onShellExecuting(d => {
      // Flush tokens so text before shell command renders first
      flushContentTokens();
      this._view?.webview.postMessage({ type: 'shellExecuting', commands: d.commands });
    });
    this.requestOrchestrator.onShellResults(d => {
      this._view?.webview.postMessage({ type: 'shellResults', results: d.results });
    });
    this.requestOrchestrator.onSessionCreated(d => {
      this._view?.webview.postMessage({ type: 'sessionCreated', ...d });
    });
    this.requestOrchestrator.onError(d => {
      this._view?.webview.postMessage({ type: 'error', error: d.error });
    });
    this.requestOrchestrator.onWarning(d => {
      this._view?.webview.postMessage({ type: 'warning', message: d.message });
    });

    // Summarization → message queuing flag
    this.requestOrchestrator.onSummarizationStarted(() => {
      this._summarizing = true;
      logger.info('[ChatProvider] Summarization started — queuing enabled');
    });
    this.requestOrchestrator.onSummarizationCompleted(() => {
      this._summarizing = false;
      logger.info('[ChatProvider] Summarization completed — queuing disabled');
    });
    this.requestOrchestrator.onTurnSequenceUpdate(d => {
      this._view?.webview.postMessage({ type: 'turnSequenceUpdate', ...d });
    });

    // CommandApprovalManager → webview
    this.commandApprovalManager.onApprovalRequired(data => {
      logger.info(`[ChatProvider] Forwarding commandApprovalRequired to webview: command="${data.command}", prefix="${data.prefix}", unknownSubCommand="${data.unknownSubCommand}"`);
      this._view?.webview.postMessage({
        type: 'commandApprovalRequired',
        command: data.command,
        prefix: data.prefix,
        unknownSubCommand: data.unknownSubCommand,
      });
    });

    // Forward rules changes to webview (for rules modal live updates)
    this.commandApprovalManager.onRulesChanged(rules => {
      logger.debug(`[ChatProvider] Forwarding rules update to webview: ${rules.length} rules`);
      this._view?.webview.postMessage({ type: 'commandRulesList', rules });
    });
  }

  // ── Lifecycle ──

  public dispose() {
    this.webSearchManager.dispose();
    this.fileContextManager.dispose();
    this.diffManager.dispose();
    this.settingsManager.dispose();
    this.requestOrchestrator.dispose();
    this.commandApprovalManager.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  /** Public getter for CommandProvider and extension.ts to access the current session ID. */
  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * ADR 0003: expose the structural event recorder for debug commands.
   * Phase 1's Export Turn command reads from this. Phases 2 and 3 will feed
   * into the same data path for persistence and hydration comparison.
   */
  public getStructuralEventRecorder() {
    return this.requestOrchestrator.structuralEvents;
  }

  private async loadCurrentSession() {
    const gs = this.conversationManager.getGlobalState();

    // Try instance-scoped key first (runtime isolation between parallel instances)
    const instanceKey = `currentSessionId-${this.instanceId}`;
    const instanceSavedId = gs.get<string>(instanceKey);
    if (instanceSavedId) {
      const session = await this.conversationManager.getSession(instanceSavedId);
      if (session) {
        this.currentSessionId = instanceSavedId;
        logger.info(`[ChatProvider] loadCurrentSession: restored ${instanceSavedId.substring(0, 8)} from instance-key`);
        return;
      }
    }

    // Fall back to shared key (resume last session on cold start)
    const savedId = gs.get<string>('currentSessionId');
    if (savedId) {
      const session = await this.conversationManager.getSession(savedId);
      if (session) {
        this.currentSessionId = savedId;
        logger.info(`[ChatProvider] loadCurrentSession: restored ${savedId.substring(0, 8)} from shared-key`);
      }
    }
  }

  private async saveCurrentSession(): Promise<void> {
    if (this.currentSessionId) {
      const gs = this.conversationManager.getGlobalState();
      await gs.update(`currentSessionId-${this.instanceId}`, this.currentSessionId);
      await gs.update('currentSessionId', this.currentSessionId);
    }
  }

  // ── WebviewViewProvider & Message Router ──

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    // Trace webview lifecycle - critical for debugging timing issues
    const resolveInfo = {
      previousViewExists: this._view !== undefined,
      hasState: context.state !== undefined
    };
    tracer.trace('webview.resolve' as TraceCategory, 'chatPanel', { data: resolveInfo });
    logger.info('[ChatProvider] Webview resolving', JSON.stringify(resolveInfo));

    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage': {
          // Queue messages that arrive during post-response summarization
          if (this._summarizing) {
            this._pendingMessages.push({ message: data.message, attachments: data.attachments });
            logger.info(`[ChatProvider] Message queued during summarization (queue=${this._pendingMessages.length})`);
            this._view?.webview.postMessage({ type: 'statusMessage', message: 'Queued — optimizing context...' });
            break;
          }
          const result = await this.requestOrchestrator.handleMessage(
            data.message, this.currentSessionId,
            () => this.fileContextManager.getEditorContext(),
            data.attachments
          );
          this.currentSessionId = result.sessionId;
          // Drain any messages that were queued during summarization
          await this.drainQueue();
          break;
        }
        case 'clearChat':
          this.clearConversation();
          break;
        case 'applyCode': {
          const filePathMatch = (data.code as string)?.match(/^#\s*File:\s*(.+?)$/m);
          const hintedFilePath = filePathMatch ? filePathMatch[1].trim() : null;
          logger.info(`[ChatProvider] applyCode: filePath=${hintedFilePath}, session=${this.currentSessionId?.substring(0, 8)}, editMode=${this.diffManager.currentEditMode}`);
          const outcome = await this.diffManager.applyCode(data.code, data.language);
          // Use the real outcome — applyCode may have failed silently (file
          // not found, no workspace) or opened an untitled doc (outcome=null).
          const filePath = outcome?.filePath || hintedFilePath;
          if (this.currentSessionId && filePath && outcome) {
            this.conversationManager.updateFileModifiedStatus(this.currentSessionId, filePath, outcome.status, this.diffManager.currentEditMode);
          } else {
            logger.warn(`[ChatProvider] applyCode: skipped DB update — sessionId=${this.currentSessionId}, filePath=${filePath}, outcome=${outcome ? outcome.status : 'null'}`);
          }
          break;
        }
        case 'showDiff':
          await this.diffManager.showDiff(data.code, data.language);
          break;
        case 'closeDiff':
          await this.diffManager.closeDiff();
          break;
        case 'loadHistory':
          await this.loadCurrentSessionHistory();
          break;
        case 'stopGeneration':
          this.requestOrchestrator.stopGeneration();
          break;
        // ADR 0003 Phase 3: turnEventsForSave retired. Webview no longer sends
        // a consolidated CQRS blob; extension authors events live.
        case 'updateSettings':
          await this.settingsManager.updateSettings(data.settings);
          break;
        case 'selectModel': {
          const currentModel = this.deepSeekClient.getModel();
          if (data.model !== currentModel) {
            // Switch tokenizer vocab if needed for the new model
            const tokenService = TokenService.getInstance();
            await tokenService.selectModel(data.model as string);

            // If the current session has messages, start a new session
            if (this.currentSessionId && this.conversationManager.sessionHasEvents(this.currentSessionId)) {
              await this.settingsManager.updateSettings({ model: data.model });
              await this.clearConversation();
            } else {
              // Empty session — just switch the model in place
              await this.settingsManager.updateSettings({ model: data.model });
            }
          }
          break;
        }
        case 'setTemperature':
          await this.settingsManager.updateSettings({ temperature: data.temperature });
          break;
        case 'setToolLimit':
          await this.settingsManager.updateSettings({ maxToolCalls: data.toolLimit });
          break;
        case 'setShellIterations':
          await this.settingsManager.updateSettings({ maxShellIterations: data.shellIterations });
          break;
        case 'setFileEditLoops':
          await this.settingsManager.updateSettings({ maxFileEditLoops: data.fileEditLoops });
          break;
        case 'setReasoningEffort': {
          // Phase 4 — model-selector pill writes the per-model override into
          // `moby.modelOptions.<id>.reasoningEffort`. The orchestrator reads
          // this fresh on every request via `applyThinkingMode`, so the
          // change takes effect on the next turn without any local cache
          // invalidation. The config-change listener (registered in
          // extension.ts) re-broadcasts the model list so the active pill
          // ends up reflecting persisted state on every webview.
          const model = data.model as string;
          const effort = data.effort as 'high' | 'max' | undefined;
          if (!model || (effort !== 'high' && effort !== 'max')) {
            logger.warn(`[ChatProvider] setReasoningEffort: invalid payload (model=${model}, effort=${effort})`);
            break;
          }
          const config = vscode.workspace.getConfiguration('moby');
          const current = config.get<Record<string, { reasoningEffort?: 'high' | 'max' }>>('modelOptions') ?? {};
          const next = { ...current, [model]: { ...(current[model] ?? {}), reasoningEffort: effort } };
          await config.update('modelOptions', next, vscode.ConfigurationTarget.Global);
          logger.info(`[ChatProvider] setReasoningEffort: ${model} → ${effort}`);
          break;
        }
        case 'setMaxTokens': {
          const model = data.model as string || this.deepSeekClient.getModel();
          const config = vscode.workspace.getConfiguration('moby');
          if (MODEL_REGISTRY[model]) {
            // Built-in model: write to its registered per-model config key.
            const configKey = getCapabilities(model).maxTokensConfigKey;
            await config.update(configKey, data.maxTokens, vscode.ConfigurationTarget.Global);
          } else {
            // Custom model: the `maxTokensConfigKey` field names an arbitrary
            // user-invented key that VS Code rejects at write time because
            // it isn't declared in package.json. Instead, patch the matching
            // entry's `maxOutputTokens` inside the `moby.customModels` array
            // and let the config-change listener reload the registry.
            const entries = (config.get<Array<Record<string, unknown>>>('customModels') ?? []).map(e => ({ ...e }));
            const idx = entries.findIndex(e => e.id === model);
            if (idx === -1) {
              logger.warn(`[ChatProvider] setMaxTokens: custom model "${model}" not found in moby.customModels — skipping write`);
              break;
            }
            entries[idx].maxOutputTokens = data.maxTokens;
            await config.update('customModels', entries, vscode.ConfigurationTarget.Global);
          }
          break;
        }
        case 'setLogLevel':
          await this.settingsManager.updateLogSettings({ logLevel: data.logLevel });
          break;
        case 'setWebviewLogLevel':
          await this.settingsManager.updateWebviewLogSettings({ webviewLogLevel: data.logLevel });
          break;
        case 'setTracingEnabled':
          await this.settingsManager.updateTracingSettings({ enabled: data.enabled });
          break;
        case 'openLogs':
          logger.show();
          break;
        case 'setAllowAllCommands':
          await this.settingsManager.updateReasonerSettings({ allowAllCommands: data.enabled });
          break;
        case 'setSystemPrompt':
          // Save as active prompt in DB (create or update)
          {
            const active = this.savedPromptManager.getActive();
            if (active) {
              this.savedPromptManager.update(active.id, active.name, data.systemPrompt, active.model ?? undefined);
            } else if (data.systemPrompt.trim()) {
              this.savedPromptManager.save('Custom Prompt', data.systemPrompt);
            }
          }
          break;
        case 'getSavedPrompts':
          this._view?.webview.postMessage({
            type: 'savedPrompts',
            prompts: this.savedPromptManager.getAll()
          });
          break;
        case 'savePrompt':
          this.savedPromptManager.save(data.name, data.content, data.model);
          this._view?.webview.postMessage({
            type: 'savedPrompts',
            prompts: this.savedPromptManager.getAll()
          });
          break;
        case 'updateSavedPrompt':
          this.savedPromptManager.update(data.id, data.name, data.content, data.model);
          this._view?.webview.postMessage({
            type: 'savedPrompts',
            prompts: this.savedPromptManager.getAll()
          });
          break;
        case 'deleteSavedPrompt':
          this.savedPromptManager.delete(data.id);
          this._view?.webview.postMessage({
            type: 'savedPrompts',
            prompts: this.savedPromptManager.getAll()
          });
          break;
        case 'setActivePrompt':
          if (data.id) {
            this.savedPromptManager.setActive(data.id);
          } else {
            this.savedPromptManager.clearActive();
          }
          break;
        case 'getSettings':
          this.sendCurrentSettings();
          break;
        case 'executeCommand':
          // Forward optional args from the webview (e.g. the custom model id
          // when the settings popup's "Set key" button is clicked).
          if (Array.isArray(data.args)) {
            vscode.commands.executeCommand(data.command, ...data.args);
          } else {
            vscode.commands.executeCommand(data.command);
          }
          break;
        case 'toggleWebSearch':
          await this.webSearchManager.toggle(data.enabled);
          break;
        case 'setWebSearchMode': {
          const mode = data.mode as 'off' | 'manual' | 'auto';
          this.webSearchManager.setMode(mode);
          // Persist to VS Code settings
          const wsConfig = vscode.workspace.getConfiguration('moby');
          await wsConfig.update('webSearchMode', mode, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'updateWebSearchSettings':
          this.webSearchManager.updateSettings(data.settings);
          break;
        case 'getWebSearchSettings':
          this.sendWebSearchSettings();
          break;
        case 'clearSearchCache':
          this.webSearchManager.clearCache();
          break;
        case 'setWebSearchProvider': {
          // Persist the chosen provider id. The config-change listener in
          // extension.ts re-fires refreshSettings so the UI updates live.
          const nextProvider = data.provider as string;
          await vscode.workspace.getConfiguration('moby')
            .update('webSearch.provider', nextProvider, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'setSearxngEngines': {
          const engines = Array.isArray(data.engines) ? data.engines : [];
          await vscode.workspace.getConfiguration('moby')
            .update('webSearch.searxng.engines', engines, vscode.ConfigurationTarget.Global);
          break;
        }
        case 'testWebSearchProvider': {
          const requestId = data.requestId as string;
          const providerId = data.provider as string;
          const result = await this.webSearchManager.testProvider(providerId);
          this._view?.webview.postMessage({
            type: 'webSearchTestResult',
            requestId,
            provider: providerId,
            ...result
          });
          break;
        }
        case 'setEditMode':
          this.diffManager.setEditMode(data.mode);
          break;
        case 'showLogs':
          // Show the DeepSeek output channel (logs)
          logger.show();
          break;
        case 'rejectEdit':
          await this.diffManager.rejectEdit(data.filePath);
          break;
        case 'acceptSpecificDiff': {
          logger.info(`[ChatProvider] acceptSpecificDiff: diffId=${data.diffId}, filePath=${data.filePath}, session=${this.currentSessionId?.substring(0, 8)}, editMode=${this.diffManager.currentEditMode}`);
          const outcome = await this.diffManager.acceptSpecificDiff(data.diffId);
          // Use the actual outcome (can be 'rejected' if e.g. the delete
          // capability fails), fall back to 'applied' + the webview-supplied
          // filePath if DiffManager couldn't determine either.
          const filePath = outcome?.filePath || data.filePath;
          const status = outcome?.status ?? 'applied';
          if (this.currentSessionId && filePath) {
            this.conversationManager.updateFileModifiedStatus(this.currentSessionId, filePath, status, this.diffManager.currentEditMode);
          } else {
            logger.warn(`[ChatProvider] acceptSpecificDiff: skipped DB update — sessionId=${this.currentSessionId}, filePath=${filePath}`);
          }
          break;
        }
        case 'rejectSpecificDiff': {
          logger.info(`[ChatProvider] rejectSpecificDiff: diffId=${data.diffId}, filePath=${data.filePath}, session=${this.currentSessionId?.substring(0, 8)}, editMode=${this.diffManager.currentEditMode}`);
          const outcome = await this.diffManager.rejectSpecificDiff(data.diffId);
          const filePath = outcome?.filePath || data.filePath;
          const status = outcome?.status ?? 'rejected';
          if (this.currentSessionId && filePath) {
            this.conversationManager.updateFileModifiedStatus(this.currentSessionId, filePath, status, this.diffManager.currentEditMode);
          } else {
            logger.warn(`[ChatProvider] rejectSpecificDiff: skipped DB update — sessionId=${this.currentSessionId}, filePath=${filePath}`);
          }
          break;
        }
        case 'focusDiff':
          await this.diffManager.focusSpecificDiff(data.diffId);
          break;
        case 'openFile':
          await this.diffManager.openFile(data.filePath);
          break;
        case 'focusFile':
          await this.diffManager.focusFileOrDiff(data.diffId, data.filePath);
          break;
        case 'getOpenFiles':
          this.fileContextManager.sendOpenFiles();
          break;
        case 'fileModalOpened':
          this.fileContextManager.setModalOpen(true);
          break;
        case 'fileModalClosed':
          this.fileContextManager.setModalOpen(false);
          break;
        case 'searchFiles':
          await this.fileContextManager.handleFileSearch(data.query);
          break;
        case 'getFileContent':
          await this.fileContextManager.sendFileContent(data.filePath);
          break;
        case 'setSelectedFiles':
          this.fileContextManager.setSelectedFiles(data.files);
          break;

        // Plan manager messages
        case 'refreshPlans':
          await this.planManager.refresh();
          break;
        case 'togglePlan':
          await this.planManager.togglePlan(data.name);
          break;
        case 'createPlan':
          await this.planManager.createPlan(data.name);
          break;
        case 'deletePlan':
          await this.planManager.deletePlan(data.name);
          break;
        case 'openPlan':
          await this.planManager.openPlan(data.name);
          break;

        case 'setSearchDepth':
          this.webSearchManager.updateSettings({ searchDepth: data.searchDepth });
          break;
        case 'setCreditsPerPrompt':
          this.webSearchManager.updateSettings({ creditsPerPrompt: data.value });
          break;
        case 'setMaxResultsPerSearch':
          this.webSearchManager.updateSettings({ maxResultsPerSearch: data.value });
          break;
        case 'setCacheDuration':
          this.webSearchManager.updateSettings({ cacheDuration: data.cacheDuration });
          break;
        case 'setAutoSaveHistory':
          await this.settingsManager.updateSettings({ autoSaveHistory: data.enabled });
          break;
        case 'clearAllHistory':
          await this.clearAllHistory();
          break;
        case 'resetToDefaults':
          await this.settingsManager.resetToDefaults();
          break;
        // History modal messages
        case 'getHistorySessions':
          await this.sendHistorySessions();
          break;
        case 'switchToSession':
          await this.loadSession(data.sessionId);
          break;
        case 'renameSession':
          await this.renameSession(data.sessionId, data.title);
          break;
        case 'exportSession':
          await this.exportSessionToFile(data.sessionId, data.format);
          break;
        case 'deleteSession':
          await this.deleteSession(data.sessionId);
          break;
        case 'exportAllHistory':
          await this.exportAllHistoryToFile(data.format);
          break;
        case 'forkSession':
          await this.handleForkSession(data.atSequence as number);
          break;
        // Command approval response from webview
        case 'commandApprovalResponse': {
          const decision = data.decision as 'allowed' | 'blocked';
          const persistent = data.persistent as boolean;
          const prefix = data.prefix as string | undefined;
          const command = data.command as string;
          // If "Always Allow/Block", persist the rule
          if (persistent && prefix) {
            this.commandApprovalManager.addRule(prefix, decision);
          }
          // Resolve the pending approval Promise
          this.commandApprovalManager.resolveApproval({
            command,
            decision,
            persistent,
            prefix,
          });
          // Notify webview to update the approval widget UI
          this._view?.webview.postMessage({
            type: 'commandApprovalResolved',
            command,
            decision,
          });
          break;
        }
        // Stats modal
        case 'getStats':
          await this.sendStats();
          break;
        // Command rules management (rules modal)
        case 'getCommandRules':
          this.sendCommandRules();
          break;
        case 'addCommandRule':
          this.commandApprovalManager.addRule(data.prefix as string, data.ruleType as 'allowed' | 'blocked');
          break;
        case 'removeCommandRule':
          this.commandApprovalManager.removeRule(data.id as number);
          break;
        case 'resetCommandRulesToDefaults':
          this.commandApprovalManager.resetToDefaults();
          break;
        // Webview trace events - merge into extension trace collector
        case 'traceEvents':
          // Log time alignment diagnostic if webview sent sync time
          if (data.webviewSyncTime) {
            const extensionNow = new Date().toISOString();
            const webviewTime = data.webviewSyncTime as string;
            const diffMs = new Date(extensionNow).getTime() - new Date(webviewTime).getTime();
            if (Math.abs(diffMs) > 1000) {
              logger.warn(`[Trace] Time drift detected: extension=${extensionNow} webview=${webviewTime} diff=${diffMs}ms`);
            }
          }
          this.handleWebviewTraceEvents(data.events);
          // Send acknowledgment so webview knows it's safe to clear buffer
          this._view?.webview.postMessage({ type: 'traceSyncAck', count: data.events?.length || 0 });
          break;
        // Webview log entries - store in extension-side buffer
        case 'webviewLogs':
          if (data.entries?.length) {
            webviewLogStore.import(data.entries);
          }
          break;
        // Webview ready - send calibration data and request immediate trace sync
        case 'webviewReady':
          this.sendTraceCalibration();
          // Send the registered-model list unconditionally on webview ready.
          // Previously sendModelList was only called from loadCurrentSessionHistory,
          // which early-returns when there's no current session — leaving fresh
          // installs (or sessions opened before the user has sent anything) with
          // the webview's hardcoded V3+R1 fallback list, missing V4 entries.
          this.sendModelList();
          break;

        // Drawing server control
        case 'startDrawingServer':
          await this.handleStartDrawingServer();
          break;
        case 'stopDrawingServer':
          await this.handleStopDrawingServer();
          break;
        case 'copyToClipboard':
          if (data.text) {
            await vscode.env.clipboard.writeText(data.text as string);
          }
          break;
        case 'saveDrawing':
          if (data.imageDataUrl) {
            await this.handleSaveDrawing(data.imageDataUrl as string);
          }
          break;
      }
    });

    // Handle visibility changes - request trace sync when webview becomes visible/hidden
    webviewView.onDidChangeVisibility(() => {
      tracer.trace('webview.visible' as TraceCategory, webviewView.visible ? 'shown' : 'hidden');
      if (webviewView.visible) {
        // Webview became visible - send calibration in case it was recreated
        this.sendTraceCalibration();
      }
      // Always request trace sync on visibility change (capture events before potential destruction)
      this._view?.webview.postMessage({ type: 'requestTraceSync' });
    });

    // Load conversation history for current session
    this.loadCurrentSessionHistory();
  }

  // ── Tracing ──

  private sendTraceCalibration(): void {
    if (!this._view) return;

    // Get the current correlation ID from the logger (if an API request is in progress)
    const correlationId = logger.getCurrentCorrelationId();

    // Send the extension's start time and current correlation ID (if any)
    this._view.webview.postMessage({
      type: 'traceCalibration',
      extensionStartTime: new Date().toISOString(),
      correlationId: correlationId || undefined
    });
  }

  // ── Public API (extension.ts) ──

  public reveal() {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  /**
   * Re-send current settings to the webview.
   * Called after API key changes to update button states.
   */
  public refreshSettings() {
    this.sendCurrentSettings();
  }

  /** Test-connection shortcut for command-layer callers (the setSearxngEndpoint
   *  wizard runs this after writing the endpoint to surface reachability
   *  errors immediately rather than on the first real search). Thin wrapper
   *  over webSearchManager.testProvider so `extension.ts` doesn't have to
   *  reach through the manager. */
  public async testWebSearchProvider(providerId: string): Promise<{ success: boolean; message: string }> {
    return this.webSearchManager.testProvider(providerId);
  }

  /**
   * Open the history modal in the chat view.
   * Reveals the chat panel and triggers the history modal to open.
   */
  public async openHistoryModal() {
    this.reveal();
    // Small delay to ensure webview is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this._view) {
      // Send history sessions first, then trigger modal open
      await this.sendHistorySessions();
      this._view.webview.postMessage({ type: 'openHistoryModal' });
    }
  }

  /**
   * Open the command rules modal in the chat view.
   */
  public async openRulesModal() {
    this.reveal();
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this._view) {
      this.sendCommandRules();
      this._view.webview.postMessage({ type: 'openRulesModal' });
    }
  }

  private sendCommandRules(): void {
    const rules = this.commandApprovalManager.getAllRules();
    const allowAll = vscode.workspace.getConfiguration('moby').get<boolean>('allowAllShellCommands') ?? false;
    this._view?.webview.postMessage({ type: 'commandRulesList', rules, allowAll });
  }

  /**
   * Send stats data to the webview (called from getStats message handler).
   */
  private async sendStats(): Promise<void> {
    if (!this._view) return;

    const stats = await this.conversationManager.getSessionStats();

    let balance = null;
    try {
      balance = await this.deepSeekClient.getBalance();
    } catch (e) { /* silent */ }

    // Tavily-specific stats are only meaningful when Tavily is the active
    // provider. For SearXNG (or any non-Tavily provider) we send nulls so
    // the stats modal can omit the Tavily section rather than showing stale
    // counters from a previous session.
    const tavilyActive = this.webSearchRegistry.activeId() === 'tavily';
    const tavilyStats = tavilyActive ? this.tavilyClient.getUsageStats() : null;

    let tavilyApiUsage = null;
    if (tavilyActive && await this.tavilyClient.isConfigured()) {
      try {
        tavilyApiUsage = await this.tavilyClient.getApiUsage();
      } catch (e) { /* silent */ }
    }

    this._view.webview.postMessage({
      type: 'statsLoaded',
      stats,
      balance,
      tavilyStats,
      tavilyApiUsage
    });
  }

  /**
   * Show stats in the chat view.
   * Reveals the chat panel and displays usage statistics.
   */
  public async showStats() {
    this.reveal();
    // Small delay to ensure webview is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this._view) {
      // Get stats
      const stats = await this.conversationManager.getSessionStats();

      // Fetch balance from DeepSeek API
      let balance = null;
      try {
        balance = await this.deepSeekClient.getBalance();
      } catch (e) {
        // Silently fail if balance fetch fails
      }

      // Tavily-specific stats only when Tavily is the active provider.
      const tavilyActive = this.webSearchRegistry.activeId() === 'tavily';
      const tavilyStats = tavilyActive ? this.tavilyClient.getUsageStats() : null;

      let tavilyApiUsage = null;
      if (tavilyActive && await this.tavilyClient.isConfigured()) {
        try {
          tavilyApiUsage = await this.tavilyClient.getApiUsage();
        } catch (e) {
          // Silently fail if API usage fetch fails
        }
      }

      this._view.webview.postMessage({
        type: 'statsLoaded',
        stats,
        balance,
        tavilyStats,
        tavilyApiUsage
      });
    }
  }

  // ── Message Queue ──

  /**
   * Process messages that were queued during post-response summarization.
   * Each queued message is handled sequentially — if a queued message
   * triggers another summarization, further messages continue to queue
   * and are picked up by the same while loop after the await.
   */
  private async drainQueue(): Promise<void> {
    while (this._pendingMessages.length > 0) {
      const pending = this._pendingMessages.shift()!;
      logger.info(`[ChatProvider] Draining queued message (remaining=${this._pendingMessages.length})`);
      const result = await this.requestOrchestrator.handleMessage(
        pending.message, this.currentSessionId,
        () => this.fileContextManager.getEditorContext(),
        pending.attachments
      );
      this.currentSessionId = result.sessionId;
    }
  }

  // ── Settings & Search Helpers ──

  public async clearConversation() {
    // Block if currently streaming — stop first, then clear
    if (this.requestOrchestrator.isGenerating()) {
      this.requestOrchestrator.stopGeneration();
    }

    // Clear current conversation but keep session
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearChat' });
    }

    // Clear search cache on new session
    this.webSearchManager.clearCache();

    // Clear diff state for new conversation
    this.diffManager.clearSession();
    this.diffManager.cancelPendingApprovals();
    this.commandApprovalManager.cancelPendingApproval();

    // Create a new session for fresh conversation
    const session = await this.conversationManager.createSession(
      undefined,
      this.deepSeekClient.getModel()
    );
    this.currentSessionId = session.id;
    await this.saveCurrentSession();
    logger.sessionStart(session.id, session.title);

    // Notify webview of new session (for SessionActor)
    if (this._view) {
      this._view.webview.postMessage({
        type: 'sessionCreated',
        sessionId: session.id,
        model: this.deepSeekClient.getModel()
      });
    }
  }

  private async sendCurrentSettings() {
    const snapshot = this.settingsManager.getCurrentSettings();
    const wsState = await this.webSearchManager.getSettings();
    const apiKeyConfigured = await this.deepSeekClient.isApiKeyConfigured();
    // Use diffManager's live state as source of truth — config may be stale
    // due to async config.update() not completing before this read
    const editMode = this.diffManager.currentEditMode;

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        ...snapshot,
        apiKeyConfigured,
        systemPrompt: this.savedPromptManager.getActiveContent(),
        webSearch: {
          searchDepth: wsState.settings.searchDepth,
          creditsPerPrompt: wsState.settings.creditsPerPrompt,
          maxResultsPerSearch: wsState.settings.maxResultsPerSearch,
          cacheDuration: wsState.settings.cacheDuration,
          mode: wsState.mode,
          configured: wsState.configured,
          provider: wsState.provider,
          providerStatus: wsState.providerStatus
        }
      });
      // Send edit mode separately
      this._view.webview.postMessage({
        type: 'editModeSettings',
        mode: editMode
      });
    }
  }

  private async sendWebSearchSettings() {
    const { enabled, settings, configured, mode, provider, providerStatus } =
      await this.webSearchManager.getSettings();
    const config = vscode.workspace.getConfiguration('moby');
    // SearXNG-specific config lives in VS Code settings (non-secret, easy
    // to edit manually). Pull here and pass to the popup so it can render
    // the right provider section.
    const searxngEndpoint = (config.get<string>('webSearch.searxng.endpoint') || '').trim();
    const searxngEngines = config.get<string[]>('webSearch.searxng.engines') ?? [];
    this._view?.webview.postMessage({
      type: 'webSearchSettings',
      enabled,
      settings,
      configured,
      mode,
      provider,
      providerStatus,
      searxng: {
        endpoint: searxngEndpoint,
        engines: searxngEngines
      }
    });
  }

  // ── History & Session Management ──

  private async clearAllHistory() {
    try {
      // Clear history using the manager
      await this.conversationManager.clearAllHistory();

      // Reset current session and clear saved ID from globalState
      this.currentSessionId = null;
      const gs = this.conversationManager.getGlobalState();
      await gs.update(`currentSessionId-${this.instanceId}`, undefined);
      await gs.update('currentSessionId', undefined);

      logger.info('[ChatProvider] All chat history cleared');
      logger.sessionClear();

      // Notify webview
      this._view?.webview.postMessage({ type: 'historyCleared' });
      this._view?.webview.postMessage({ type: 'clearChat' });

      // Refresh history modal sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to clear history: ${error}`);
    }
  }

  private async sendHistorySessions() {
    try {
      const sessions = await this.conversationManager.getAllSessions();
      this._view?.webview.postMessage({
        type: 'historySessions',
        sessions: sessions
      });

      // Also send current session ID
      if (this.currentSessionId) {
        this._view?.webview.postMessage({
          type: 'currentSessionId',
          sessionId: this.currentSessionId
        });
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to send history sessions: ${error}`);
    }
  }

  private async renameSession(sessionId: string, title: string) {
    try {
      await this.conversationManager.renameSession(sessionId, title);
      logger.info(`[ChatProvider] Renamed session ${sessionId} to "${title}"`);

      // Refresh sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to rename session: ${error}`);
    }
  }

  private async exportSessionToFile(sessionId: string, format: 'json' | 'markdown' | 'txt') {
    try {
      const content = await this.conversationManager.exportSession(sessionId, format);
      if (!content) {
        vscode.window.showErrorMessage('Session not found');
        return;
      }

      const session = await this.conversationManager.getSession(sessionId);
      const title = session?.title || 'chat';
      const ext = format === 'markdown' ? 'md' : format;
      const defaultName = `${title.replace(/[^a-z0-9]/gi, '_')}.${ext}`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: {
          [format.toUpperCase()]: [ext]
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        logger.info(`[ChatProvider] Exported session ${sessionId} to ${uri.fsPath}`);
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to export session: ${error}`);
      vscode.window.showErrorMessage('Failed to export session');
    }
  }

  private async deleteSession(sessionId: string) {
    try {
      await this.conversationManager.deleteSession(sessionId);
      logger.info(`[ChatProvider] Deleted session ${sessionId}`);

      // If we deleted the current session, clear it
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
        this._view?.webview.postMessage({ type: 'clearChat' });
      }

      // Refresh sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to delete session: ${error}`);
    }
  }

  private async exportAllHistoryToFile(format: 'json' | 'markdown' | 'txt') {
    try {
      const content = await this.conversationManager.exportAllSessions(format);
      if (!content) {
        vscode.window.showWarningMessage('No chat history to export');
        return;
      }

      const ext = format === 'markdown' ? 'md' : format;
      const defaultName = `deepseek-history-${new Date().toISOString().split('T')[0]}.${ext}`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: {
          [format.toUpperCase()]: [ext]
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Exported all history to ${uri.fsPath}`);
        logger.info(`[ChatProvider] Exported all history to ${uri.fsPath}`);
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to export history: ${error}`);
      vscode.window.showErrorMessage('Failed to export history');
    }
  }

  private handleWebviewTraceEvents(events: unknown[]): void {
    if (!Array.isArray(events)) return;

    for (const event of events) {
      // Validate event structure
      if (!event || typeof event !== 'object') continue;

      const e = event as Record<string, unknown>;
      if (!e.category || !e.operation || !e.timestamp) continue;

      // Import webview trace into extension tracer
      // Use importEvent() to preserve the original webview timestamp
      // This ensures chronological ordering in the unified timeline
      tracer.importEvent(e.category as TraceCategory, e.operation as string, {
        originalId: e.id as string,
        timestamp: e.timestamp as string, // Preserve original timestamp!
        originalRelativeTime: e.relativeTime as number | undefined,
        correlationId: e.correlationId as string | undefined,
        executionMode: (e.executionMode as 'sync' | 'async' | 'callback') || 'sync',
        level: (e.level as 'debug' | 'info' | 'warn' | 'error') || 'info',
        status: (e.status as 'started' | 'completed' | 'failed') || 'completed',
        data: e.data as Record<string, unknown> || {}
      });
    }
  }

  public getTavilyClient(): TavilyClient {
    return this.tavilyClient;
  }

  /**
   * Shows quick pick menu for managing diffs (public wrapper for extension.ts command)
   */
  public async showDiffQuickPick(): Promise<void> {
    return this.diffManager.showDiffQuickPick();
  }

  /**
   * Push the current registered-model list (built-ins + custom) to the
   * webview. Call on initial load and whenever `moby.customModels` changes
   * or a per-model API key is set/cleared. Each custom model entry includes
   * a `hasApiKey` flag derived from SecretStorage so the settings popup can
   * reflect key state without exposing the key itself.
   */
  public async sendModelList(): Promise<void> {
    if (!this._view) return;
    const models = getAllRegisteredModels();
    // Pull the per-model overrides bag once. Each entry's effective effort
    // is `override > registry default`. Sending `reasoningEffort` (the
    // effective value) plus `reasoningEffortDefault` (already on the
    // RegisteredModelInfo) lets the selector render the right active pill.
    const modelOptions = vscode.workspace.getConfiguration('moby')
      .get<Record<string, { reasoningEffort?: 'high' | 'max' }>>('modelOptions') ?? {};
    // Decorate custom models with key-presence for the settings popup UI.
    const decorated = await Promise.all(models.map(async (m) => {
      const reasoningEffort = modelOptions[m.id]?.reasoningEffort ?? m.reasoningEffortDefault;
      const withEffort = reasoningEffort
        ? { ...m, reasoningEffort }
        : m;
      if (!m.isCustom) return withEffort;
      const hasApiKey = await this.deepSeekClient.hasPerModelKey(m.id);
      return { ...withEffort, hasApiKey };
    }));
    this._view.webview.postMessage({
      type: 'modelListUpdated',
      models: decorated
    });
  }

  public async acceptActiveDiff(hintUri?: vscode.Uri): Promise<void> {
    const hintedPath = this.diffManager.getActiveDiffFilePath(hintUri);
    const editMode = this.diffManager.currentEditMode;
    logger.info(`[ChatProvider] acceptActiveDiff: filePath=${hintedPath}, session=${this.currentSessionId?.substring(0, 8)}, editMode=${editMode}`);
    const outcome = await this.diffManager.acceptActiveDiff(hintUri);
    const filePath = outcome?.filePath || hintedPath;
    const status = outcome?.status ?? 'applied';
    if (this.currentSessionId && filePath) {
      this.conversationManager.updateFileModifiedStatus(this.currentSessionId, filePath, status, editMode);
    } else {
      logger.warn(`[ChatProvider] acceptActiveDiff: skipped DB update — sessionId=${this.currentSessionId}, filePath=${filePath}`);
    }
  }

  public async rejectActiveDiff(hintUri?: vscode.Uri): Promise<void> {
    const hintedPath = this.diffManager.getActiveDiffFilePath(hintUri);
    const editMode = this.diffManager.currentEditMode;
    logger.info(`[ChatProvider] rejectActiveDiff: filePath=${hintedPath}, session=${this.currentSessionId?.substring(0, 8)}, editMode=${editMode}`);
    const outcome = await this.diffManager.rejectActiveDiff(hintUri);
    const filePath = outcome?.filePath || hintedPath;
    const status = outcome?.status ?? 'rejected';
    if (this.currentSessionId && filePath) {
      this.conversationManager.updateFileModifiedStatus(this.currentSessionId, filePath, status, editMode);
    }
  }

  private async loadCurrentSessionHistory() {
    if (!this.currentSessionId || !this._view) return;
    const currentSession = await this.conversationManager.getSession(this.currentSessionId);
    if (!currentSession) return;

    // Always send session info so webview knows the model (affects edit mode availability)
    let editMode = this.diffManager.currentEditMode;
    if (!supportsManualMode(currentSession.model) && editMode === 'manual') {
      editMode = 'ask';
      this.diffManager.setEditMode(editMode);
    }
    this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });

    // Send the full registered model list so the selector dropdown reflects
    // any `moby.customModels` entries alongside built-ins.
    this.sendModelList();

    // Restore the session's model so the dropdown matches what was used
    if (currentSession.model) {
      if (currentSession.model !== this.deepSeekClient.getModel()) {
        this.deepSeekClient.setModel(currentSession.model);
      }
      // Always send modelChanged — the webview HTML starts with a hardcoded default
      // and needs an explicit message to show the correct model on load.
      this._view.webview.postMessage({ type: 'modelChanged', model: currentSession.model });
    }

    this._view.webview.postMessage({
      type: 'sessionLoaded',
      sessionId: currentSession.id,
      title: currentSession.title,
      model: currentSession.model
    });

    const history = await this.conversationManager.getSessionRichHistory(currentSession.id);
    if (history.length > 0) {
      this._view.webview.postMessage({
        type: 'loadHistory',
        history
      });
    }
  }

  public async loadSession(sessionId: string) {
    // Stop active generation before switching sessions
    if (this.requestOrchestrator.isGenerating()) {
      this.requestOrchestrator.stopGeneration();
    }

    const session = await this.conversationManager.getSession(sessionId);
    logger.info(`[loadSession] session=${sessionId}, found=${!!session}, view=${!!this._view}`);
    if (session && this._view) {
      const oldSessionId = this.currentSessionId;
      this.currentSessionId = session.id;
      await this.saveCurrentSession();
      this.conversationManager.notifySessionsChanged();
      logger.info(`[ChatProvider] switchSession: ${oldSessionId?.substring(0, 8) ?? 'null'} → ${session.id.substring(0, 8)}`);
      logger.sessionSwitch(session.id);

      // Restore the session's model so the dropdown matches what was used
      if (session.model && session.model !== this.deepSeekClient.getModel()) {
        this.deepSeekClient.setModel(session.model);
        this._view.webview.postMessage({ type: 'modelChanged', model: session.model });
      }

      // Send edit mode BEFORE history so webview has correct mode when rendering pending files
      // Use diffManager's live state — config may be stale from async writes
      let editMode = this.diffManager.currentEditMode;
      if (!supportsManualMode(session.model) && editMode === 'manual') {
        editMode = 'ask';
        this.diffManager.setEditMode(editMode);
      }
      this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });

      // Notify webview of loaded session (for SessionActor)
      this._view.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: session.id,
        title: session.title,
        model: session.model
      });

      // Load session messages via loadHistory (clears and loads)
      const history = await this.conversationManager.getSessionRichHistory(sessionId);
      logger.info(`[loadSession] Sending loadHistory: ${history.length} turns, contentIts=${history.filter(t => t.contentIterations).length}`);
      this._view.webview.postMessage({
        type: 'loadHistory',
        history
      });
    }
  }

  private async handleForkSession(atSequence: number): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      const parentSession = await this.conversationManager.getSession(this.currentSessionId);
      const parentTitle = parentSession?.title || 'Unknown';
      const parentId = this.currentSessionId;

      const { session: fork, forkEventType, lastUserMessage } = await this.conversationManager.forkSession(this.currentSessionId, atSequence);
      logger.info(`[ChatProvider] forkSession: ${parentId.substring(0, 8)} → ${fork.id.substring(0, 8)} at seq=${atSequence} (type=${forkEventType})`);
      logger.sessionFork(parentId, fork.id, atSequence);

      await this.loadSession(fork.id);

      // Status panel notification
      this._view?.webview.postMessage({
        type: 'sessionForked',
        forkId: fork.id,
        parentId,
        parentTitle
      });

      // Auto-send: if forking from a user message, automatically get a new response
      if (forkEventType === 'user_message' && lastUserMessage) {
        logger.info(`[ChatProvider] Fork auto-send: re-sending user message (${lastUserMessage.length} chars)`);
        await this.requestOrchestrator.handleMessage(
          lastUserMessage, this.currentSessionId,
          () => this.fileContextManager.getEditorContext(),
          undefined,
          { skipRecord: true }
        );
        // Drain any queued messages
        await this.drainQueue();
      }
    } catch (error: any) {
      logger.error(`[ChatProvider] Fork failed: ${error.message}`);
      this._view?.webview.postMessage({ type: 'error', error: `Fork failed: ${error.message}` });
    }
  }

  // ── Drawing Server ──

  public setDrawingServer(server: DrawingServer): void {
    this.drawingServer = server;
  }

  private async handleStartDrawingServer(): Promise<void> {
    if (!this.drawingServer) return;

    try {
      const result = await this.drawingServer.start();
      const phoneUrl = result.phoneIP
        ? `http://${result.phoneIP}:${result.port}`
        : result.url;

      this.sendDrawingServerState(true, phoneUrl, result.isWSL, result.portForwardCmd);
    } catch (err: any) {
      logger.error(`[ChatProvider] Drawing server start failed: ${err.message}`);
      this._view?.webview.postMessage({ type: 'error', error: `Drawing server failed: ${err.message}` });
      this.sendDrawingServerState(false);
    }
  }

  private async handleStopDrawingServer(): Promise<void> {
    if (!this.drawingServer) return;

    await this.drawingServer.stop();
    this.sendDrawingServerState(false);
  }

  private sendDrawingServerState(running: boolean, url?: string, isWSL?: boolean, portForwardCmd?: string): void {
    let qrMatrix: boolean[][] | undefined;

    if (running && url) {
      try {
        const qr = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
        const size = qr.size;
        qrMatrix = [];
        for (let y = 0; y < size; y++) {
          const row: boolean[] = [];
          for (let x = 0; x < size; x++) {
            row.push(qr.getModule(x, y));
          }
          qrMatrix.push(row);
        }
      } catch (err) {
        logger.warn(`[ChatProvider] QR code generation failed: ${err}`);
      }
    }

    this._view?.webview.postMessage({
      type: 'drawingServerState',
      running,
      url,
      qrMatrix,
      isWSL,
      portForwardCmd,
    });
  }

  private async handleSaveDrawing(imageDataUrl: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`drawing-${Date.now()}.png`),
      filters: { 'PNG Image': ['png'] }
    });

    if (!uri) return;

    try {
      // Strip data URL prefix to get raw base64
      const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      await vscode.workspace.fs.writeFile(uri, buffer);
      vscode.window.showInformationMessage(`Drawing saved to ${uri.fsPath}`);
    } catch (err: any) {
      logger.error(`[ChatProvider] Failed to save drawing: ${err.message}`);
      vscode.window.showErrorMessage(`Failed to save drawing: ${err.message}`);
    }
  }

  // ── HTML Template ──

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'chat.css')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'moby.png')
    );

    // Check if dev mode is enabled (via config or extension development host)
    const config = vscode.workspace.getConfiguration('moby');
    const isDevMode = config.get<boolean>('devMode', false);

    // Dev script is a SEPARATE bundle - only loaded when devMode is true
    // This keeps dev tools completely out of the production chat.js
    const devScriptUri = isDevMode ? webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'dev.js')
    ) : null;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DeepSeek Moby</title>
        <link href="${styleUri}" rel="stylesheet">
      </head>
      <body data-moby-icon="${iconUri}" data-dev-mode="${isDevMode}">
        <div class="chat-container">
          <div class="header">
            <img src="${iconUri}" alt="DeepSeek Moby" class="header-icon">
            <div id="toastContainer" class="toast-container"></div>
            <div class="header-actions">
              <!-- Drawing server - button acts as click target, parent is Shadow DOM host -->
              <div class="drawing-server-selector">
                <button id="drawingServerBtn" class="drawing-server-btn" title="Drawing Pad">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.5 1.5l1 1-9 9-2.5.5.5-2.5 9-9zm-1.4.6l-8.6 8.6-.3 1.3 1.3-.3 8.6-8.6-1-1zM2 13h12v1H2v-1z"/>
                  </svg>
                </button>
                <!-- Shadow DOM popup renders here via DrawingServerShadowActor -->
              </div>
              <!-- Model selector - button acts as click target, parent is Shadow DOM host -->
              <div class="model-selector">
                <button id="modelBtn" class="model-btn" title="Click to change model">
                  <span id="currentModelName">Chat (V3)</span>
                  <span class="model-dropdown-arrow">▼</span>
                </button>
                <!-- Shadow DOM popup renders here via ModelSelectorShadowActor -->
              </div>
              <button id="historyBtn" class="history-btn" title="Chat History">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm-.5 2h1v4.25l2.85 1.65-.5.85L7.5 8.75V4z"/>
                </svg>
              </button>
              ${isDevMode ? `<button id="inspectorBtn" class="inspector-btn" title="UI Inspector">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M14.4 3.6L12.5 5.5a2.5 2.5 0 0 1-3.5 3.5l-5 5a1.4 1.4 0 0 1-2-2l5-5a2.5 2.5 0 0 1 3.5-3.5l1.9-1.9c.2-.2.5-.2.7 0l.3.3c.2.2.2.5 0 .7z"/>
                </svg>
              </button>` : ''}
              <!-- Commands dropdown - button acts as click target, parent is Shadow DOM host -->
              <div class="commands-selector">
                <button id="commandsBtn" class="commands-btn" title="Commands">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12zm-.5-3h1v1h-1v-1zm.5-7a2.5 2.5 0 0 0-2.5 2.5h1A1.5 1.5 0 1 1 8 8c-.55 0-1 .45-1 1v1h1v-.8c0-.11.09-.2.2-.2h.3a2.5 2.5 0 0 0 0-5z"/>
                  </svg>
                </button>
                <!-- Shadow DOM popup renders here via CommandsShadowActor -->
              </div>
              <!-- Settings dropdown - button acts as click target, parent is Shadow DOM host -->
              <div class="settings-selector">
                <button id="settingsBtn" class="settings-btn" title="Settings">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>
                  </svg>
                </button>
                <!-- Shadow DOM popup renders here via SettingsShadowActor -->
              </div>
            </div>
          </div>

          <div id="chatMessages" class="chat-messages"></div>

          <!-- Shadow Actor containers - actors render their own DOM into these -->
          <div class="shadow-actors-container">
            <div class="shadow-actors-row">
              <div id="toolbarContainer" class="toolbar-container"></div>
              <div class="input-wrapper">
                <div id="inputAreaContainer" class="input-area-container"></div>
                <div id="statusPanelContainer" class="status-panel-container"></div>
              </div>
            </div>
          </div>
        </div>

        <script src="${scriptUri}"></script>
        ${devScriptUri ? `<script src="${devScriptUri}"></script>` : ''}
      </body>
      </html>
    `;
  }
}