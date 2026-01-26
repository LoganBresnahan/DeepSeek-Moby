(function() {
  const vscode = acquireVsCodeApi();
  let currentResponse = '';
  let currentReasoning = '';
  let isStreaming = false;
  let isReasonerMode = false;
  let codeBlockCounter = 0;
  let pendingAttachments = []; // Store {base64, mimeType, name}
  let currentDiffedBlockId = null; // Track which block has active diff

  // DOM Elements
  const chatMessages = document.getElementById('chatMessages');
  const messageInput = document.getElementById('messageInput');
  const attachBtn = document.getElementById('attachBtn');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');
  const attachmentsContainer = document.getElementById('attachments');
  const stopBtn = document.getElementById('stopBtn');
  const modelBtn = document.getElementById('modelBtn');
  const modelDropdown = document.getElementById('modelDropdown');
  const currentModelName = document.getElementById('currentModelName');
  const tempSlider = document.getElementById('tempSlider');
  const tempValue = document.getElementById('tempValue');
  const toastContainer = document.getElementById('toastContainer');
  let toastTimeout = null;

  // Scroll tracking - don't auto-scroll if user has scrolled up
  let userHasScrolledUp = false;
  let reasoningUserHasScrolledUp = false; // Separate tracking for reasoning content
  const SCROLL_THRESHOLD = 100; // pixels from bottom to consider "near bottom"

  // Current model state
  let currentModel = 'deepseek-chat';

  // Initialize
  function init() {
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Update send button state on input change
    messageInput.addEventListener('input', updateSendButtonState);

    // File attachment handlers
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);

    // Help button handler
    const helpBtn = document.getElementById('helpBtn');
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showCommandsModal(helpBtn);
    });

    // Send button handler
    sendBtn.addEventListener('click', sendMessage);

    // Stop button handler
    stopBtn.addEventListener('click', stopGeneration);

    // Model dropdown handlers
    modelBtn.addEventListener('click', toggleModelDropdown);
    document.querySelectorAll('.model-option').forEach(option => {
      option.addEventListener('click', () => selectModel(option.dataset.model));
    });
    tempSlider.addEventListener('input', updateTemperature);

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.model-selector')) {
        closeModelDropdown();
      }
    });

    // Auto-focus input
    messageInput.focus();

    // Handle code block button clicks via event delegation
    chatMessages.addEventListener('click', handleCodeBlockAction);

    // Track scroll position to avoid forcing user down during streaming
    chatMessages.addEventListener('scroll', handleScrollTracking);

    // Request current settings from backend
    vscode.postMessage({ type: 'getSettings' });

    // Initialize send button state
    updateSendButtonState();
  }

  function updateSendButtonState() {
    const hasContent = messageInput.value.trim().length > 0 || pendingAttachments.length > 0;
    sendBtn.disabled = !hasContent || isStreaming;
    sendBtn.classList.toggle('disabled', !hasContent || isStreaming);
  }

  // Check if user is near the bottom of the chat
  function isNearBottom() {
    const scrollBottom = chatMessages.scrollTop + chatMessages.clientHeight;
    return chatMessages.scrollHeight - scrollBottom < SCROLL_THRESHOLD;
  }

  // Handle scroll events to track if user scrolled up
  function handleScrollTracking() {
    if (!isStreaming) {
      userHasScrolledUp = false;
      return;
    }
    // If streaming and user is not near bottom, they've scrolled up
    userHasScrolledUp = !isNearBottom();
  }

  // Smart scroll - only scroll to bottom if user hasn't scrolled up
  function scrollToBottomIfNeeded() {
    if (!userHasScrolledUp) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // Reasoning content scroll tracking (separate from main chat)
  function isReasoningNearBottom() {
    const reasoningContent = document.getElementById('streamingReasoningContent');
    if (!reasoningContent) return true;
    const scrollBottom = reasoningContent.scrollTop + reasoningContent.clientHeight;
    return reasoningContent.scrollHeight - scrollBottom < SCROLL_THRESHOLD;
  }

  function handleReasoningScrollTracking() {
    if (!isStreaming) {
      reasoningUserHasScrolledUp = false;
      return;
    }
    reasoningUserHasScrolledUp = !isReasoningNearBottom();
  }

  function scrollReasoningToBottomIfNeeded() {
    if (!reasoningUserHasScrolledUp) {
      const reasoningContent = document.getElementById('streamingReasoningContent');
      if (reasoningContent) {
        reasoningContent.scrollTop = reasoningContent.scrollHeight;
      }
    }
  }

  function toggleModelDropdown() {
    const isOpen = modelDropdown.style.display !== 'none';
    if (isOpen) {
      closeModelDropdown();
    } else {
      openModelDropdown();
    }
  }

  function openModelDropdown() {
    modelDropdown.style.display = 'block';
    modelBtn.closest('.model-selector').classList.add('open');
  }

  function closeModelDropdown() {
    modelDropdown.style.display = 'none';
    modelBtn.closest('.model-selector').classList.remove('open');
  }

  function selectModel(model) {
    currentModel = model;
    updateModelDisplay(model);
    closeModelDropdown();
    vscode.postMessage({
      type: 'updateSettings',
      settings: { model }
    });
  }

  function updateModelDisplay(model) {
    // Update button text
    const displayNames = {
      'deepseek-chat': 'Chat (V3)',
      'deepseek-reasoner': 'Reasoner (R1)'
    };
    currentModelName.textContent = displayNames[model] || model;

    // Update selected state in dropdown
    document.querySelectorAll('.model-option').forEach(option => {
      option.classList.toggle('selected', option.dataset.model === model);
    });
  }

  function updateTemperature() {
    tempValue.textContent = tempSlider.value;
    vscode.postMessage({
      type: 'updateSettings',
      settings: { temperature: parseFloat(tempSlider.value) }
    });
  }

  function stopGeneration() {
    vscode.postMessage({ type: 'stopGeneration' });
  }

  function showStopButton() {
    stopBtn.style.display = 'flex';
    const buttonsLeft = document.querySelector('.input-buttons-left');
    if (buttonsLeft) buttonsLeft.style.display = 'none';
  }

  function hideStopButton() {
    stopBtn.style.display = 'none';
    const buttonsLeft = document.querySelector('.input-buttons-left');
    if (buttonsLeft) buttonsLeft.style.display = 'flex';
    updateSendButtonState();
  }

  // Handle file selection
  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const base64 = event.target.result.split(',')[1];
          const attachment = {
            base64,
            mimeType: file.type,
            name: file.name
          };
          pendingAttachments.push(attachment);
          renderAttachmentPreview(attachment);
        };
        reader.readAsDataURL(file);
      }
    });
    // Clear input so same file can be selected again
    fileInput.value = '';
  }

  // Render attachment preview
  function renderAttachmentPreview(attachment) {
    const preview = document.createElement('div');
    preview.className = 'attachment-preview';
    preview.innerHTML = `
      <img src="data:${attachment.mimeType};base64,${attachment.base64}" alt="${attachment.name}">
      <button class="attachment-remove" title="Remove">×</button>
    `;
    preview.querySelector('.attachment-remove').addEventListener('click', () => {
      const idx = pendingAttachments.indexOf(attachment);
      if (idx > -1) {
        pendingAttachments.splice(idx, 1);
      }
      preview.remove();
    });
    attachmentsContainer.appendChild(preview);
  }

  // Handle code block actions (Apply, Copy)
  function handleCodeBlockAction(e) {
    const target = e.target;

    if (target.classList.contains('apply-btn')) {
      const codeBlock = target.closest('.code-block');
      const code = codeBlock.querySelector('code').textContent;
      const lang = codeBlock.dataset.language || 'text';

      vscode.postMessage({
        type: 'applyCode',
        code: code,
        language: lang
      });
    }

    if (target.classList.contains('copy-btn')) {
      const codeBlock = target.closest('.code-block');
      const code = codeBlock.querySelector('code').textContent;

      navigator.clipboard.writeText(code).then(() => {
        target.textContent = 'Copied!';
        setTimeout(() => {
          target.textContent = 'Copy';
        }, 1500);
      });
    }

    if (target.classList.contains('diff-btn')) {
      const codeBlock = target.closest('.code-block');
      const code = codeBlock.querySelector('code').textContent;
      const lang = codeBlock.dataset.language || 'text';
      const blockId = codeBlock.id;
      const isCurrentlyDiffed = codeBlock.classList.contains('diffed');

      // If this block is already diffed, close the diff (toggle off)
      if (isCurrentlyDiffed && currentDiffedBlockId === blockId) {
        codeBlock.classList.remove('diffed');
        target.textContent = 'Diff';
        currentDiffedBlockId = null;
        vscode.postMessage({ type: 'closeDiff' });
        return;
      }

      // Clear previous diffed block if different
      if (currentDiffedBlockId && currentDiffedBlockId !== blockId) {
        const prevBlock = document.getElementById(currentDiffedBlockId);
        if (prevBlock) {
          prevBlock.classList.remove('diffed');
          const prevDiffBtn = prevBlock.querySelector('.diff-btn');
          if (prevDiffBtn) prevDiffBtn.textContent = 'Diff';
        }
      }

      // Mark as diffed and change button to Cancel
      codeBlock.classList.add('diffed');
      target.textContent = 'Cancel';
      currentDiffedBlockId = blockId;

      vscode.postMessage({
        type: 'showDiff',
        code: code,
        language: lang
      });
    }

    if (target.classList.contains('collapse-btn')) {
      const codeBlock = target.closest('.code-block');
      const isCollapsed = codeBlock.classList.toggle('collapsed');
      target.textContent = isCollapsed ? '▶' : '▼';
      target.title = isCollapsed ? 'Expand code' : 'Collapse code';
    }
  }

  // Message handling
  function sendMessage() {
    const message = messageInput.value.trim();
    if ((!message && pendingAttachments.length === 0) || isStreaming) return;

    // Add user message to UI immediately (with images)
    addMessage({
      role: 'user',
      content: message,
      images: pendingAttachments.map(a => `data:${a.mimeType};base64,${a.base64}`)
    });

    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Send to backend with attachments
    vscode.postMessage({
      type: 'sendMessage',
      message,
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined
    });

    // Clear attachments
    pendingAttachments = [];
    attachmentsContainer.innerHTML = '';
  }

  function addMessage(message, skipSave = false) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.role}`;

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    roleEl.textContent = message.role === 'user' ? 'You' : 'DeepSeek Moby';

    messageEl.appendChild(roleEl);

    // Display images if present
    if (message.images && message.images.length > 0) {
      const imagesEl = document.createElement('div');
      imagesEl.className = 'message-images';
      message.images.forEach(imgSrc => {
        const img = document.createElement('img');
        img.src = imgSrc;
        img.className = 'message-image';
        img.title = 'Click to view full size';
        img.addEventListener('click', () => {
          // Open image in new window/tab
          const win = window.open();
          win.document.write(`<img src="${imgSrc}" style="max-width:100%">`);
        });
        imagesEl.appendChild(img);
      });
      messageEl.appendChild(imagesEl);
    }

    // Add reasoning content if present (for deepseek-reasoner)
    if (message.reasoning_content) {
      const reasoningEl = document.createElement('div');
      reasoningEl.className = 'reasoning-content';
      reasoningEl.innerHTML = `
        <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="reasoning-icon">💭</span>
          <span>Chain of Thought</span>
          <span class="reasoning-toggle">▼</span>
        </div>
        <div class="reasoning-body">${formatText(message.reasoning_content)}</div>
      `;
      messageEl.appendChild(reasoningEl);
    }

    const contentEl = document.createElement('div');
    contentEl.className = 'content';

    if (message.role === 'assistant') {
      contentEl.innerHTML = formatCodeBlocks(message.content);
    } else {
      contentEl.textContent = message.content;
    }

    messageEl.appendChild(contentEl);
    chatMessages.appendChild(messageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Save state (unless loading history)
    if (!skipSave) {
      saveState();
    }
  }

  function formatText(text) {
    if (!text) return '';

    // Escape HTML
    let html = text.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');

    // Format inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');

    // Format line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  // Simple syntax highlighter for common languages
  function highlightCode(code) {
    // Escape HTML first
    let highlighted = code.replace(/&/g, '&amp;')
                          .replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;');

    // Language-specific patterns
    const patterns = {
      // Comments (must be first to not interfere with strings)
      comment: {
        pattern: /(\/\/.*$|\/\*[\s\S]*?\*\/|#(?!{).*$)/gm,
        className: 'token comment'
      },
      // Strings
      string: {
        pattern: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
        className: 'token string'
      },
      // Numbers
      number: {
        pattern: /\b(\d+\.?\d*)\b/g,
        className: 'token number'
      },
      // Keywords (common across languages)
      keyword: {
        pattern: /\b(function|const|let|var|if|else|for|while|return|class|def|end|module|import|export|from|async|await|try|catch|finally|throw|new|this|self|true|false|nil|null|undefined|do|in|of|switch|case|default|break|continue|yield|lambda|raise|rescue|begin|ensure|unless|elsif|when|then)\b/g,
        className: 'token keyword'
      },
      // Built-in functions/methods
      builtin: {
        pattern: /\b(console|print|puts|require|include|extend|attr_accessor|attr_reader|attr_writer|private|public|protected|static|final|abstract|interface|implements|extends)\b/g,
        className: 'token builtin'
      },
      // Function definitions
      function: {
        pattern: /\b([a-zA-Z_]\w*)\s*(?=\()/g,
        className: 'token function'
      }
    };

    // Apply patterns in order (using placeholders to avoid double-processing)
    const tokens = [];

    // Process strings first (protect them)
    highlighted = highlighted.replace(patterns.string.pattern, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.string.className}">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Process comments
    highlighted = highlighted.replace(patterns.comment.pattern, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.comment.className}">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Process keywords
    highlighted = highlighted.replace(patterns.keyword.pattern, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.keyword.className}">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Process built-ins
    highlighted = highlighted.replace(patterns.builtin.pattern, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.builtin.className}">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Process numbers
    highlighted = highlighted.replace(patterns.number.pattern, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.number.className}">${match}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Process function calls
    highlighted = highlighted.replace(patterns.function.pattern, (_match, name) => {
      const idx = tokens.length;
      tokens.push(`<span class="${patterns.function.className}">${name}</span>`);
      return `__TOKEN_${idx}__`;
    });

    // Restore tokens
    tokens.forEach((token, idx) => {
      highlighted = highlighted.replace(`__TOKEN_${idx}__`, token);
    });

    return highlighted;
  }

  function formatCodeBlocks(text) {
    if (!text) return '';

    // First, extract and protect code blocks
    const codeBlocks = [];
    let processed = text.replace(/```(\w+)?\n([\s\S]*?)\n```/g, (match, lang, code) => {
      const index = codeBlocks.length;
      codeBlocks.push({ lang: lang || 'text', code: code });
      return `__CODE_BLOCK_${index}__`;
    });

    // Escape HTML in remaining text
    processed = processed.replace(/&/g, '&amp;')
                         .replace(/</g, '&lt;')
                         .replace(/>/g, '&gt;');

    // Format inline code
    processed = processed.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');

    // Format line breaks
    processed = processed.replace(/\n/g, '<br>');

    // Restore code blocks with buttons and syntax highlighting
    codeBlocks.forEach((block, index) => {
      const blockId = `code-block-${codeBlockCounter++}`;
      const highlightedCode = highlightCode(block.code);
      const isToolOutput = block.lang === 'tool-output';
      const displayLang = isToolOutput ? 'output' : block.lang;

      // Tool output blocks don't get action buttons
      const actionsHtml = isToolOutput ? '' : `
            <div class="code-actions">
              <button class="code-action-btn copy-btn" title="Copy code">Copy</button>
              <button class="code-action-btn diff-btn" title="Show diff">Diff</button>
              <button class="code-action-btn apply-btn" title="Apply to editor">Apply</button>
              <button class="code-action-btn collapse-btn" title="Collapse code">▼</button>
            </div>`;

      const codeBlockHtml = `
        <div class="code-block ${isToolOutput ? 'tool-output' : ''}" id="${blockId}" data-language="${block.lang}">
          <div class="code-header">
            <span class="code-lang">${displayLang}</span>${actionsHtml}
          </div>
          <pre><code class="language-${block.lang}">${highlightedCode}</code></pre>
        </div>
      `;

      processed = processed.replace(`__CODE_BLOCK_${index}__`, codeBlockHtml);
    });

    // Reduce double <br> after code blocks to single <br>
    processed = processed.replace(/<\/div>\s*<br><br>/g, '</div><br>');

    return processed;
  }


  function showTypingIndicator() {
    // Typing indicator handled by streaming message container
  }

  function hideTypingIndicator() {
    // No-op - handled by streaming message container
  }

  // Error message hints for actionable guidance
  const errorHints = {
    'Invalid API key': 'Check your API key in Settings > DeepSeek',
    'Rate limit exceeded': 'Wait a moment before sending another message',
    'server error': 'Try again in a few minutes',
    'Cannot connect': 'Check your internet connection',
    'No response': 'Check your connection and try again'
  };

  function getErrorHint(errorMessage) {
    const lowerMsg = errorMessage.toLowerCase();
    for (const [key, hint] of Object.entries(errorHints)) {
      if (lowerMsg.includes(key.toLowerCase())) {
        return hint;
      }
    }
    return 'Try again or check the DeepSeek status page';
  }

  function showToast(message, type = 'error', hint = null, autoDismiss = true) {
    // Clear any existing toast
    clearToast();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-message">${message}</span>
        ${hint ? `<span class="toast-hint">${hint}</span>` : ''}
      </div>
      <button class="toast-close" title="Dismiss">×</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', clearToast);
    toastContainer.appendChild(toast);

    if (autoDismiss) {
      toastTimeout = setTimeout(clearToast, 8000);
    }
  }

  function clearToast() {
    if (toastTimeout) {
      clearTimeout(toastTimeout);
      toastTimeout = null;
    }
    toastContainer.innerHTML = '';
  }

  function showStatus(text, isError = false) {
    if (isError) {
      const hint = getErrorHint(text);
      showToast(text, 'error', hint, true);
    } else {
      showToast(text, 'warning', null, true);
    }
  }

  // Commands modal
  const commands = [
    { section: 'Chat' },
    { id: 'startChat', name: 'Open Chat', desc: 'Open the chat panel', icon: '💬' },
    { id: 'newChat', name: 'New Chat', desc: 'Start a new conversation', icon: '✨' },
    { id: 'switchModel', name: 'Switch Model', desc: 'Change AI model', icon: '🔄' },
    { section: 'Code Actions' },
    { id: 'explainCode', name: 'Explain Code', desc: 'Explain selected code', icon: '📖' },
    { id: 'refactorCode', name: 'Refactor Code', desc: 'Improve code structure', icon: '🔧' },
    { id: 'documentCode', name: 'Add Documentation', desc: 'Generate comments/docs', icon: '📝' },
    { id: 'fixBugs', name: 'Find & Fix Bugs', desc: 'Detect and fix issues', icon: '🐛' },
    { id: 'optimizeCode', name: 'Optimize', desc: 'Improve performance', icon: '⚡' },
    { id: 'generateTests', name: 'Generate Tests', desc: 'Create unit tests', icon: '🧪' },
    { id: 'insertCode', name: 'Insert Code', desc: 'Insert generated code', icon: '📥' },
    { section: 'History' },
    { id: 'showChatHistory', name: 'Show History', desc: 'View chat history', icon: '📚' },
    { id: 'exportChatHistory', name: 'Export History', desc: 'Export all chats', icon: '📤' },
    { id: 'searchChatHistory', name: 'Search History', desc: 'Search past chats', icon: '🔍' },
    { section: 'Other' },
    { id: 'showStats', name: 'Show Stats', desc: 'View usage statistics', icon: '📊' },
    { id: 'showLogs', name: 'Show Logs', desc: 'View extension logs', icon: '📋' }
  ];

  function showCommandsModal(btn) {
    closeCommandsModal();

    const modal = document.createElement('div');
    modal.className = 'commands-modal';
    modal.innerHTML = `
      <div class="commands-modal-title">
        <span>Commands</span>
        <button class="commands-modal-close">×</button>
      </div>
      <div class="commands-list">
        ${commands.map(cmd => {
          if (cmd.section) {
            return `<div class="commands-section-title">${cmd.section}</div>`;
          }
          return `
            <div class="command-item" data-command="${cmd.id}">
              <span class="command-icon">${cmd.icon}</span>
              <div class="command-info">
                <div class="command-name">${cmd.name}</div>
                <div class="command-desc">${cmd.desc}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Position above the button
    const rect = btn.getBoundingClientRect();
    modal.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    modal.style.left = `${rect.left}px`;

    // Close button handler
    modal.querySelector('.commands-modal-close').addEventListener('click', closeCommandsModal);

    // Command click handlers
    modal.querySelectorAll('.command-item').forEach(item => {
      item.addEventListener('click', () => {
        const commandId = item.dataset.command;
        vscode.postMessage({ type: 'executeCommand', command: `deepseek.${commandId}` });
        closeCommandsModal();
      });
    });

    document.body.appendChild(modal);

    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', handleCommandsModalOutsideClick);
    }, 0);
  }

  function handleCommandsModalOutsideClick(e) {
    if (!e.target.closest('.commands-modal') && !e.target.closest('.help-btn')) {
      closeCommandsModal();
    }
  }

  function closeCommandsModal() {
    const modal = document.querySelector('.commands-modal');
    if (modal) {
      modal.remove();
    }
    document.removeEventListener('click', handleCommandsModalOutsideClick);
  }

  function saveState() {
    const messages = Array.from(document.querySelectorAll('.message')).map(el => {
      const reasoningEl = el.querySelector('.reasoning-body');
      return {
        role: el.classList.contains('user') ? 'user' : 'assistant',
        content: el.querySelector('.content')?.textContent || '',
        reasoning_content: reasoningEl ? reasoningEl.textContent : undefined
      };
    });

    vscode.setState({ messages });
  }

  // Message handler
  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'addMessage':
        // Only add assistant messages from backend (user messages added locally)
        if (message.message.role === 'assistant') {
          addMessage(message.message);
        }
        break;

      case 'startResponse':
        isStreaming = true;
        currentResponse = '';
        currentReasoning = '';
        isReasonerMode = message.isReasoner || false;
        showTypingIndicator(isReasonerMode);
        showStopButton();

        // Create empty message container for streaming
        const streamContainer = document.createElement('div');
        streamContainer.className = 'message assistant';
        streamContainer.id = 'streamingMessage';

        let streamHTML = '<div class="role">DeepSeek Moby</div>';

        // Add reasoning container if in reasoner mode
        if (isReasonerMode) {
          streamHTML += `
            <div class="reasoning-content" id="streamingReasoning">
              <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <span class="reasoning-icon">💭</span>
                <span>Chain of Thought</span>
                <span class="reasoning-toggle">▼</span>
              </div>
              <div class="reasoning-body" id="streamingReasoningContent"></div>
            </div>
          `;
        }

        streamHTML += '<div class="content" id="streamingContent"></div>';
        streamContainer.innerHTML = streamHTML;
        chatMessages.appendChild(streamContainer);

        // Add scroll listener for reasoning content if present
        const reasoningBody = document.getElementById('streamingReasoningContent');
        if (reasoningBody) {
          reasoningBody.addEventListener('scroll', handleReasoningScrollTracking);
        }

        // Reset scroll tracking for new response and scroll to bottom
        userHasScrolledUp = false;
        reasoningUserHasScrolledUp = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
        break;

      case 'streamReasoning':
        currentReasoning += message.token;
        const reasoningContent = document.getElementById('streamingReasoningContent');
        if (reasoningContent) {
          reasoningContent.innerHTML = formatText(currentReasoning);
          // Smart scroll - only if user hasn't scrolled up in reasoning
          scrollReasoningToBottomIfNeeded();
        }
        scrollToBottomIfNeeded();
        break;

      case 'streamToken':
        currentResponse += message.token;
        const streamingContent = document.getElementById('streamingContent');
        if (streamingContent) {
          streamingContent.innerHTML = formatCodeBlocks(currentResponse);
        }
        scrollToBottomIfNeeded();
        break;

      case 'endResponse':
        isStreaming = false;
        reasoningUserHasScrolledUp = false;
        hideTypingIndicator();
        hideStopButton();
        // Replace streaming container with final message
        const streamingEl = document.getElementById('streamingMessage');
        if (streamingEl) {
          streamingEl.remove();
          addMessage({
            role: 'assistant',
            content: currentResponse,
            reasoning_content: currentReasoning || undefined
          });
        }
        saveState();
        break;

      case 'loadHistory':
        // Clear and load history (skip individual saves during bulk load)
        chatMessages.innerHTML = '';
        message.history.forEach(msg => addMessage(msg, true));
        saveState();
        break;

      case 'clearChat':
        chatMessages.innerHTML = '';
        break;

      case 'codeApplied':
        showStatus(message.success ? '✓ Code applied successfully' : `Failed: ${message.error}`, !message.success);
        break;

      case 'diffClosed':
        // Remove 'diffed' class and reset button text
        if (currentDiffedBlockId) {
          const block = document.getElementById(currentDiffedBlockId);
          if (block) {
            block.classList.remove('diffed');
            const diffBtn = block.querySelector('.diff-btn');
            if (diffBtn) diffBtn.textContent = 'Diff';
          }
          currentDiffedBlockId = null;
        }
        break;

      case 'error':
        isStreaming = false;
        reasoningUserHasScrolledUp = false;
        hideTypingIndicator();
        hideStopButton();
        const errorStreamEl = document.getElementById('streamingMessage');
        if (errorStreamEl) {
          errorStreamEl.remove();
        }
        showStatus(`Error: ${message.error}`, true);
        break;

      case 'warning':
        showStatus(`⚠️ ${message.message}`, false);
        break;

      case 'settings':
        // Update UI with current settings from backend
        if (message.model) {
          currentModel = message.model;
          updateModelDisplay(message.model);
        }
        if (message.temperature !== undefined) {
          tempSlider.value = message.temperature;
          tempValue.textContent = message.temperature;
        }
        break;

      case 'generationStopped':
        isStreaming = false;
        reasoningUserHasScrolledUp = false;
        hideTypingIndicator();
        hideStopButton();
        const stoppedStreamEl = document.getElementById('streamingMessage');
        if (stoppedStreamEl) {
          // Keep partial response if any
          if (currentResponse || currentReasoning) {
            stoppedStreamEl.remove();
            addMessage({
              role: 'assistant',
              content: currentResponse + '\n\n*[Generation stopped]*',
              reasoning_content: currentReasoning || undefined
            });
          } else {
            stoppedStreamEl.remove();
          }
        }
        showStatus('Generation stopped', false);
        break;
    }
  });

  // Auto-resize textarea
  messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
  });

  // Initialize on load
  document.addEventListener('DOMContentLoaded', init);
  // Also init immediately in case DOM is already ready
  if (document.readyState !== 'loading') {
    init();
  }
})();
