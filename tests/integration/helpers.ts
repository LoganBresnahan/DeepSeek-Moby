/**
 * Integration Test Helpers
 *
 * Provides utilities for testing the chat.ts message handler integration
 * with actors in a realistic environment.
 */

import { vi } from 'vitest';
import { EventStateManager } from '../../media/state/EventStateManager';
import {
  StreamingActor,
  ScrollActor,
  MessageShadowActor,
  ShellShadowActor,
  ToolCallsShadowActor,
  ThinkingShadowActor,
  PendingChangesShadowActor
} from '../../media/actors';

// VS Code API mock
export interface MockVSCodeAPI {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

export function createMockVSCodeAPI(): MockVSCodeAPI {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn()
  };
}

// Actor system for testing
export interface TestActorSystem {
  manager: EventStateManager;
  streaming: StreamingActor;
  message: MessageShadowActor;
  scroll: ScrollActor;
  shell: ShellShadowActor;
  toolCalls: ToolCallsShadowActor;
  thinking: ThinkingShadowActor;
  pending: PendingChangesShadowActor;
  vscode: MockVSCodeAPI;
  elements: TestDOMElements;
  cleanup: () => void;
  dispatchMessage: (msg: Record<string, unknown>) => void;
  // Mid-stream interrupt support
  sendMessage: (content: string) => void;
  isStreaming: () => boolean;
  getPendingInterruptMessage: () => { content: string; attachments?: unknown[] } | null;
}

export interface TestDOMElements {
  chatMessages: HTMLDivElement;
  messageInput: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  streamingRoot: HTMLDivElement;
}

/**
 * Creates a minimal DOM structure for testing
 */
export function createTestDOM(): TestDOMElements {
  const chatMessages = document.createElement('div');
  chatMessages.id = 'chatMessages';
  document.body.appendChild(chatMessages);

  const messageInput = document.createElement('textarea');
  messageInput.id = 'messageInput';
  document.body.appendChild(messageInput);

  const sendBtn = document.createElement('button');
  sendBtn.id = 'sendBtn';
  sendBtn.style.display = 'flex';
  document.body.appendChild(sendBtn);

  const stopBtn = document.createElement('button');
  stopBtn.id = 'stopBtn';
  stopBtn.style.display = 'none';
  document.body.appendChild(stopBtn);

  const streamingRoot = document.createElement('div');
  streamingRoot.id = 'streamingRoot';
  streamingRoot.style.display = 'none';
  document.body.appendChild(streamingRoot);

  // Note: ShellActor and ToolCallsActor now create their own elements dynamically
  // in chatMessages, so they don't need dedicated containers

  // Add optional elements that chat.ts looks for
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toastContainer';
  document.body.appendChild(toastContainer);

  return {
    chatMessages,
    messageInput,
    sendBtn,
    stopBtn,
    streamingRoot
  };
}

/**
 * Creates a full actor system for integration testing
 * Note: This is async because actors use queueMicrotask for registration
 */
export async function createTestActorSystem(): Promise<TestActorSystem> {
  // Reset static flags for non-shadow actors only
  // Shadow actors use Shadow DOM for style isolation, no global styles to reset
  StreamingActor.resetStylesInjected();
  ScrollActor.resetStylesInjected();

  const vscode = createMockVSCodeAPI();
  const elements = createTestDOM();
  const manager = new EventStateManager();

  // Create actors exactly as chat.ts does
  const streaming = new StreamingActor(manager, elements.streamingRoot);
  const message = new MessageShadowActor(manager, elements.chatMessages);
  const scroll = new ScrollActor(manager, elements.chatMessages);
  // Shadow actors use chatMessages directly and create elements dynamically
  const shell = new ShellShadowActor(manager, elements.chatMessages);
  const toolCalls = new ToolCallsShadowActor(manager, elements.chatMessages);
  const thinking = new ThinkingShadowActor(manager, elements.chatMessages);
  const pending = new PendingChangesShadowActor(manager, elements.chatMessages);

  // Message handler that mirrors chat.ts logic
  let isStreaming = false;
  let currentShellSegmentId: string | null = null;

  // Segment state for interleaving (mirrors chat.ts)
  let currentSegmentContent = '';
  let hasInterleavedContent = false;

  const dispatchMessage = (msg: Record<string, unknown>) => {
    switch (msg.type) {
      // ---- Streaming Messages ----
      case 'startResponse':
        isStreaming = true;
        // Reset segment state for new response
        currentSegmentContent = '';
        hasInterleavedContent = false;

        streaming.startStream(
          (msg.messageId as string) || `msg-${Date.now()}`,
          'deepseek-chat'
        );
        elements.sendBtn.style.display = 'none';
        elements.stopBtn.style.display = 'flex';
        // NOTE: Don't call thinking.startIteration() here - let it be created
        // when actual thinking content arrives (via streaming.thinking or iterationStart).
        break;

      case 'streamToken':
        // Check if we need to start a new segment after tools/shell interrupted
        if (message.needsNewSegment()) {
          message.resumeWithNewSegment();
          currentSegmentContent = '';
        }

        // Track content for the current segment
        currentSegmentContent += msg.token as string;
        message.updateCurrentSegmentContent(currentSegmentContent);

        streaming.handleContentChunk(msg.token as string);
        break;

      case 'streamReasoning':
        // Finalize current text segment before thinking content
        if (message.isStreaming() && !hasInterleavedContent) {
          message.finalizeCurrentSegment();
          hasInterleavedContent = true;
        }
        streaming.handleThinkingChunk(msg.token as string);
        break;

      case 'iterationStart':
        // Finalize current text segment before thinking iteration starts
        if (message.isStreaming() && !hasInterleavedContent) {
          message.finalizeCurrentSegment();
          hasInterleavedContent = true;
        }
        thinking.startIteration();
        break;

      case 'endResponse':
        isStreaming = false;
        streaming.endStream();
        elements.sendBtn.style.display = 'flex';
        elements.stopBtn.style.display = 'none';
        // Finalize the streaming message
        // IMPORTANT: Only update content if we didn't have interleaved content.
        // When interleaved, the content is already displayed in continuation segments.
        if (msg.message) {
          const msgData = msg.message as { content: string; reasoning?: string };
          message.finalizeLastMessage({
            content: hasInterleavedContent ? undefined : msgData.content,
            thinking: msgData.reasoning
          });
        }
        // Reset segment state
        currentSegmentContent = '';
        hasInterleavedContent = false;
        thinking.completeIteration();
        break;

      // ---- Shell Messages ----
      case 'shellExecuting':
        if (msg.commands && Array.isArray(msg.commands)) {
          // Finalize current text segment before showing shell commands
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }

          const segmentId = shell.createSegment(msg.commands as string[]);
          currentShellSegmentId = segmentId;
          shell.startSegment(segmentId);
        }
        break;

      case 'shellResults':
        if (msg.results && Array.isArray(msg.results) && currentShellSegmentId) {
          shell.setResults(
            currentShellSegmentId,
            (msg.results as Array<{ output?: string; success?: boolean; exitCode?: number }>).map(
              result => ({
                // Extension sends 'success' boolean directly, but tests use exitCode for clarity
                success: result.success !== undefined ? result.success : (result.exitCode === 0),
                output: result.output
              })
            )
          );
          currentShellSegmentId = null;
        }
        break;

      // ---- Tool Calls Messages ----
      case 'toolCallsStart':
        if (msg.tools && Array.isArray(msg.tools)) {
          // Finalize current text segment before showing tools
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }

          toolCalls.startBatch(
            (msg.tools as Array<{ name: string; detail: string }>).map(t => ({
              name: t.name,
              detail: t.detail
            }))
          );
        }
        break;

      case 'toolCallUpdate':
        if (msg.index !== undefined && msg.status) {
          const currentCalls = toolCalls.getCalls();
          if (currentCalls[msg.index as number]) {
            toolCalls.updateBatch(
              currentCalls.map((t, i) => ({
                name: t.name,
                detail: t.detail,
                status:
                  i === (msg.index as number)
                    ? (msg.status as 'pending' | 'running' | 'done' | 'error')
                    : t.status
              }))
            );
          }
        }
        break;

      case 'toolCallsUpdate':
        if (msg.tools && Array.isArray(msg.tools)) {
          toolCalls.updateBatch(
            (
              msg.tools as Array<{ name: string; detail: string; status?: string }>
            ).map(t => ({
              name: t.name,
              detail: t.detail,
              status: t.status as 'pending' | 'running' | 'done' | 'error' | undefined
            }))
          );
        }
        break;

      case 'toolCallsEnd':
        toolCalls.complete();
        break;

      // ---- Pending Files Messages ----
      case 'pendingFileAdd':
        if (msg.filePath) {
          // Finalize current text segment before showing pending files
          if (message.isStreaming()) {
            message.finalizeCurrentSegment();
            hasInterleavedContent = true;
          }
          pending.addFile(
            msg.filePath as string,
            msg.diffId as string | undefined,
            msg.iteration as number | undefined
          );
        }
        break;

      case 'pendingFileUpdate':
        if (msg.fileId && msg.status) {
          pending.updateFile(msg.fileId as string, {
            status: msg.status as 'pending' | 'applied' | 'rejected' | 'superseded'
          });
        }
        break;

      case 'pendingFileAccept':
        if (msg.fileId) {
          pending.acceptFile(msg.fileId as string);
        }
        break;

      case 'pendingFileReject':
        if (msg.fileId) {
          pending.rejectFile(msg.fileId as string);
        }
        break;

      case 'pendingFilesSetEditMode':
        if (msg.mode && ['manual', 'ask', 'auto'].includes(msg.mode as string)) {
          pending.setEditMode(msg.mode as 'manual' | 'ask' | 'auto');
        }
        break;

      // ---- History Messages ----
      case 'addMessage':
        if ((msg.message as { role: string })?.role === 'user') {
          const m = msg.message as { content: string; files?: string[] };
          message.addUserMessage(m.content, m.files);
        } else if ((msg.message as { role: string })?.role === 'assistant') {
          const m = msg.message as { content: string; reasoning?: string };
          message.addAssistantMessage(m.content, { thinking: m.reasoning });
        }
        break;

      case 'loadHistory':
        message.clear();
        if (msg.history && Array.isArray(msg.history)) {
          (
            msg.history as Array<{
              role: string;
              content: string;
              files?: string[];
              reasoning_content?: string;
            }>
          ).forEach(m => {
            if (m.role === 'user') {
              message.addUserMessage(m.content, m.files);
            } else if (m.role === 'assistant') {
              message.addAssistantMessage(m.content, {
                thinking: m.reasoning_content
              });
            }
          });
        }
        break;

      case 'clearChat':
        // Clear all actors when chat is cleared (matches chat.ts)
        message.clear();
        toolCalls.clear();
        shell.clear();
        thinking.clear();
        pending.clear();
        currentShellSegmentId = null;
        currentSegmentContent = '';
        hasInterleavedContent = false;
        break;

      case 'generationStopped':
        isStreaming = false;
        elements.sendBtn.style.display = 'flex';
        elements.stopBtn.style.display = 'none';
        elements.sendBtn.classList.remove('interrupting');

        // Check if there's a pending message from mid-stream interrupt
        if (pendingInterruptMessage) {
          const { content } = pendingInterruptMessage;
          pendingInterruptMessage = null;

          // Send the queued message (simulates the setTimeout delay in chat.ts)
          setTimeout(() => {
            doSendMessage(content);
          }, 10);
        }
        break;
    }
  };

  // Mid-stream interrupt state
  let pendingInterruptMessage: { content: string; attachments?: unknown[] } | null = null;

  /**
   * Actually send a message (used by both normal flow and interrupt flow)
   */
  const doSendMessage = (content: string) => {
    // Add user message to UI
    message.addUserMessage(content);

    // Clear input
    elements.messageInput.value = '';

    // Notify backend (mock)
    vscode.postMessage({
      type: 'sendMessage',
      message: content
    });
  };

  /**
   * Send a message - mirrors chat.ts sendMessage logic with interrupt support
   */
  const sendMessage = (content: string) => {
    if (!content.trim()) return;

    // If currently streaming, interrupt and queue the message
    if (isStreaming) {
      const alreadyInterrupting = pendingInterruptMessage !== null;

      // Store message to send after generation stops
      pendingInterruptMessage = { content };

      // Clear input immediately
      elements.messageInput.value = '';

      // Only send stop request if we haven't already
      if (!alreadyInterrupting) {
        vscode.postMessage({ type: 'stopGeneration' });
        elements.sendBtn.classList.add('interrupting');
      }
      return;
    }

    // Normal flow - not streaming
    doSendMessage(content);
  };

  const cleanup = () => {
    streaming.destroy();
    message.destroy();
    scroll.destroy();
    shell.destroy();
    toolCalls.destroy();
    thinking.destroy();
    pending.destroy();
    document.body.innerHTML = '';
  };

  // Wait for microtasks to complete (actor registration uses queueMicrotask)
  await new Promise<void>(resolve => queueMicrotask(resolve));

  return {
    manager,
    streaming,
    message,
    scroll,
    shell,
    toolCalls,
    thinking,
    pending,
    vscode,
    elements,
    cleanup,
    dispatchMessage,
    // Mid-stream interrupt support
    sendMessage,
    isStreaming: () => isStreaming,
    getPendingInterruptMessage: () => pendingInterruptMessage
  };
}

/**
 * Wait for microtasks to complete (actor registration uses queueMicrotask)
 */
export function waitForMicrotasks(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve));
}

/**
 * Wait for pub/sub propagation
 * Note: Also waits for microtasks first to ensure actors are registered
 */
export async function waitForPubSub(ms = 10): Promise<void> {
  // First wait for any pending microtasks (like actor registration)
  await waitForMicrotasks();
  // Then wait the specified time for pub/sub propagation
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get all text content from an element including Shadow DOM content
 * Shadow actors render inside shadow roots, so regular textContent won't work
 */
export function getShadowTextContent(element: Element): string {
  let text = '';

  // Get direct text content (text nodes only)
  element.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  });

  // Recursively get content from child elements (including shadow roots)
  element.querySelectorAll('*').forEach(child => {
    // If element has a shadow root, get content from it
    if (child.shadowRoot) {
      text += getShadowTextContent(child.shadowRoot as unknown as Element);
    }
    // Get text nodes directly in this element
    child.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
      }
    });
  });

  return text;
}

/**
 * Query selector that searches inside shadow roots
 */
export function queryShadowSelector(root: Element | Document, selector: string): Element | null {
  // First try direct query
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // Search in shadow roots
  const elements = root.querySelectorAll('*');
  for (const el of elements) {
    if (el.shadowRoot) {
      const found = el.shadowRoot.querySelector(selector);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Query all matching selectors including inside shadow roots
 */
export function queryShadowSelectorAll(root: Element | Document, selector: string): Element[] {
  const results: Element[] = [];

  // Get direct matches
  root.querySelectorAll(selector).forEach(el => results.push(el));

  // Search in shadow roots
  root.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) {
      el.shadowRoot.querySelectorAll(selector).forEach(found => results.push(found));
    }
  });

  return results;
}

/**
 * Simulate a complete streaming response
 */
export async function simulateStreamingResponse(
  system: TestActorSystem,
  options: {
    messageId?: string;
    isReasoner?: boolean;
    tokens?: string[];
    reasoningTokens?: string[];
    finalContent?: string;
    finalReasoning?: string;
  } = {}
): Promise<void> {
  const {
    messageId = `msg-${Date.now()}`,
    isReasoner = false,
    tokens = ['Hello', ' ', 'world!'],
    reasoningTokens = [],
    finalContent = tokens.join(''),
    finalReasoning
  } = options;

  // Start
  system.dispatchMessage({
    type: 'startResponse',
    messageId,
    isReasoner
  });
  await waitForPubSub();

  // Stream tokens
  for (const token of tokens) {
    system.dispatchMessage({ type: 'streamToken', token });
    await waitForPubSub(5);
  }

  // Stream reasoning tokens if reasoner mode
  if (isReasoner && reasoningTokens.length > 0) {
    for (const token of reasoningTokens) {
      system.dispatchMessage({ type: 'streamReasoning', token });
      await waitForPubSub(5);
    }
  }

  // End
  system.dispatchMessage({
    type: 'endResponse',
    message: {
      content: finalContent,
      reasoning: finalReasoning
    }
  });
  await waitForPubSub();
}

/**
 * Simulate shell command execution
 */
export async function simulateShellExecution(
  system: TestActorSystem,
  commands: string[],
  results: Array<{ output?: string; exitCode: number }>
): Promise<void> {
  system.dispatchMessage({
    type: 'shellExecuting',
    commands
  });
  await waitForPubSub();

  system.dispatchMessage({
    type: 'shellResults',
    results
  });
  await waitForPubSub();
}

/**
 * Simulate tool calls flow
 */
export async function simulateToolCalls(
  system: TestActorSystem,
  tools: Array<{ name: string; detail: string }>,
  statuses: Array<'pending' | 'running' | 'done' | 'error'>
): Promise<void> {
  // Start batch
  system.dispatchMessage({
    type: 'toolCallsStart',
    tools
  });
  await waitForPubSub();

  // Update each tool status
  for (let i = 0; i < statuses.length; i++) {
    system.dispatchMessage({
      type: 'toolCallUpdate',
      index: i,
      status: statuses[i]
    });
    await waitForPubSub(5);
  }

  // Complete
  system.dispatchMessage({ type: 'toolCallsEnd' });
  await waitForPubSub();
}
