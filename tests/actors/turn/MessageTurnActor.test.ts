/**
 * Tests for MessageTurnActor
 *
 * Tests the 1B architecture: one actor per turn with multiple shadow containers.
 * Validates pooling lifecycle, content rendering, and interleaving behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageTurnActor } from '../../../media/actors/turn/MessageTurnActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('MessageTurnActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageTurnActor;

  /**
   * Helper to find containers by type.
   */
  function findContainers(type: 'text' | 'thinking' | 'tools' | 'shell' | 'pending' | 'approval'): HTMLElement[] {
    return Array.from(element.querySelectorAll(`[data-actor="turn"].${type}-container`));
  }

  /**
   * Helper to query inside a container's shadow DOM.
   */
  function queryInShadow(container: HTMLElement, selector: string): Element | null {
    return container.shadowRoot?.querySelector(selector) ?? null;
  }

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'chat-turn';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  // ============================================
  // Pool Lifecycle Tests
  // ============================================

  describe('Pool lifecycle', () => {
    it('marks parent with data-interleaved-actor attribute', () => {
      actor = new MessageTurnActor({ manager, element });
      expect(element.getAttribute('data-interleaved-actor')).toBe('turn');
    });

    it('creates no containers initially', () => {
      actor = new MessageTurnActor({ manager, element });
      expect(element.children.length).toBe(0);
    });

    it('bind sets turn identity', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({
        turnId: 'turn-123',
        role: 'assistant',
        timestamp: Date.now()
      });

      expect(actor.turnId).toBe('turn-123');
      expect(actor.role).toBe('assistant');
      expect(actor.isAssistant).toBe(true);
      expect(actor.isUser).toBe(false);
      expect(element.getAttribute('data-turn-id')).toBe('turn-123');
      expect(element.getAttribute('data-role')).toBe('assistant');
    });

    it('reset clears all state', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({
        turnId: 'turn-123',
        role: 'assistant',
        timestamp: Date.now()
      });

      // Add some content. Activity indicator now lives in the input-bar
      // StatusPanelShadowActor (driven by `activity.label` publishes), not
      // in the turn DOM — so the turn has just header + text + thinking.
      actor.startStreaming();
      actor.createTextSegment('Hello');
      actor.startThinkingIteration();

      expect(element.children.length).toBe(3); // header + text + thinking

      // Reset
      actor.reset();

      expect(actor.turnId).toBeNull();
      expect(actor.role).toBeNull();
      expect(element.children.length).toBe(0);
      expect(element.hasAttribute('data-turn-id')).toBe(false);
    });

    it('can be rebound after reset', () => {
      actor = new MessageTurnActor({ manager, element });

      // First binding
      actor.bind({ turnId: 'turn-1', role: 'user', timestamp: Date.now() });
      actor.createTextSegment('First message');

      // Reset and rebind
      actor.reset();
      actor.bind({ turnId: 'turn-2', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('Second message');

      expect(actor.turnId).toBe('turn-2');
      expect(actor.role).toBe('assistant');
      expect(element.children.length).toBe(1);
    });
  });

  // ============================================
  // Text Segment Tests
  // ============================================

  describe('Text segments', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'user', timestamp: Date.now() });
    });

    it('creates text segment with shadow DOM', () => {
      actor.createTextSegment('Hello world');

      const containers = findContainers('text');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('renders user message correctly', () => {
      actor.createTextSegment('Hello world');

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Hello world');

      const divider = queryInShadow(containers[0], '.message-divider-label');
      expect(divider?.textContent).toBe('YOU');
    });

    it('renders assistant message correctly', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-2', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('Hello from AI');

      const containers = findContainers('text');
      const divider = queryInShadow(containers[0], '.message-divider-label');
      expect(divider?.textContent).toBe('MOBY');
    });

    it('updates text content', () => {
      actor.createTextSegment('Initial');
      actor.updateTextContent('Updated content');

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Updated content');
      expect(actor.getCurrentSegmentContent()).toBe('Updated content');
    });

    it('lazy creates segment on updateTextContent', () => {
      expect(element.children.length).toBe(0);

      actor.updateTextContent('Lazy created');

      const containers = findContainers('text');
      expect(containers.length).toBe(1);
      const content = queryInShadow(containers[0], '.content');
      expect(content?.textContent).toContain('Lazy created');
    });

    // ── HTML escape (purple-anchor regression) ─────────────────────────
    // V4-thinking sometimes emits raw HTML in prose. Without escaping,
    // `<a href>...</a>` rendered as real anchors → blue underline styling
    // → "purple highlighting" bug. formatContent must neutralize HTML in
    // prose while preserving fenced code blocks intact.

    it('escapes raw <a> tags emitted in assistant prose', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-esc-a', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('Visit <a href="">How it works:</a> for details');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      // No real anchor element should be created.
      expect(content?.querySelector('a')).toBeNull();
      // Raw text should appear as plain prose with the tag visible.
      expect(content?.textContent).toContain('<a href="">How it works:</a>');
    });

    it('escapes <u>/<font>/<script> tags in prose', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-esc-tags', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('plain <u>under</u> and <font color="red">red</font> and <script>alert(1)</script>');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.querySelector('u')).toBeNull();
      expect(content?.querySelector('font')).toBeNull();
      expect(content?.querySelector('script')).toBeNull();
      expect(content?.textContent).toContain('<u>under</u>');
      expect(content?.textContent).toContain('<script>alert(1)</script>');
    });

    it('preserves markdown bold/italic/inline-code while escaping prose', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-md', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('a **bold** and *italic* and `code` plus <a>raw</a>');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      // Markdown still becomes proper elements.
      expect(content?.querySelector('strong')?.textContent).toBe('bold');
      expect(content?.querySelector('em')?.textContent).toBe('italic');
      expect(content?.querySelector('code.inline-code')?.textContent).toBe('code');
      // Raw <a> tag stays as text.
      expect(content?.querySelector('a')).toBeNull();
      expect(content?.textContent).toContain('<a>raw</a>');
    });

    it('preserves fenced code blocks across the escape pass', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-fence', role: 'assistant', timestamp: Date.now() });
      const md = 'before <a>raw</a>\n\n```bash\nls -la\n```\n\nafter';
      actor.createTextSegment(md);
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      // Code block rendered as a real .code-block.
      expect(content?.querySelector('.code-block')).not.toBeNull();
      expect(content?.textContent).toContain('ls -la');
      // Prose anchor stays escaped.
      expect(content?.querySelector('a')).toBeNull();
      expect(content?.textContent).toContain('<a>raw</a>');
    });

    // ── Linkify regression — fuzzy mode disabled ───────────────────────
    // markdown-it via linkify-it would otherwise auto-link any string
    // matching `name.tld` because `.py`, `.io`, `.sh`, `.rs`, `.dev`, `.co`,
    // `.ai` are all real ccTLDs. Users typing file names or symbol paths in
    // chat would see them rendered as live links pointing at speculative
    // URLs. Fuzzy modes disabled in MessageTurnActor; explicit URLs with a
    // scheme still autolink.

    it('does NOT autolink bare file-name patterns that look like domains', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-no-fuzzy', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('can you give me a quick example what a python tictactoe.py would look like?');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.querySelector('a')).toBeNull();
      expect(content?.textContent).toContain('tictactoe.py');
    });

    it('does NOT autolink other common file/symbol patterns', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-no-fuzzy-2', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('check server.io, build.sh, crate.rs, main.dev, module.co — none should link');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      expect(content?.querySelector('a')).toBeNull();
    });

    it('still autolinks explicit https:// URLs', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-explicit-url', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('see https://example.com for details');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      const anchor = content?.querySelector('a');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe('https://example.com');
    });

    it('renders explicit markdown links regardless of fuzzy setting', () => {
      actor.reset();
      actor.bind({ turnId: 'turn-md-link', role: 'assistant', timestamp: Date.now() });
      actor.createTextSegment('open [the file](src/foo.ts) to see more');
      actor.endStreaming();

      const containers = findContainers('text');
      const content = queryInShadow(containers[0], '.content');
      const anchor = content?.querySelector('a');
      expect(anchor).not.toBeNull();
      expect(anchor?.getAttribute('href')).toBe('src/foo.ts');
      expect(anchor?.textContent).toBe('the file');
    });
  });

  // ============================================
  // Streaming Tests
  // ============================================

  describe('Streaming', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('startStreaming sets streaming state', () => {
      actor.startStreaming();
      expect(actor.isStreaming()).toBe(true);
    });

    it('startStreaming renders role header + publishes waiting-state activity', () => {
      expect(element.children.length).toBe(0);
      actor.startStreaming();
      // Role header is the only child. Activity indicator lives in the
      // status-panel actor (input bar) and is driven via publish to the
      // shared EventStateManager.
      expect(element.children.length).toBe(1);
      const header = element.children[0] as HTMLElement;
      expect(header.classList.contains('header-container')).toBe(true);
      expect(header.classList.contains('assistant')).toBe(true);
      expect(actor.getActivityLabel()).toBe('Waiting for response…');
      expect(manager.getState('activity.streaming')).toBe(true);
      expect(manager.getState('activity.label')).toBe('Waiting for response…');
    });

    it('startStreaming role header is idempotent with subsequent content', () => {
      actor.startStreaming();
      expect(element.children.length).toBe(1); // header only
      actor.createTextSegment('Hello');
      // Header + text segment (not two headers). Activity indicator is no
      // longer in the turn DOM — it's published to the status-panel actor.
      expect(element.children.length).toBe(2);
      expect(element.querySelector('.header-container')).not.toBeNull();
      expect(element.querySelector('.text-container')).not.toBeNull();
      expect(element.querySelectorAll('.header-container').length).toBe(1);
    });

    it('endStreaming clears streaming state', () => {
      actor.startStreaming();
      actor.endStreaming();
      expect(actor.isStreaming()).toBe(false);
    });

    it('streaming segment has streaming class', () => {
      actor.startStreaming();
      actor.createTextSegment('Streaming...');

      const containers = findContainers('text');
      expect(containers[0].classList.contains('streaming')).toBe(true);
    });

    it('removes streaming class on endStreaming', () => {
      actor.startStreaming();
      actor.createTextSegment('Content');
      actor.endStreaming();

      const containers = findContainers('text');
      expect(containers[0].classList.contains('streaming')).toBe(false);
    });

    it('strips unclosed fence content from text segment (unified indicator owns the label)', () => {
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Here is the code:\n```bash\n');

      const container = findContainers('text')[0];
      // No inline placeholder anywhere
      expect(queryInShadow(container, '.code-generating')).toBeNull();
      // Fence content stripped from rendered text
      const contentEl = queryInShadow(container, '.content');
      expect(contentEl?.textContent).toContain('Here is the code:');
      expect(contentEl?.textContent).not.toContain('```');
      // Unified activity line carries the signal
      expect(actor.getActivityLabel()).toBe('Generating code...');
    });

    it('completeCurrentTextSegment pops the code-block activity frame', () => {
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Here is the code:\n```bash\n');
      expect(actor.getActivityLabel()).toBe('Generating code...');

      // Segment finalizes mid-turn (e.g., right before a <shell> executes).
      // The code-block frame pops; with no specific activity on the stack
      // and text streaming, the indicator hides (response text itself is
      // visible right below it — no redundant label needed).
      actor.setTextActive(true);
      actor.completeCurrentTextSegment();

      expect(actor.isStreaming()).toBe(true);
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('completeCurrentTextSegment preserves text content', () => {
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Some complete prose.');
      actor.completeCurrentTextSegment();

      const container = findContainers('text')[0];
      const contentEl = queryInShadow(container, '.content');
      expect(contentEl?.textContent).toContain('Some complete prose.');
    });

    it('completeCurrentTextSegment removes streaming class on the completed segment', () => {
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Done segment.');
      actor.completeCurrentTextSegment();

      const container = findContainers('text')[0];
      expect(container.classList.contains('streaming')).toBe(false);
    });

    it('new text segment with unclosed fence after finalize re-pushes code-block frame', () => {
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('First segment done.');
      actor.completeCurrentTextSegment();
      expect(actor.getActivityLabel()).toBeNull();

      // New segment created for content after a shell or tool call
      actor.createTextSegment();
      actor.updateTextContent('Next:\n```typescript\n');

      const containers = findContainers('text');
      expect(containers.length).toBe(2);
      // Neither segment carries an inline placeholder (concept retired)
      expect(queryInShadow(containers[0], '.code-generating')).toBeFalsy();
      expect(queryInShadow(containers[1], '.code-generating')).toBeFalsy();
      // Unified indicator reflects the new fence
      expect(actor.getActivityLabel()).toBe('Generating code...');
    });

    it('completeCurrentTextSegment is a safe no-op with no current segment', () => {
      actor.startStreaming();
      expect(() => actor.completeCurrentTextSegment()).not.toThrow();
    });

    it('inline fence (prose:```css with no newline) is detected as a code block', () => {
      // R1 sometimes emits "prose:```css\ncontent\n```" on one line — the
      // CommonMark parser needs fences at column 0, so the normalization
      // inserts a newline so extractCodeBlocks can find it.
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Let me create:```css\n.a { color: red; }\n```\n');
      actor.completeCurrentTextSegment();

      const container = findContainers('text')[0];
      const codeBlock = queryInShadow(container, '.code-block');
      expect(codeBlock).toBeTruthy();
      // The raw fence characters should be gone from the text too
      const contentEl = queryInShadow(container, '.content');
      expect(contentEl?.textContent).not.toContain('```');
    });

    it('unclosed fence is stripped on finalize to prevent raw-backtick leak', () => {
      // PR1 regression scenario: segment finalizes while a fence is still
      // open (user aborts mid-stream, or orphan fence survives normalization).
      // The raw `\`\`\`css\n# File: style.css\n<<<<<<< SEARCH ...` content
      // would leak as prose without this strip.
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('Leading prose.\n```css\n# File: style.css\n<<<<<<< SEARCH\n/* a */\n');
      actor.completeCurrentTextSegment();

      const container = findContainers('text')[0];
      const contentEl = queryInShadow(container, '.content');
      expect(contentEl?.textContent).toContain('Leading prose.');
      // None of the raw content should survive
      expect(contentEl?.textContent).not.toContain('```');
      expect(contentEl?.textContent).not.toContain('<<<<<<< SEARCH');
      expect(contentEl?.textContent).not.toContain('# File: style.css');
    });

    it('complete code block still renders as dropdown after finalize', () => {
      // Opposite side of the same coin — when the fence IS closed, the
      // block renders normally even though placeholder-mode is off.
      actor.startStreaming();
      actor.createTextSegment();
      actor.updateTextContent('```typescript\nconst x = 1;\n```\n');
      actor.completeCurrentTextSegment();

      const container = findContainers('text')[0];
      expect(queryInShadow(container, '.code-block')).toBeTruthy();
    });
  });

  // ============================================
  // Activity Indicator Tests
  // ============================================

  describe('Activity indicator', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    // Activity indicator now lives in the StatusPanelShadowActor (input bar),
    // driven by `activity.label` and `activity.streaming` publishes on the
    // shared EventStateManager. Tests assert on those state keys instead of
    // probing turn-local DOM.

    it('no activity published before startStreaming', () => {
      expect(actor.getActivityLabel()).toBeNull();
      expect(manager.getState('activity.streaming')).toBeFalsy();
    });

    it('startStreaming publishes waiting-state activity', () => {
      actor.startStreaming();
      expect(actor.getActivityLabel()).toBe('Waiting for response…');
      expect(manager.getState('activity.streaming')).toBe(true);
      expect(manager.getState('activity.label')).toBe('Waiting for response…');
    });

    it('text-active flips activity out of waiting-state into bare-whale', () => {
      actor.startStreaming();
      expect(actor.getActivityLabel()).toBe('Waiting for response…');
      actor.setTextActive(true);
      // First content signal has arrived — label clears, but streaming flag
      // stays on so the moby keeps spurting silently.
      expect(actor.getActivityLabel()).toBeNull();
      expect(manager.getState('activity.label')).toBeNull();
      expect(manager.getState('activity.streaming')).toBe(true);
    });

    it('pushed activity shows even when text is streaming', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.pushActivity('thinking', 'Thinking...');
      expect(actor.getActivityLabel()).toBe('Thinking...');
    });

    it('most recent push wins (shell over thinking)', () => {
      actor.startStreaming();
      actor.pushActivity('thinking', 'Thinking...');
      actor.pushActivity('shell', 'Running ls');
      expect(actor.getActivityLabel()).toBe('Running ls');
    });

    it('pop restores the underlying frame', () => {
      actor.startStreaming();
      actor.pushActivity('thinking', 'Thinking...');
      actor.pushActivity('shell', 'Running ls');
      actor.popActivity('shell');
      expect(actor.getActivityLabel()).toBe('Thinking...');
    });

    it('pop with empty stack hides the indicator even if text is active', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.pushActivity('shell', 'Running ls');
      actor.popActivity('shell');
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('pushActivity same kind updates label in place (no duplicates)', () => {
      actor.startStreaming();
      actor.pushActivity('shell', 'Running ls');
      actor.pushActivity('shell', 'Running npm test');
      expect(actor.getActivityLabel()).toBe('Running npm test');
      actor.popActivity('shell');
      // Stack had only one frame; one pop clears it, indicator hides
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('popActivity for missing kind is a no-op', () => {
      actor.startStreaming();
      actor.pushActivity('thinking', 'Thinking...');
      expect(() => actor.popActivity('shell')).not.toThrow();
      expect(actor.getActivityLabel()).toBe('Thinking...');
    });

    it('clearActivity empties stack and text state', () => {
      actor.startStreaming();
      actor.pushActivity('thinking', 'Thinking...');
      actor.setTextActive(true);
      actor.clearActivity();
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('endStreaming clears activity publish state', () => {
      actor.startStreaming();
      actor.pushActivity('thinking', 'Thinking...');
      expect(manager.getState('activity.label')).toBe('Thinking...');
      actor.endStreaming();
      expect(actor.getActivityLabel()).toBeNull();
      expect(manager.getState('activity.streaming')).toBe(false);
      expect(manager.getState('activity.label')).toBeNull();
    });

    it('reset clears activity state', () => {
      actor.startStreaming();
      actor.pushActivity('shell', 'Running ls');
      actor.reset();
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('hidden when not streaming even if frames exist', () => {
      actor.pushActivity('shell', 'Running ls');
      // Without isStreaming=true, getActivityLabel returns null even though
      // the stack has a frame. The status-panel sees `activity.label = null`
      // and clears its label slot.
      expect(actor.getActivityLabel()).toBeNull();
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('unclosed fence pushes a code-block frame ("Writing X...")', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      expect(actor.getActivityLabel()).toBeNull();

      actor.createTextSegment();
      actor.updateTextContent('Here:\n```typescript\n# File: src/game.ts\n');
      expect(actor.getActivityLabel()).toBe('Writing src/game.ts...');
    });

    it('fence close pops the code-block frame and the indicator hides', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.createTextSegment();
      actor.updateTextContent('Here:\n```typescript\n');
      expect(actor.getActivityLabel()).toBe('Generating code...');

      actor.updateTextContent('Here:\n```typescript\nconst x = 1;\n```\n');
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('higher-priority frames beat the code-block frame', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.createTextSegment();
      actor.updateTextContent('```bash\n');
      expect(actor.getActivityLabel()).toBe('Generating code...');

      actor.pushActivity('shell', 'Running ls');
      expect(actor.getActivityLabel()).toBe('Running ls');

      actor.popActivity('shell');
      expect(actor.getActivityLabel()).toBe('Generating code...');
    });

    it('completeCurrentTextSegment pops the code-block frame', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.createTextSegment();
      actor.updateTextContent('Here:\n```typescript\n');
      expect(actor.getActivityLabel()).toBe('Generating code...');

      actor.completeCurrentTextSegment();
      expect(actor.getActivityLabel()).toBeNull();
    });
  });

  // ============================================
  // Thinking Tests
  // ============================================

  describe('Thinking iterations', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates thinking container with shadow DOM', () => {
      actor.startThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('returns iteration index', () => {
      const idx1 = actor.startThinkingIteration();
      const idx2 = actor.startThinkingIteration();

      expect(idx1).toBe(1);
      expect(idx2).toBe(2);
    });

    it('updates thinking content', () => {
      actor.startThinkingIteration();
      actor.updateThinkingContent('Thinking deeply...');

      const containers = findContainers('thinking');
      const body = queryInShadow(containers[0], '.thinking-body');
      expect(body?.textContent).toContain('Thinking deeply...');
    });

    it('completes thinking iteration', () => {
      actor.startThinkingIteration();
      actor.completeThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers[0].classList.contains('streaming')).toBe(false);
    });

    it('toggle expands/collapses thinking', () => {
      actor.startThinkingIteration();

      const containers = findContainers('thinking');
      expect(containers[0].classList.contains('expanded')).toBe(false);

      actor.toggleThinkingExpanded(1);
      expect(containers[0].classList.contains('expanded')).toBe(true);

      actor.toggleThinkingExpanded(1);
      expect(containers[0].classList.contains('expanded')).toBe(false);
    });
  });

  // ============================================
  // Tool Calls Tests
  // ============================================

  describe('Tool calls', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates tool batch container', () => {
      actor.startToolBatch([
        { name: 'read_file', detail: 'file.ts' },
        { name: 'write_file', detail: 'output.ts' }
      ]);

      const containers = findContainers('tools');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('renders tool items', () => {
      actor.startToolBatch([
        { name: 'read_file', detail: 'file.ts' }
      ]);

      const containers = findContainers('tools');
      const items = containers[0].shadowRoot?.querySelectorAll('.tool-item');
      expect(items?.length).toBe(1);
    });

    it('updates tool status', () => {
      actor.startToolBatch([{ name: 'test_tool', detail: 'test' }]);
      actor.updateTool(0, 'done');

      const containers = findContainers('tools');
      const item = queryInShadow(containers[0], '.tool-item');
      expect(item?.getAttribute('data-status')).toBe('done');
    });

    it('completes tool batch', () => {
      actor.startToolBatch([{ name: 'test', detail: '' }]);
      actor.completeToolBatch();

      const containers = findContainers('tools');
      expect(containers[0].classList.contains('complete')).toBe(true);
    });
  });

  // ============================================
  // Shell Tests
  // ============================================

  describe('Shell segments', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates shell container', () => {
      actor.createShellSegment([{ command: 'ls -la' }]);

      const containers = findContainers('shell');
      expect(containers.length).toBe(1);
    });

    it('starts shell segment (marks as running)', () => {
      const segmentId = actor.createShellSegment([{ command: 'npm test' }]);
      actor.startShellSegment(segmentId);

      const containers = findContainers('shell');
      const item = queryInShadow(containers[0], '.shell-item');
      expect(item?.getAttribute('data-status')).toBe('running');
    });

    it('sets shell results', () => {
      const segmentId = actor.createShellSegment([{ command: 'echo hello' }]);
      actor.startShellSegment(segmentId);
      actor.setShellResults(segmentId, [{ output: 'hello', success: true }]);

      const containers = findContainers('shell');
      expect(containers[0].classList.contains('complete')).toBe(true);

      const output = queryInShadow(containers[0], '.shell-output');
      expect(output?.textContent).toContain('hello');
    });
  });

  // ============================================
  // Pending Files Tests
  // ============================================

  describe('Pending files', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('creates pending container when file added', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(1);
    });

    it('hides container in manual mode', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(true);
    });

    it('shows container in ask mode', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(false);
    });

    it('shows applied files in manual mode (history restoration)', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers[0].hasAttribute('hidden')).toBe(false);
    });

    it('shows container as Modified Files when manual mode has applied files', () => {
      actor.setEditMode('manual');
      actor.addPendingFile({ filePath: '/path/to/file.ts', status: 'applied' });

      const containers = findContainers('pending');
      const title = queryInShadow(containers[0], '.pending-title');
      expect(title?.textContent).toBe('Modified Files');
    });

    it('updates pending status', () => {
      actor.setEditMode('ask');
      const fileId = actor.addPendingFile({ filePath: '/path/to/file.ts' });
      actor.updatePendingStatus(fileId, 'applied');

      const containers = findContainers('pending');
      const item = queryInShadow(containers[0], '.pending-item');
      expect(item?.getAttribute('data-status')).toBe('applied');
    });

    it('updates pending status by diffId fallback', () => {
      actor.setEditMode('ask');
      const fileId = actor.addPendingFile({
        filePath: '/path/to/file.ts',
        diffId: 'diff-123'
      });

      // Use a non-matching fileId but matching diffId — should find via fallback
      actor.updatePendingStatus('wrong-id', 'applied', 'diff-123');

      const containers = findContainers('pending');
      const item = queryInShadow(containers[0], '.pending-item');
      expect(item?.getAttribute('data-status')).toBe('applied');
    });

    it('prefers diffId over filePath in fallback lookup', () => {
      actor.setEditMode('ask');

      // Group 1: rejected file
      actor.addPendingFile({ filePath: '/path/to/file.ts', diffId: 'diff-1', status: 'rejected' });

      // Group 2: same file, new diffId (retry)
      actor.startToolBatch([{ name: 'edit_file', detail: 'file.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: '/path/to/file.ts', diffId: 'diff-2' });

      // Update by diffId targeting group 2 — should NOT match group 1
      actor.updatePendingStatus('wrong-id', 'applied', 'diff-2', '/path/to/file.ts');

      // Group 1 should remain rejected, group 2 should be applied
      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
      const item1 = queryInShadow(containers[0], '.pending-item');
      const item2 = queryInShadow(containers[1], '.pending-item');
      expect(item1?.getAttribute('data-status')).toBe('rejected');
      expect(item2?.getAttribute('data-status')).toBe('applied');
    });

    it('creates separate pending containers per tool batch', () => {
      actor.setEditMode('auto');

      // First tool batch + modified file
      actor.startToolBatch([{ name: 'edit_file', detail: 'file1.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file1.ts', status: 'applied' });

      // Second tool batch + modified file
      actor.startToolBatch([{ name: 'edit_file', detail: 'file2.ts' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file2.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
      // Each should have 1 file
      containers.forEach(c => {
        const items = c.shadowRoot?.querySelectorAll('.pending-item');
        expect(items?.length).toBe(1);
      });
    });

    it('groups consecutive pending files in same container', () => {
      actor.setEditMode('auto');

      actor.startToolBatch([{ name: 'edit_file', detail: 'files' }]);
      actor.completeToolBatch();
      actor.addPendingFile({ filePath: 'src/file1.ts', status: 'applied' });
      actor.addPendingFile({ filePath: 'src/file2.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(1);
      const items = containers[0].shadowRoot?.querySelectorAll('.pending-item');
      expect(items?.length).toBe(2);
    });

    it('creates separate containers with shell segments between pending files', () => {
      actor.setEditMode('auto');

      // R1 flow: code blocks → shell → code blocks
      actor.addPendingFile({ filePath: 'src/a.ts', status: 'applied' });
      actor.createShellSegment([{ command: 'ls' }]);
      actor.addPendingFile({ filePath: 'src/b.ts', status: 'applied' });

      const containers = findContainers('pending');
      expect(containers.length).toBe(2);
    });

    it('updates status across multiple pending groups', () => {
      actor.setEditMode('auto');

      actor.startToolBatch([{ name: 'edit', detail: 'f1' }]);
      actor.completeToolBatch();
      const id1 = actor.addPendingFile({ filePath: 'src/f1.ts', status: 'applied' });

      actor.startToolBatch([{ name: 'edit', detail: 'f2' }]);
      actor.completeToolBatch();
      const id2 = actor.addPendingFile({ filePath: 'src/f2.ts', status: 'applied' });

      // Update status of file in second group
      actor.updatePendingStatus(id2, 'rejected');

      const containers = findContainers('pending');
      const item2 = containers[1].shadowRoot?.querySelector('.pending-item');
      expect(item2?.getAttribute('data-status')).toBe('rejected');

      // First group should be unchanged
      const item1 = containers[0].shadowRoot?.querySelector('.pending-item');
      expect(item1?.getAttribute('data-status')).toBe('applied');
    });
  });

  // ============================================
  // Code Block Tests
  // ============================================

  describe('Code blocks', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
    });

    it('renders fenced code blocks', () => {
      actor.createTextSegment('```typescript\nconst x = 1;\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock).toBeTruthy();
    });

    it('shows language label', () => {
      actor.createTextSegment('```javascript\nlet y = 2;\n```');

      const containers = findContainers('text');
      const lang = queryInShadow(containers[0], '.code-lang');
      expect(lang?.textContent).toBe('javascript');
    });

    it('starts expanded in manual mode', () => {
      actor.setEditMode('manual');
      actor.createTextSegment('```typescript\ncode\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock?.classList.contains('expanded')).toBe(true);
    });

    it('starts collapsed in ask/auto mode', () => {
      actor.setEditMode('ask');
      actor.createTextSegment('```typescript\ncode\n```');

      const containers = findContainers('text');
      const codeBlock = queryInShadow(containers[0], '.code-block');
      expect(codeBlock?.classList.contains('expanded')).toBe(false);
    });

    it('hides incomplete fence content and surfaces it on the activity line', () => {
      actor.startStreaming();
      actor.createTextSegment('Here is the code:');
      actor.updateTextContent('Here is the code:\n```python\ndef hello():');

      const containers = findContainers('text');
      // No inline placeholder — that concept is gone under the unified indicator.
      expect(queryInShadow(containers[0], '.code-generating')).toBeNull();
      // Fence content is stripped from rendered text (no raw ``` or fence body)
      const contentEl = queryInShadow(containers[0], '.content');
      expect(contentEl?.textContent).toContain('Here is the code:');
      expect(contentEl?.textContent).not.toContain('```');
      expect(contentEl?.textContent).not.toContain('def hello');
      // No code block dropdown yet (fence still open)
      expect(queryInShadow(containers[0], '.code-block')).toBeNull();
      // The unified activity line carries the label
      expect(actor.getActivityLabel()).toBe('Generating code...');
    });

    it('shows code block dropdown when complete during streaming', () => {
      actor.startStreaming();
      actor.setTextActive(true);
      actor.createTextSegment('');
      actor.updateTextContent('```python\ndef hello():\n    pass\n```');

      const containers = findContainers('text');
      expect(queryInShadow(containers[0], '.code-block')).toBeTruthy();
      // No inline placeholder ever — code-block frame was popped when fence closed
      expect(queryInShadow(containers[0], '.code-generating')).toBeNull();
      // Activity indicator hides when no specific frame is active and only
      // response text is streaming (text is its own indicator below).
      expect(actor.getActivityLabel()).toBeNull();
    });

    it('unified label reflects # File: header (Writing filename)', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('```typescript\n# File: src/game.ts\nclass ');
      expect(actor.getActivityLabel()).toBe('Writing src/game.ts...');
    });

    it('unified label reflects heredoc pattern (Creating filename)', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('```bash\ncat > subdir/config.json << EOF\n{');
      expect(actor.getActivityLabel()).toBe('Creating config.json...');
    });

    it('skips DOM update when formatted output unchanged during code streaming', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('Hello\n```python\ndef a():');

      const containers = findContainers('text');
      const contentEl = queryInShadow(containers[0], '.content') as HTMLElement;
      const firstHtml = contentEl.innerHTML;

      // More code tokens arrive but visible output stays the same
      actor.updateTextContent('Hello\n```python\ndef a():\n    pass');
      expect(contentEl.innerHTML).toBe(firstHtml);
    });

    it('complete code block renders as dropdown', () => {
      actor.startStreaming();
      actor.createTextSegment('');
      actor.updateTextContent('Done:\n```python\nprint("hi")\n```');

      const containers = findContainers('text');
      expect(queryInShadow(containers[0], '.code-block')).toBeTruthy();
    });
  });

  // ============================================
  // State Publication Tests
  // ============================================

  describe('Publications', () => {
    it('publishes turn state', async () => {
      actor = new MessageTurnActor({ manager, element });

      // Wait for registration
      await Promise.resolve();

      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      expect(manager.getState('turn.id')).toBe('turn-1');
      expect(manager.getState('turn.role')).toBe('assistant');
    });

    it('publishes streaming state changes', async () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      await Promise.resolve();

      actor.startStreaming();
      expect(manager.getState('turn.streaming')).toBe(true);

      actor.endStreaming();
      expect(manager.getState('turn.streaming')).toBe(false);
    });
  });

  // ============================================
  // Integration Tests
  // ============================================

  // ============================================
  // Command Approval Tests
  // ============================================

  describe('Command approval', () => {
    let approvalCallback: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      approvalCallback = vi.fn();
      actor = new MessageTurnActor({
        manager,
        element,
        onCommandApprovalAction: approvalCallback,
      });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();
    });

    it('creates approval container with shadow DOM', () => {
      actor.createCommandApproval('npm install', 'npm', 'npm install');

      const containers = findContainers('approval');
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('returns a unique approval ID', () => {
      const id1 = actor.createCommandApproval('npm install', 'npm', 'npm install');
      const id2 = actor.createCommandApproval('git push', 'git', 'git push');

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('renders pending state with command and buttons', () => {
      const approvalId = actor.createCommandApproval('npm install express', 'npm', 'npm install express');

      const containers = findContainers('approval');
      const header = queryInShadow(containers[0], '.approval-header');
      expect(header?.textContent).toContain('Command approval required');

      const command = queryInShadow(containers[0], '.approval-command code');
      expect(command?.textContent).toContain('npm install express');

      const buttons = containers[0].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length).toBe(4);
    });

    it('renders four buttons with correct labels', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');

      const containers = findContainers('approval');
      const buttons = Array.from(containers[0].shadowRoot?.querySelectorAll('.approval-btn') ?? []);
      const labels = buttons.map(b => b.textContent?.trim());

      expect(labels).toContain('Allow Once');
      expect(labels).toContain('Block Once');
      expect(labels.some(l => l?.includes('Always Allow'))).toBe(true);
      expect(labels.some(l => l?.includes('Always Block'))).toBe(true);
    });

    it('always allow/block buttons include prefix', () => {
      actor.createCommandApproval('npm run build', 'npm', 'npm run build');

      const containers = findContainers('approval');
      const alwaysAllow = queryInShadow(containers[0], '.always-allow');
      const alwaysBlock = queryInShadow(containers[0], '.always-block');

      expect(alwaysAllow?.textContent).toContain('"npm"');
      expect(alwaysBlock?.textContent).toContain('"npm"');
    });

    it('resolveCommandApproval updates to allowed state', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.resolveCommandApproval(approvalId, 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[0].classList.contains('allowed')).toBe(true);

      const header = queryInShadow(containers[0], '.approval-header.resolved');
      expect(header?.textContent).toContain('Allowed');
      expect(header?.textContent).toContain('npm test');
    });

    it('resolveCommandApproval updates to blocked state', () => {
      const approvalId = actor.createCommandApproval('rm -rf /', 'rm', 'rm -rf /');
      actor.resolveCommandApproval(approvalId, 'blocked');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[0].classList.contains('blocked')).toBe(true);

      const header = queryInShadow(containers[0], '.approval-header.resolved');
      expect(header?.textContent).toContain('Blocked');
    });

    it('resolved state removes action buttons', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.resolveCommandApproval(approvalId, 'allowed');

      const containers = findContainers('approval');
      const buttons = containers[0].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length ?? 0).toBe(0);
    });

    it('clicking allow once calls callback with correct args', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');

      const containers = findContainers('approval');
      const allowOnce = queryInShadow(containers[0], '.allow-once') as HTMLButtonElement;
      allowOnce?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'allowed', false, 'npm', expect.any(String));
    });

    it('clicking always allow calls callback with persistent=true', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');

      const containers = findContainers('approval');
      const alwaysAllow = queryInShadow(containers[0], '.always-allow') as HTMLButtonElement;
      alwaysAllow?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'allowed', true, 'npm', expect.any(String));
    });

    it('clicking block once calls callback with blocked decision', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');

      const containers = findContainers('approval');
      const blockOnce = queryInShadow(containers[0], '.block-once') as HTMLButtonElement;
      blockOnce?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'blocked', false, 'npm', expect.any(String));
    });

    it('clicking always block calls callback with persistent=true', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');

      const containers = findContainers('approval');
      const alwaysBlock = queryInShadow(containers[0], '.always-block') as HTMLButtonElement;
      alwaysBlock?.click();

      expect(approvalCallback).toHaveBeenCalledWith('npm test', 'blocked', true, 'npm', expect.any(String));
    });

    it('does not fire callback when approval already resolved', () => {
      const approvalId = actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.resolveCommandApproval(approvalId, 'allowed');

      // Buttons are gone after resolve, but even if somehow triggered, guard should prevent callback
      expect(approvalCallback).not.toHaveBeenCalled();
    });

    it('multiple approvals render independently', () => {
      actor.createCommandApproval('npm install', 'npm', 'npm install');
      actor.createCommandApproval('git push', 'git', 'git push');

      const containers = findContainers('approval');
      expect(containers.length).toBe(2);
    });

    it('resolving one approval does not affect another', () => {
      const id1 = actor.createCommandApproval('npm install', 'npm', 'npm install');
      const id2 = actor.createCommandApproval('git push', 'git', 'git push');

      actor.resolveCommandApproval(id1, 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(true);
      expect(containers[1].classList.contains('resolved')).toBe(false);

      // Second still has buttons
      const buttons = containers[1].shadowRoot?.querySelectorAll('.approval-btn');
      expect(buttons?.length).toBe(4);
    });

    it('breaks pending group chain when approval is created', () => {
      actor.setEditMode('ask');
      actor.addPendingFile({ filePath: '/path/to/file.ts' });
      actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.addPendingFile({ filePath: '/path/to/other.ts' });

      // Should have 2 pending containers (not grouped) + 1 approval
      const pendingContainers = findContainers('pending');
      const approvalContainers = findContainers('approval');
      expect(pendingContainers.length).toBe(2);
      expect(approvalContainers.length).toBe(1);
    });

    it('reset clears all command approval state', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.createCommandApproval('git push', 'git', 'git push');

      expect(findContainers('approval').length).toBe(2);

      actor.reset();

      expect(findContainers('approval').length).toBe(0);
    });

    it('resolveCommandApproval is a no-op for unknown ID', () => {
      actor.createCommandApproval('npm test', 'npm', 'npm test');
      // Should not throw
      actor.resolveCommandApproval('nonexistent-id', 'allowed');

      const containers = findContainers('approval');
      expect(containers[0].classList.contains('resolved')).toBe(false);
    });

    it('escapes HTML in command text', () => {
      actor.createCommandApproval('echo "<script>alert(1)</script>"', 'echo', 'echo "<script>alert(1)</script>"');

      const containers = findContainers('approval');
      const code = queryInShadow(containers[0], '.approval-command code');
      // Should not contain raw <script> tag
      expect(code?.innerHTML).not.toContain('<script>');
      expect(code?.textContent).toContain('<script>');
    });
  });

  // ============================================
  // Integration Tests
  // ============================================

  describe('Full turn flow', () => {
    it('handles complete assistant turn with interleaving', () => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });

      // Start streaming
      actor.startStreaming();

      // First text segment
      actor.createTextSegment('Let me help you with that.');

      // Thinking interrupts (CQRS projector creates these directly)
      actor.startThinkingIteration();
      actor.updateThinkingContent('Analyzing the problem...');

      // Tool call interrupts
      actor.startToolBatch([{ name: 'read_file', detail: 'src/main.ts' }]);
      actor.updateTool(0, 'done');
      actor.completeToolBatch();

      // Continuation text (CQRS creates new segment via createTextSegment)
      actor.createTextSegment('Based on the file, here is the solution.', { isContinuation: true });

      // End streaming
      actor.endStreaming();

      // Verify structure: header -> text -> thinking -> tools -> text (continuation)
      expect(element.children.length).toBe(5);

      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('text-container')).toBe(true);
      expect(children[2].classList.contains('thinking-container')).toBe(true);
      expect(children[3].classList.contains('tools-container')).toBe(true);
      expect(children[4].classList.contains('text-container')).toBe(true);
      expect(children[4].classList.contains('continuation')).toBe(true);
    });

    it('handles turn with command approval interleaved', () => {
      const cb = vi.fn();
      actor = new MessageTurnActor({ manager, element, onCommandApprovalAction: cb });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.startStreaming();

      // Text → tool calls → approval → text continuation (CQRS creates separate segments)
      actor.createTextSegment('Running tests...');
      actor.startToolBatch([{ name: 'run_command', detail: 'npm test' }]);
      actor.completeToolBatch();
      const approvalId = actor.createCommandApproval('npm test', 'npm', 'npm test');
      actor.resolveCommandApproval(approvalId, 'allowed');
      actor.createTextSegment('Tests passed!', { isContinuation: true });
      actor.endStreaming();

      // header + text + tools + approval + text(continuation)
      expect(element.children.length).toBe(5);
      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('text-container')).toBe(true);
      expect(children[2].classList.contains('tools-container')).toBe(true);
      expect(children[3].classList.contains('approval-container')).toBe(true);
      expect(children[3].classList.contains('resolved')).toBe(true);
      expect(children[4].classList.contains('text-container')).toBe(true);
      expect(children[4].classList.contains('continuation')).toBe(true);
    });
  });

  // ============================================
  // Drawing Segment Tests
  // ============================================

  describe('Drawing segments', () => {
    beforeEach(() => {
      actor = new MessageTurnActor({ manager, element });
      actor.bind({ turnId: 'turn-1', role: 'user', timestamp: Date.now() });
    });

    it('creates a drawing container with shadow DOM', () => {
      actor.createDrawingSegment('data:image/png;base64,abc123');

      const containers = Array.from(element.querySelectorAll('[data-actor="turn"].drawing-container'));
      expect(containers.length).toBe(1);
      expect(containers[0].shadowRoot).toBeTruthy();
    });

    it('renders an img element with the data URL', () => {
      actor.createDrawingSegment('data:image/png;base64,abc123');

      const containers = Array.from(element.querySelectorAll('[data-actor="turn"].drawing-container'));
      const img = containers[0].shadowRoot?.querySelector('.drawing-image') as HTMLImageElement;
      expect(img).toBeTruthy();
      expect(img.src).toBe('data:image/png;base64,abc123');
      expect(img.alt).toBe('Phone drawing');
    });

    it('returns a segment ID', () => {
      const segmentId = actor.createDrawingSegment('data:image/png;base64,abc');
      expect(segmentId).toContain('turn-1');
      expect(segmentId).toContain('drawing');
    });

    it('creates multiple drawing containers', () => {
      actor.createDrawingSegment('data:image/png;base64,first');
      actor.createDrawingSegment('data:image/png;base64,second');

      const containers = Array.from(element.querySelectorAll('[data-actor="turn"].drawing-container'));
      expect(containers.length).toBe(2);
    });

    it('renders role header before drawing', () => {
      actor.createDrawingSegment('data:image/png;base64,abc');

      const children = Array.from(element.children) as HTMLElement[];
      expect(children[0].classList.contains('header-container')).toBe(true);
      expect(children[1].classList.contains('drawing-container')).toBe(true);
    });

    it('resets drawing state on reset', () => {
      actor.createDrawingSegment('data:image/png;base64,abc');
      actor.reset();

      const containers = Array.from(element.querySelectorAll('[data-actor="turn"].drawing-container'));
      expect(containers.length).toBe(0);
    });

    it('sends saveDrawing message on right-click save', () => {
      const postMessage = vi.fn();
      const pmElement = document.createElement('div');
      document.body.appendChild(pmElement);
      const pmActor = new MessageTurnActor({ manager, element: pmElement, postMessage });
      pmActor.bind({ turnId: 'turn-2', role: 'user', timestamp: Date.now() });
      pmActor.createDrawingSegment('data:image/png;base64,test123');

      const containers = Array.from(pmElement.querySelectorAll('[data-actor="turn"].drawing-container'));
      const img = containers[0].shadowRoot?.querySelector('.drawing-image') as HTMLImageElement;

      // Simulate right-click
      const contextEvent = new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 });
      img.dispatchEvent(contextEvent);

      // Context menu should appear
      const menu = containers[0].shadowRoot?.querySelector('.drawing-context-menu');
      expect(menu).toBeTruthy();

      // Click save item
      const saveItem = menu?.querySelector('.drawing-context-menu-item') as HTMLElement;
      saveItem?.click();

      expect(postMessage).toHaveBeenCalledWith({
        type: 'saveDrawing',
        imageDataUrl: 'data:image/png;base64,test123'
      });

      pmActor.destroy();
    });

    it('adds drawing after text without error', () => {
      // Verify text and drawing can coexist in a single turn
      const textId = actor.createTextSegment('Before drawing');
      expect(textId).toBeTruthy();
      const countAfterText = element.children.length;

      const segmentId = actor.createDrawingSegment('data:image/png;base64,abc');
      expect(segmentId).toContain('drawing');
      const countAfterDrawing = element.children.length;

      // Drawing should add one more container
      expect(countAfterDrawing).toBe(countAfterText + 1);
    });
  });

  // ============================================
  // Pending File Action Tests
  // ============================================

  describe('Pending file accept/reject passes filePath', () => {
    it('accept button passes filePath to onPendingFileAction', () => {
      const actionCb = vi.fn();
      actor = new MessageTurnActor({ manager, element, onPendingFileAction: actionCb });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.setEditMode('ask');

      actor.addPendingFile({
        filePath: '/workspace/src/app.ts',
        status: 'pending',
        diffId: 'diff-123',
      });

      // Find the accept button in the pending container's shadow DOM
      const containers = findContainers('pending');
      expect(containers.length).toBe(1);
      const acceptBtn = queryInShadow(containers[0], '.accept-btn') as HTMLElement;
      expect(acceptBtn).toBeTruthy();

      // Click accept
      acceptBtn.click();

      // Verify callback was called with filePath
      expect(actionCb).toHaveBeenCalledOnce();
      const [action, fileId, diffId, filePath] = actionCb.mock.calls[0];
      expect(action).toBe('accept');
      expect(diffId).toBe('diff-123');
      expect(filePath).toBe('/workspace/src/app.ts');
    });

    it('reject button passes filePath to onPendingFileAction', () => {
      const actionCb = vi.fn();
      actor = new MessageTurnActor({ manager, element, onPendingFileAction: actionCb });
      actor.bind({ turnId: 'turn-1', role: 'assistant', timestamp: Date.now() });
      actor.setEditMode('ask');

      actor.addPendingFile({
        filePath: '/workspace/src/config.ts',
        status: 'pending',
        diffId: 'diff-456',
      });

      const containers = findContainers('pending');
      const rejectBtn = queryInShadow(containers[0], '.reject-btn') as HTMLElement;
      expect(rejectBtn).toBeTruthy();

      rejectBtn.click();

      expect(actionCb).toHaveBeenCalledOnce();
      const [action, fileId, diffId, filePath] = actionCb.mock.calls[0];
      expect(action).toBe('reject');
      expect(diffId).toBe('diff-456');
      expect(filePath).toBe('/workspace/src/config.ts');
    });
  });
});
