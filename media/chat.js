(function() {
  const vscode = acquireVsCodeApi();
  let currentResponse = '';
  let currentReasoning = '';
  let isStreaming = false;
  let isReasonerMode = false;
  let codeBlockCounter = 0;
  let pendingAttachments = []; // Store {base64, mimeType, name}
  let currentDiffedBlockId = null; // Track which block has active diff
  let currentToolCalls = []; // Track current tool calls for collapsible display
  let toolCallsContainerId = 0; // Counter for unique tool call container IDs
  let webSearchEnabled = false;
  let webSearchSettings = { searchesPerPrompt: 1, searchDepth: 'basic' };

  // Edit mode state
  let editMode = 'manual'; // 'manual' | 'ask' | 'auto'
  const editModes = ['manual', 'ask', 'auto'];
  const editModeLabels = {
    manual: 'Manual',
    ask: 'Ask before applying',
    auto: 'Auto-apply'
  };

  // Edit queue for ask mode
  let editQueue = [];
  let currentEdit = null;

  // Multi-diff queue state
  let pendingDiffs = []; // Array of { filePath, timestamp, proposedUri }
  let activeDiffPath = null; // Currently focused diff

  // File selection state
  let selectedFiles = new Map(); // path -> content
  let openFiles = []; // List of currently open file paths
  let searchResults = []; // Search results from backend

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
  const toolLimitSlider = document.getElementById('toolLimitSlider');
  const toolLimitValue = document.getElementById('toolLimitValue');
  const toolLimitControl = document.getElementById('toolLimitControl');
  const toastContainer = document.getElementById('toastContainer');
  let toastTimeout = null;

  // File selection modal elements
  const fileModalOverlay = document.getElementById('fileModalOverlay');
  const fileModalClose = document.getElementById('fileModalClose');
  const fileModalCancel = document.getElementById('fileModalCancel');
  const fileModalAdd = document.getElementById('fileModalAdd');
  const openFilesList = document.getElementById('openFilesList');
  const openFilesCount = document.getElementById('openFilesCount');
  const fileSearchInput = document.getElementById('fileSearchInput');
  const fileSearchResults = document.getElementById('fileSearchResults');
  const selectedFilesList = document.getElementById('selectedFilesList');
  const selectedFilesCount = document.getElementById('selectedFilesCount');
  const clearSelectedBtn = document.getElementById('clearSelectedBtn');
  const fileChipsContainer = document.getElementById('fileChipsContainer');
  const fileChips = document.getElementById('fileChips');

  // Status panel elements
  const statusPanelMoby = document.getElementById('statusPanelMoby');
  const statusPanelMessages = document.getElementById('statusPanelMessages');
  const statusPanelWarnings = document.getElementById('statusPanelWarnings');
  const statusPanelLogsBtn = document.getElementById('statusPanelLogsBtn');
  const statusPanelLeft = document.querySelector('.status-panel-left');
  const statusPanelRight = document.querySelector('.status-panel-right');
  const statusPanelSeparator = document.getElementById('statusPanelSeparator');

  // Timeout tracking to prevent conflicts
  let statusMessageTimeout = null;
  let statusWarningTimeout = null;

  // Scroll tracking - don't auto-scroll if user has scrolled up
  let userHasScrolledUp = false;
  let reasoningUserHasScrolledUp = false; // Separate tracking for reasoning content
  const SCROLL_THRESHOLD = 100; // pixels from bottom to consider "near bottom"

  // Current model state
  let currentModel = 'deepseek-chat';

  // ============================================
  // FILE SELECTION MODAL FUNCTIONS (MOVED OUTSIDE INIT FOR MESSAGE HANDLER ACCESS)
  // ============================================

  // Open file selection modal
  function openFileModal() {
    // Show loading state for open files
    openFilesList.innerHTML = '<div class="file-search-no-results">Loading open files...</div>';
    openFilesCount.textContent = '0';

    // Request open files from backend
    vscode.postMessage({ type: 'getOpenFiles' });

    // Notify backend that modal is now open (for live updates)
    vscode.postMessage({ type: 'fileModalOpened' });

    // Show modal
    fileModalOverlay.style.display = 'flex';

    // Focus search input
    setTimeout(() => fileSearchInput.focus(), 100);
  }

  // Close file selection modal
  function closeFileModal() {
    // Notify backend that modal is now closed
    vscode.postMessage({ type: 'fileModalClosed' });

    fileModalOverlay.style.display = 'none';
    fileSearchInput.value = '';
    fileSearchResults.style.display = 'none';
    fileSearchResults.innerHTML = '';
  }

  // Load open files into the modal
  function loadOpenFiles(files) {
    console.log('[DIAGNOSTIC] loadOpenFiles called with:', files);
    openFiles = files;
    openFilesCount.textContent = files.length;

    if (files.length === 0) {
      console.log('[DIAGNOSTIC] No files provided - showing "No files currently open"');
      openFilesList.innerHTML = '<div class="file-search-no-results">No files currently open</div>';
      return;
    }

    console.log('[DIAGNOSTIC] Loading', files.length, 'files into modal');

    openFilesList.innerHTML = '';
    for (const filePath of files) {
      const item = document.createElement('div');
      item.className = 'open-file-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'open-file-checkbox';
      checkbox.checked = selectedFiles.has(filePath);
      checkbox.addEventListener('change', () => toggleFileSelection(filePath, checkbox.checked));

      const name = document.createElement('span');
      name.className = 'open-file-name';
      name.textContent = filePath;
      name.title = filePath;

      item.appendChild(checkbox);
      item.appendChild(name);
      item.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          toggleFileSelection(filePath, checkbox.checked);
        }
      });

      openFilesList.appendChild(item);
    }
  }

  // Handle file search
  function handleFileSearch() {
    const query = fileSearchInput.value.trim();

    if (query.length === 0) {
      fileSearchResults.style.display = 'none';
      fileSearchResults.innerHTML = '';
      return;
    }

    // Request search results from backend
    vscode.postMessage({ type: 'searchFiles', query });
  }

  // Display search results
  function displaySearchResults(results) {
    console.log('[DIAGNOSTIC] displaySearchResults called with:', results);
    searchResults = results;

    if (results.length === 0) {
      console.log('[DIAGNOSTIC] No search results - showing "No files found"');
      fileSearchResults.innerHTML = '<div class="file-search-no-results">No files found</div>';
      fileSearchResults.style.display = 'block';
      return;
    }

    console.log('[DIAGNOSTIC] Displaying', results.length, 'search results');
    fileSearchResults.innerHTML = '';
    fileSearchResults.style.display = 'block';

    for (const filePath of results) {
      const item = document.createElement('div');
      item.className = 'file-search-result-item';
      item.textContent = filePath;
      item.title = filePath;

      item.addEventListener('click', () => {
        toggleFileSelection(filePath, true);
        // Clear search
        fileSearchInput.value = '';
        fileSearchResults.style.display = 'none';
      });

      fileSearchResults.appendChild(item);
    }
  }

  // Toggle file selection
  function toggleFileSelection(filePath, selected) {
    if (selected) {
      // Request file content from backend
      vscode.postMessage({ type: 'getFileContent', filePath });
    } else {
      selectedFiles.delete(filePath);
      updateSelectedFilesList();
      updateModalAddButton();
    }
  }

  // Add file to selected files (called when content is received)
  function addFileToSelection(filePath, content) {
    selectedFiles.set(filePath, content);
    updateSelectedFilesList();
    updateModalAddButton();

    // Update checkbox in open files list if present
    const checkboxes = openFilesList.querySelectorAll('.open-file-checkbox');
    checkboxes.forEach(cb => {
      const item = cb.closest('.open-file-item');
      const name = item.querySelector('.open-file-name');
      if (name && name.textContent === filePath) {
        cb.checked = true;
      }
    });
  }

  // Update files button state (green when files selected)
  function updateFilesButtonState() {
    const filesBtn = document.getElementById('filesBtn');
    if (filesBtn) {
      filesBtn.classList.toggle('active', selectedFiles.size > 0);
    }
  }

  // Update selected files list in modal
  function updateSelectedFilesList() {
    selectedFilesCount.textContent = selectedFiles.size;

    if (selectedFiles.size === 0) {
      selectedFilesList.innerHTML = '<div class="selected-files-empty">No files selected</div>';
      clearSelectedBtn.style.display = 'none';
      updateFilesButtonState();
      return;
    }

    clearSelectedBtn.style.display = 'inline-block';
    selectedFilesList.innerHTML = '';

    for (const [filePath, content] of selectedFiles.entries()) {
      const chip = document.createElement('div');
      chip.className = 'selected-file-chip';

      const name = document.createElement('span');
      name.className = 'selected-file-name';
      name.textContent = filePath;
      name.title = filePath;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'selected-file-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFileSelection(filePath, false);
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      selectedFilesList.appendChild(chip);
    }

    updateFilesButtonState();
  }

  // Update Add button state
  function updateModalAddButton() {
    fileModalAdd.disabled = selectedFiles.size === 0;
  }

  // Add files to context (close modal and render chips)
  function addFilesToContext() {
    // Send selected files to backend
    const filesData = Array.from(selectedFiles.entries()).map(([path, content]) => ({
      path,
      content
    }));
    vscode.postMessage({ type: 'setSelectedFiles', files: filesData });

    // Render file chips
    renderFileChips();

    // Close modal
    closeFileModal();
  }

  // Clear all selected files
  function clearAllSelected() {
    selectedFiles.clear();
    updateSelectedFilesList();
    updateModalAddButton();

    // Uncheck all checkboxes in open files list
    const checkboxes = openFilesList.querySelectorAll('.open-file-checkbox');
    checkboxes.forEach(cb => cb.checked = false);
  }

  // Render file chips below input area
  function renderFileChips() {
    if (selectedFiles.size === 0) {
      fileChipsContainer.style.display = 'none';
      fileChips.innerHTML = '';
      return;
    }

    fileChipsContainer.style.display = 'flex';
    fileChips.innerHTML = '';

    for (const [filePath, content] of selectedFiles.entries()) {
      const chip = document.createElement('div');
      chip.className = 'file-chip';

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = filePath;
      name.title = filePath;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        selectedFiles.delete(filePath);
        renderFileChips();

        // Notify backend
        const filesData = Array.from(selectedFiles.entries()).map(([path, content]) => ({
          path,
          content
        }));
        vscode.postMessage({ type: 'setSelectedFiles', files: filesData });
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      fileChips.appendChild(chip);
    }
  }

  // ============================================
  // EDIT MODE ICON UPDATER (MOVED OUTSIDE INIT FOR MESSAGE HANDLER ACCESS)
  // ============================================
  function updateEditModeIcon(mode) {
    const editModeIcon = document.getElementById('editModeIcon');
    if (!editModeIcon) return;

    if (mode === 'manual') {
      // Letter "M" for Manual
      editModeIcon.innerHTML = `
        <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">M</text>
      `;
    } else if (mode === 'ask') {
      // Letter "Q" for asQ (question/ask)
      editModeIcon.innerHTML = `
        <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">Q</text>
      `;
    } else if (mode === 'auto') {
      // Letter "A" for Auto
      editModeIcon.innerHTML = `
        <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">A</text>
      `;
    }
  }

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

    // Status panel logs button handler
    if (statusPanelLogsBtn) {
      statusPanelLogsBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'showLogs' });
      });
    }

    // Search button handler
    const searchBtn = document.getElementById('searchBtn');
    searchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (webSearchEnabled) {
        // Toggle off
        webSearchEnabled = false;
        searchBtn.classList.remove('active');
        vscode.postMessage({ type: 'toggleWebSearch', enabled: false });
      } else {
        // Show settings modal
        showWebSearchModal(searchBtn);
      }
    });

    // ============================================
    // FILE SELECTION MODAL EVENT LISTENERS
    // ============================================

    // Files button handler
    const filesBtn = document.getElementById('filesBtn');
    if (filesBtn) {
      filesBtn.addEventListener('click', openFileModal);
    }

    // Modal event listeners
    if (fileModalClose) {
      fileModalClose.addEventListener('click', closeFileModal);
    }
    if (fileModalCancel) {
      fileModalCancel.addEventListener('click', closeFileModal);
    }
    if (fileModalAdd) {
      fileModalAdd.addEventListener('click', addFilesToContext);
    }
    if (clearSelectedBtn) {
      clearSelectedBtn.addEventListener('click', clearAllSelected);
    }
    if (fileModalOverlay) {
      fileModalOverlay.addEventListener('click', (e) => {
        if (e.target === fileModalOverlay) {
          closeFileModal();
        }
      });
    }

    // File search input handler (debounced)
    let searchTimeout = null;
    if (fileSearchInput) {
      fileSearchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(handleFileSearch, 300);
      });
    }

    /* Water spurt animation code - COMMENTED OUT for future use
    if (filesBtn) {
      filesBtn.addEventListener('click', () => {
        filesBtn.classList.remove('spurting');
        void filesBtn.offsetWidth;
        filesBtn.classList.add('spurting');
        setTimeout(() => {
          filesBtn.classList.remove('spurting');
        }, 700);
      });
    }
    */

    // Edit mode button handler - cycles through manual/ask/auto
    const editModeBtn = document.getElementById('editModeBtn');
    if (editModeBtn) {
      // Initialize button state - remove any leftover classes on page load
      editModeBtn.classList.remove('state-manual', 'state-ask', 'state-auto');

      editModeBtn.addEventListener('click', () => {
        const currentIndex = editModes.indexOf(editMode);
        editMode = editModes[(currentIndex + 1) % editModes.length];

        // Update button class
        editModeBtn.classList.remove('state-manual', 'state-ask', 'state-auto');
        if (editMode !== 'manual') {
          editModeBtn.classList.add(`state-${editMode}`);
        }
        editModeBtn.title = `Edit mode: ${editModeLabels[editMode]}`;

        // Update icon based on mode
        updateEditModeIcon(editMode);

        // Notify backend
        vscode.postMessage({ type: 'setEditMode', mode: editMode });

        // Show in status bar (left side - informative)
        showStatusMessage(`Edit mode: ${editModeLabels[editMode]}`);
      });
    }

    // Model dropdown handlers
    modelBtn.addEventListener('click', toggleModelDropdown);
    document.querySelectorAll('.model-option').forEach(option => {
      option.addEventListener('click', () => selectModel(option.dataset.model));
    });
    tempSlider.addEventListener('input', updateTemperature);
    toolLimitSlider.addEventListener('input', updateToolLimit);

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

    // Restore previous state if webview was recreated
    const previousState = vscode.getState();
    if (previousState && previousState.messages && previousState.messages.length > 0) {
      previousState.messages.forEach(msg => addMessage(msg, true));
    }
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

    // Show tool limit control only for chat model (not reasoner)
    if (toolLimitControl) {
      toolLimitControl.style.display = model === 'deepseek-chat' ? 'block' : 'none';
    }
  }

  function updateTemperature() {
    tempValue.textContent = tempSlider.value;
    vscode.postMessage({
      type: 'updateSettings',
      settings: { temperature: parseFloat(tempSlider.value) }
    });
  }

  function updateToolLimit() {
    const value = parseInt(toolLimitSlider.value);
    toolLimitValue.textContent = value >= 100 ? '∞' : value;
    vscode.postMessage({
      type: 'updateSettings',
      settings: { maxToolCalls: value }
    });
  }

  function stopGeneration() {
    vscode.postMessage({ type: 'stopGeneration' });
  }

  function showStopButton() {
    // Hide send button and show stop button in its place
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
  }

  function hideStopButton() {
    // Hide stop button and show send button
    stopBtn.style.display = 'none';
    sendBtn.style.display = 'flex';
    updateSendButtonState();
  }

  // Handle file selection
  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      // Read text files
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target.result;
        const attachment = {
          content,
          name: file.name,
          size: file.size
        };
        pendingAttachments.push(attachment);
        renderAttachmentPreview(attachment);
        updateSendButtonState();
      };
      reader.onerror = () => {
        showToast(`Failed to read file: ${file.name}`, 'error');
      };
      reader.readAsText(file);
    });
    // Clear input so same file can be selected again
    fileInput.value = '';
  }

  // Render attachment preview
  function renderAttachmentPreview(attachment) {
    const preview = document.createElement('div');
    preview.className = 'attachment-preview file-attachment';
    const ext = attachment.name.split('.').pop().toLowerCase();
    const sizeKB = (attachment.size / 1024).toFixed(1);
    preview.innerHTML = `
      <span class="file-icon">📄</span>
      <span class="file-name" title="${attachment.name}">${attachment.name}</span>
      <span class="file-size">${sizeKB}KB</span>
      <button class="attachment-remove" title="Remove">×</button>
    `;
    preview.querySelector('.attachment-remove').addEventListener('click', () => {
      const idx = pendingAttachments.indexOf(attachment);
      if (idx > -1) {
        pendingAttachments.splice(idx, 1);
      }
      preview.remove();
      updateSendButtonState();
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

    // Add user message to UI immediately (with file names)
    addMessage({
      role: 'user',
      content: message,
      files: pendingAttachments.map(a => a.name)
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

    // Display attached files if present
    if (message.files && message.files.length > 0) {
      const filesEl = document.createElement('div');
      filesEl.className = 'message-files';
      message.files.forEach(fileName => {
        const fileEl = document.createElement('span');
        fileEl.className = 'message-file-tag';
        fileEl.innerHTML = `📄 ${escapeHtml(fileName)}`;
        filesEl.appendChild(fileEl);
      });
      messageEl.appendChild(filesEl);
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
      // Reconstruct tool calls HTML from structured data if present
      let toolCallsPrefix = '';
      if (message.toolCalls && message.toolCalls.length > 0) {
        toolCallsPrefix = generateToolCallsHtml(message.toolCalls);
      }
      contentEl.innerHTML = toolCallsPrefix + formatCodeBlocks(message.content);
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

  function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;');
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

  /**
   * Generate tool calls HTML from structured data
   * Used when loading history to reconstruct the tool calls UI
   */
  function generateToolCallsHtml(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return '';

    const containerId = `tool-calls-history-${Date.now()}`;
    const doneCount = toolCalls.filter(t => t.status === 'done').length;
    const errorCount = toolCalls.filter(t => t.status === 'error').length;

    const toolsHtml = toolCalls.map((tool, i) => {
      const statusIcon = tool.status === 'done' ? '✓' : tool.status === 'error' ? '✗' : '⏳';
      return `
        <div class="tool-call-item" id="${containerId}-item-${i}" data-status="${tool.status}">
          <span class="tool-call-status">${statusIcon}</span>
          <span class="tool-call-detail">${escapeHtml(tool.detail)}</span>
        </div>
      `;
    }).join('');

    const title = `Used ${doneCount} tool${doneCount !== 1 ? 's' : ''}` +
                  (errorCount > 0 ? ` (${errorCount} failed)` : '');

    return `
      <div class="tool-calls-container complete" id="${containerId}">
        <div class="tool-calls-header" onclick="this.parentElement.classList.toggle('expanded')">
          <span class="tool-calls-icon">▶</span>
          <span class="tool-calls-title">${title}</span>
          <span class="tool-calls-summary"></span>
        </div>
        <div class="tool-calls-body">${toolsHtml}</div>
      </div>
    `;
  }

  /**
   * Strip DSML (DeepSeek Markup Language) from content
   * DSML is used by DeepSeek for tool calls but should not be displayed to users
   */
  function stripDSMLFromContent(content) {
    if (!content || !content.includes('<｜DSML｜')) {
      return content;
    }

    // Remove the entire function_calls block
    let stripped = content.replace(/<｜DSML｜function_calls>[\s\S]*?(?:<\/｜DSML｜function_calls>|$)/g, '');

    // Also remove any standalone DSML tags that might be left
    stripped = stripped.replace(/<｜DSML｜[^>]*>[\s\S]*?<｜DSML｜[^>]*>/g, '');
    stripped = stripped.replace(/<\/?｜DSML｜[^>]*>/g, '');

    return stripped.trim();
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

  // Status Panel Functions - Water Spurt Animations
  function triggerMobySpurt(color) {
    // Remove existing color classes
    statusPanelMoby.classList.remove('spurt-blue', 'spurt-yellow', 'spurt-red', 'spurting');

    // Add the color class
    statusPanelMoby.classList.add(`spurt-${color}`);

    // Force reflow to restart animation
    void statusPanelMoby.offsetWidth;

    // Add spurting class to trigger animation
    statusPanelMoby.classList.add('spurting');

    // Remove spurting class after animation completes
    setTimeout(() => {
      statusPanelMoby.classList.remove('spurting');
    }, 700);
  }

  function showStatusMessage(message) {
    // Clear existing timeout
    if (statusMessageTimeout) {
      clearTimeout(statusMessageTimeout);
      statusMessageTimeout = null;
    }

    // Left side - informative messages
    statusPanelMessages.textContent = message;
    statusPanelMessages.title = message; // Tooltip shows full message
    triggerMobySpurt('blue');

    // Auto-clear after 5 seconds
    statusMessageTimeout = setTimeout(() => {
      statusPanelMessages.textContent = '';
      statusPanelMessages.title = '';
      statusMessageTimeout = null;
    }, 5000);
  }

  function showStatusWarning(message) {
    // Clear existing timeout
    if (statusWarningTimeout) {
      clearTimeout(statusWarningTimeout);
      statusWarningTimeout = null;
    }

    // Right side - warnings
    statusPanelWarnings.textContent = message;
    statusPanelWarnings.title = message; // Tooltip shows full message
    statusPanelWarnings.classList.remove('error');
    statusPanelWarnings.classList.add('warning');

    // Add background styling
    statusPanelRight.classList.remove('error-bg');
    statusPanelRight.classList.add('warning-bg');

    triggerMobySpurt('yellow');

    // Auto-clear after 8 seconds
    statusWarningTimeout = setTimeout(() => {
      statusPanelWarnings.textContent = '';
      statusPanelWarnings.title = '';
      statusPanelWarnings.classList.remove('warning');
      statusPanelRight.classList.remove('warning-bg');
      statusWarningTimeout = null;
    }, 8000);
  }

  function showStatusError(message) {
    // Clear existing timeout
    if (statusWarningTimeout) {
      clearTimeout(statusWarningTimeout);
      statusWarningTimeout = null;
    }

    // Right side - errors
    statusPanelWarnings.textContent = message;
    statusPanelWarnings.title = message; // Tooltip shows full message
    statusPanelWarnings.classList.remove('warning');
    statusPanelWarnings.classList.add('error');

    // Add background styling
    statusPanelRight.classList.remove('warning-bg');
    statusPanelRight.classList.add('error-bg');

    triggerMobySpurt('red');

    // Auto-clear after 10 seconds
    statusWarningTimeout = setTimeout(() => {
      statusPanelWarnings.textContent = '';
      statusPanelWarnings.title = '';
      statusPanelWarnings.classList.remove('error');
      statusPanelRight.classList.remove('error-bg');
      statusWarningTimeout = null;
    }, 10000);
  }

  function clearStatus() {
    // Clear timeouts
    if (statusMessageTimeout) {
      clearTimeout(statusMessageTimeout);
      statusMessageTimeout = null;
    }
    if (statusWarningTimeout) {
      clearTimeout(statusWarningTimeout);
      statusWarningTimeout = null;
    }

    // Clear messages and classes
    statusPanelMessages.textContent = '';
    statusPanelMessages.title = '';
    statusPanelWarnings.textContent = '';
    statusPanelWarnings.title = '';
    statusPanelWarnings.classList.remove('warning', 'error');
    statusPanelRight.classList.remove('warning-bg', 'error-bg');
  }

  // Resizable separator for status panel
  let isResizing = false;
  let startX = 0;
  let startLeftWidth = 0;
  let startRightWidth = 0;

  if (statusPanelSeparator) {
    statusPanelSeparator.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;

      // Get current widths
      const leftRect = statusPanelLeft.getBoundingClientRect();
      const rightRect = statusPanelRight.getBoundingClientRect();
      startLeftWidth = leftRect.width;
      startRightWidth = rightRect.width;

      // Prevent text selection during drag
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const deltaX = e.clientX - startX;

      // Calculate total available width for flexible panels
      // This is the sum of left and right, excluding fixed elements
      const totalFlexWidth = startLeftWidth + startRightWidth;

      // Calculate new widths with delta
      let newLeftWidth = startLeftWidth + deltaX;
      let newRightWidth = startRightWidth - deltaX;

      // Constrain to min 20% and max 80% of flexible space
      const minWidth = totalFlexWidth * 0.2;
      const maxWidth = totalFlexWidth * 0.8;

      if (newLeftWidth < minWidth) {
        newLeftWidth = minWidth;
        newRightWidth = totalFlexWidth - minWidth;
      } else if (newLeftWidth > maxWidth) {
        newLeftWidth = maxWidth;
        newRightWidth = totalFlexWidth - maxWidth;
      }

      // Ensure both stay within bounds
      newRightWidth = Math.max(minWidth, Math.min(maxWidth, newRightWidth));
      newLeftWidth = totalFlexWidth - newRightWidth;

      // Update using pixel widths to prevent overflow
      statusPanelLeft.style.flex = `0 0 ${newLeftWidth}px`;
      statusPanelRight.style.flex = `0 0 ${newRightWidth}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    });
  }

  // Commands modal
  const commands = [
    { section: 'Chat' },
    { id: 'newChat', name: 'New Chat', desc: 'Start a new conversation', icon: '✨' },
    { section: 'History' },
    { id: 'showChatHistory', name: 'Show History', desc: 'View chat history', icon: '📚' },
    { id: 'exportChatHistory', name: 'Export History', desc: 'Export all chats', icon: '📤' },
    { id: 'searchChatHistory', name: 'Search History', desc: 'Search past chats', icon: '🔍' },
    { section: 'Other' },
    { id: 'showStats', name: 'Show Stats', desc: 'View usage statistics', icon: '📊' },
    { id: 'showLogs', name: 'Show Logs', desc: 'View extension logs', icon: '📋' },
    { section: 'Debug' },
    { id: 'testError', name: 'Test Error', desc: 'Trigger a test error message', icon: '🔴' },
    { id: 'testWarning', name: 'Test Warning', desc: 'Trigger a test warning message', icon: '🟡' },
    { id: 'testMessage', name: 'Test Message', desc: 'Trigger a test info message', icon: '🔵' }
  ];

  function showCommandsModal(btn) {
    closeCommandsModal();
    closeWebSearchModal(); // Close other modal if open

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

        // Handle test commands locally
        if (commandId === 'testError') {
          showStatusError('This is a test error message');
          closeCommandsModal();
          return;
        }
        if (commandId === 'testWarning') {
          showStatusWarning('This is a test warning message');
          closeCommandsModal();
          return;
        }
        if (commandId === 'testMessage') {
          showStatusMessage('This is a test info message');
          closeCommandsModal();
          return;
        }

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

  // Web Search Modal
  function showWebSearchModal(btn) {
    closeWebSearchModal();
    closeCommandsModal(); // Close other modal if open

    const modal = document.createElement('div');
    modal.className = 'web-search-modal';
    modal.innerHTML = `
      <div class="web-search-modal-title">
        <span>Web Search Settings</span>
        <button class="web-search-modal-close">&times;</button>
      </div>
      <div class="web-search-modal-content">
        <div class="web-search-option">
          <label>Searches per prompt: <span id="searchCountValue">${webSearchSettings.searchesPerPrompt}</span></label>
          <input type="range" id="searchCountSlider" min="1" max="20" step="1" value="${webSearchSettings.searchesPerPrompt}">
        </div>
        <div class="web-search-option">
          <label>Search depth:</label>
          <div class="search-depth-options">
            <button class="depth-btn ${webSearchSettings.searchDepth === 'basic' ? 'active' : ''}" data-depth="basic">
              <span class="depth-name">Basic</span>
              <span class="depth-credits">1 credit</span>
            </button>
            <button class="depth-btn ${webSearchSettings.searchDepth === 'advanced' ? 'active' : ''}" data-depth="advanced">
              <span class="depth-name">Advanced</span>
              <span class="depth-credits">2 credits</span>
            </button>
          </div>
        </div>
        <button class="web-search-enable-btn">Enable Web Search</button>
        <button class="web-search-clear-cache-btn">Clear Cache</button>
      </div>
    `;

    // Position above button
    const rect = btn.getBoundingClientRect();
    modal.style.bottom = (window.innerHeight - rect.top + 5) + 'px';
    modal.style.left = rect.left + 'px';

    // Event handlers
    modal.querySelector('.web-search-modal-close').addEventListener('click', closeWebSearchModal);

    modal.querySelector('#searchCountSlider').addEventListener('input', (e) => {
      const value = e.target.value;
      modal.querySelector('#searchCountValue').textContent = value;
      webSearchSettings.searchesPerPrompt = parseInt(value, 10);
    });

    modal.querySelectorAll('.depth-btn').forEach(depthBtn => {
      depthBtn.addEventListener('click', () => {
        modal.querySelectorAll('.depth-btn').forEach(b => b.classList.remove('active'));
        depthBtn.classList.add('active');
        webSearchSettings.searchDepth = depthBtn.dataset.depth;
      });
    });

    modal.querySelector('.web-search-enable-btn').addEventListener('click', () => {
      webSearchEnabled = true;
      btn.classList.add('active');
      vscode.postMessage({ type: 'toggleWebSearch', enabled: true });
      vscode.postMessage({ type: 'updateWebSearchSettings', settings: webSearchSettings });
      closeWebSearchModal();
    });

    modal.querySelector('.web-search-clear-cache-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearSearchCache' });
      closeWebSearchModal();
    });

    document.body.appendChild(modal);

    setTimeout(() => {
      document.addEventListener('click', handleWebSearchModalOutsideClick);
    }, 0);
  }

  function closeWebSearchModal() {
    const modal = document.querySelector('.web-search-modal');
    if (modal) modal.remove();
    document.removeEventListener('click', handleWebSearchModalOutsideClick);
  }

  function handleWebSearchModalOutsideClick(e) {
    if (!e.target.closest('.web-search-modal') && !e.target.closest('.search-btn')) {
      closeWebSearchModal();
    }
  }

  // Edit confirm overlay for ask mode
  function showEditConfirm(filePath, code, language) {
    // Remove any existing overlay
    hideEditConfirm();

    const overlay = document.createElement('div');
    overlay.className = 'edit-confirm-overlay';
    overlay.id = 'editConfirmOverlay';

    const queueInfo = editQueue.length > 0 ? `<span class="edit-confirm-queue">+${editQueue.length} more</span>` : '';

    overlay.innerHTML = `
      <span class="edit-confirm-text">Apply changes to</span>
      <span class="edit-confirm-file" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
      ${queueInfo}
      <button class="edit-confirm-btn accept" id="acceptEditBtn">Accept</button>
      <button class="edit-confirm-btn reject" id="rejectEditBtn">Reject</button>
    `;

    document.body.appendChild(overlay);

    currentEdit = { filePath, code, language };

    document.getElementById('acceptEditBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'applyCode', code, language, confirmed: true });
      hideEditConfirm();
      processNextEdit();
    });

    document.getElementById('rejectEditBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectEdit', filePath });
      hideEditConfirm();
      processNextEdit();
    });
  }

  function hideEditConfirm() {
    const existing = document.getElementById('editConfirmOverlay');
    if (existing) existing.remove();
    currentEdit = null;
  }

  function queueEdit(edit) {
    if (!currentEdit) {
      // No pending edit, show immediately
      processEdit(edit);
    } else {
      // Queue it and update the overlay badge
      editQueue.push(edit);
      updateQueueBadge();
    }
  }

  function processNextEdit() {
    if (editQueue.length > 0) {
      const next = editQueue.shift();
      processEdit(next);
    }
  }

  function processEdit(edit) {
    currentEdit = edit;
    // Note: Don't call showDiff here - the backend already opened it in ask mode
    // This function is only for showing the accept/reject overlay
    showEditConfirm(edit.filePath, edit.code, edit.language);
  }

  function updateQueueBadge() {
    const overlay = document.getElementById('editConfirmOverlay');
    if (!overlay) return;

    let badge = overlay.querySelector('.edit-confirm-queue');
    if (editQueue.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'edit-confirm-queue';
        const rejectBtn = overlay.querySelector('.reject');
        if (rejectBtn) {
          overlay.insertBefore(badge, rejectBtn);
        }
      }
      badge.textContent = `+${editQueue.length} more`;
    } else if (badge) {
      badge.remove();
    }
  }

  // Multi-diff list overlay functions - REMOVED (replaced with toolbar buttons)
  // function showDiffListOverlay() { ... }
  // function hideDiffListOverlay() { ... }
  // function updateDiffList() { ... }

  function saveState() {
    const messages = Array.from(document.querySelectorAll('.message')).map(el => {
      const reasoningEl = el.querySelector('.reasoning-body');
      const contentEl = el.querySelector('.content');
      const toolCallsContainer = contentEl?.querySelector('.tool-calls-container');

      // Extract text content without the tool calls HTML
      let textContent = '';
      if (contentEl) {
        // Clone and remove tool calls to get clean text
        const clone = contentEl.cloneNode(true);
        const toolCallsInClone = clone.querySelector('.tool-calls-container');
        if (toolCallsInClone) {
          toolCallsInClone.remove();
        }
        textContent = clone.textContent || '';
      }

      return {
        role: el.classList.contains('user') ? 'user' : 'assistant',
        content: textContent,
        reasoning_content: reasoningEl ? reasoningEl.textContent : undefined,
        toolCallsHtml: toolCallsContainer ? toolCallsContainer.outerHTML : undefined
      };
    });

    vscode.setState({ messages });
  }

  // Message handler
  window.addEventListener('message', (event) => {
    const message = event.data;

    // DIAGNOSTIC: Log all incoming messages
    console.log('[DIAGNOSTIC] Received message:', message.type, message);

    // DIAGNOSTIC: Specifically log file-related messages
    if (message.type === 'openFiles' || message.type === 'searchResults' || message.type === 'fileContent') {
      console.log('[DIAGNOSTIC] FILE MESSAGE:', JSON.stringify(message));
    }

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
        showStatusMessage('Moby is seeking...');

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
          // Preserve tool call containers by saving and restoring them
          const toolCallContainers = streamingContent.querySelectorAll('.tool-calls-container');
          const savedContainers = Array.from(toolCallContainers).map(el => el.cloneNode(true));

          // Update content (strip any DSML markup before displaying)
          const cleanResponse = stripDSMLFromContent(currentResponse);
          streamingContent.innerHTML = formatCodeBlocks(cleanResponse);

          // Re-append tool call containers at the beginning
          if (savedContainers.length > 0) {
            const firstChild = streamingContent.firstChild;
            savedContainers.forEach(container => {
              if (firstChild) {
                streamingContent.insertBefore(container, firstChild);
              } else {
                streamingContent.appendChild(container);
              }
            });
          }
        }
        scrollToBottomIfNeeded();
        break;

      case 'toolCallsStart':
        // Create collapsible tool calls container
        currentToolCalls = message.tools;
        toolCallsContainerId++;
        const containerId = `tool-calls-${toolCallsContainerId}`;

        const toolCallsHtml = `
          <div class="tool-calls-container" id="${containerId}">
            <div class="tool-calls-header" onclick="this.parentElement.classList.toggle('expanded')">
              <span class="tool-calls-icon">▶</span>
              <span class="tool-calls-title">Using ${message.tools.length} tool${message.tools.length > 1 ? 's' : ''}...</span>
              <span class="tool-calls-summary"></span>
            </div>
            <div class="tool-calls-body">
              ${message.tools.map((tool, i) => `
                <div class="tool-call-item" id="${containerId}-item-${i}" data-status="pending">
                  <span class="tool-call-status">⏳</span>
                  <span class="tool-call-detail">${escapeHtml(tool.detail)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;

        // Append to streaming content
        const streamContent = document.getElementById('streamingContent');
        if (streamContent) {
          streamContent.innerHTML += toolCallsHtml;
        }
        scrollToBottomIfNeeded();
        break;

      case 'toolCallUpdate':
        // Update individual tool call status
        const itemId = `tool-calls-${toolCallsContainerId}-item-${message.index}`;
        const toolItem = document.getElementById(itemId);
        if (toolItem) {
          toolItem.dataset.status = message.status;
          const statusEl = toolItem.querySelector('.tool-call-status');
          if (statusEl) {
            if (message.status === 'running') {
              statusEl.textContent = '⏳';
              statusEl.classList.add('spinning');
            } else if (message.status === 'done') {
              statusEl.textContent = '✓';
              statusEl.classList.remove('spinning');
            } else if (message.status === 'error') {
              statusEl.textContent = '✗';
              statusEl.classList.remove('spinning');
            }
          }
        }
        break;

      case 'toolCallsUpdate':
        // Update existing tool calls container with new/additional tools
        // (Used when tool loop has multiple iterations)
        currentToolCalls = message.tools;
        const existingContainer = document.getElementById(`tool-calls-${toolCallsContainerId}`);
        if (existingContainer) {
          // Update header title
          const headerTitle = existingContainer.querySelector('.tool-calls-title');
          if (headerTitle) {
            headerTitle.textContent = `Using ${message.tools.length} tool${message.tools.length > 1 ? 's' : ''}...`;
          }

          // Update body with all tools
          const body = existingContainer.querySelector('.tool-calls-body');
          if (body) {
            body.innerHTML = message.tools.map((tool, i) => `
              <div class="tool-call-item" id="tool-calls-${toolCallsContainerId}-item-${i}" data-status="${tool.status}">
                <span class="tool-call-status">${tool.status === 'done' ? '✓' : tool.status === 'error' ? '✗' : '⏳'}</span>
                <span class="tool-call-detail">${escapeHtml(tool.detail)}</span>
              </div>
            `).join('');
          }
        }
        scrollToBottomIfNeeded();
        break;

      case 'toolCallsEnd':
        // Mark tool calls as complete, update title
        const container = document.getElementById(`tool-calls-${toolCallsContainerId}`);
        if (container) {
          container.classList.add('complete');
          const title = container.querySelector('.tool-calls-title');
          if (title) {
            const doneCount = container.querySelectorAll('[data-status="done"]').length;
            const errorCount = container.querySelectorAll('[data-status="error"]').length;
            title.textContent = `Used ${doneCount} tool${doneCount !== 1 ? 's' : ''}`;
            if (errorCount > 0) {
              title.textContent += ` (${errorCount} failed)`;
            }
          }
        }
        currentToolCalls = [];
        break;

      case 'endResponse':
        isStreaming = false;
        reasoningUserHasScrolledUp = false;
        hideTypingIndicator();
        hideStopButton();
        clearStatus();
        // Replace streaming container with final message
        const streamingEl = document.getElementById('streamingMessage');
        if (streamingEl) {
          // Preserve ALL tool calls containers before removing streaming element
          const toolCallsContainers = streamingEl.querySelectorAll('.tool-calls-container');
          const toolCallsHtml = Array.from(toolCallsContainers).map(c => c.outerHTML).join('');

          streamingEl.remove();

          // Strip DSML from final response before adding message
          const cleanContent = stripDSMLFromContent(currentResponse);

          // Create final message with tool calls HTML preserved (for current session display)
          // When loaded from history, toolCalls structured data will be used instead
          const messageEl = document.createElement('div');
          messageEl.className = 'message assistant';

          const roleEl = document.createElement('div');
          roleEl.className = 'role';
          roleEl.textContent = 'DeepSeek Moby';
          messageEl.appendChild(roleEl);

          // Add reasoning if present
          if (currentReasoning) {
            const reasoningEl = document.createElement('div');
            reasoningEl.className = 'reasoning-content';
            reasoningEl.innerHTML = `
              <div class="reasoning-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <span class="reasoning-icon">💭</span>
                <span>Chain of Thought</span>
                <span class="reasoning-toggle">▼</span>
              </div>
              <div class="reasoning-body">${formatText(currentReasoning)}</div>
            `;
            messageEl.appendChild(reasoningEl);
          }

          // Add content with tool calls HTML prepended
          const contentEl = document.createElement('div');
          contentEl.className = 'content';
          contentEl.innerHTML = toolCallsHtml + formatCodeBlocks(cleanContent);
          messageEl.appendChild(contentEl);

          chatMessages.appendChild(messageEl);
          chatMessages.scrollTop = chatMessages.scrollHeight;
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
        // If diff was closed manually while we have pending edit, treat as reject
        if (currentEdit) {
          hideEditConfirm();
          processNextEdit();
        }
        break;

      case 'showEditConfirm':
        // NOTE: This is now handled by the new multi-diff overlay system
        // The diffListChanged message already triggers the overlay display
        // This case is kept for backward compatibility but does nothing
        break;

      case 'editRejected':
        // Backend confirms edit was rejected
        showToast('Edit rejected', 'warning', null, true);
        break;

      // REMOVED: Modal overlay message handlers (replaced with toolbar buttons)
      // case 'diffListChanged': ...
      // case 'activeDiffChanged': ...

      case 'editModeSettings':
        // Sync edit mode from backend (on startup or settings change)
        if (message.mode && editModes.includes(message.mode)) {
          editMode = message.mode;
          const editModeBtn = document.getElementById('editModeBtn');
          if (editModeBtn) {
            // Remove ALL state classes first
            editModeBtn.classList.remove('state-manual', 'state-ask', 'state-auto');

            // Only add state class for non-manual modes
            if (editMode === 'ask') {
              editModeBtn.classList.add('state-ask');
            } else if (editMode === 'auto') {
              editModeBtn.classList.add('state-auto');
            }
            // manual mode: no class added (uses default styling)

            editModeBtn.title = `Edit mode: ${editModeLabels[editMode]}`;

            // Update icon to match the mode
            updateEditModeIcon(editMode);
          }
        }
        break;

      case 'openFiles':
        // Receive list of currently open files
        loadOpenFiles(message.files || []);
        break;

      case 'searchResults':
        // Receive file search results
        displaySearchResults(message.results || []);
        break;

      case 'fileContent':
        // Receive file content after selection
        addFileToSelection(message.filePath, message.content);
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
        showStatusError(`Error: ${message.error}`);
        break;

      case 'warning':
        showStatusWarning(message.message);
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
        if (message.maxToolCalls !== undefined) {
          toolLimitSlider.value = message.maxToolCalls;
          toolLimitValue.textContent = message.maxToolCalls >= 100 ? '∞' : message.maxToolCalls;
        }
        break;

      case 'webSearchToggled':
        webSearchEnabled = message.enabled;
        const searchBtnEl = document.getElementById('searchBtn');
        if (searchBtnEl) {
          searchBtnEl.classList.toggle('active', message.enabled);
        }
        break;

      case 'webSearchSettings':
        webSearchEnabled = message.enabled;
        webSearchSettings = message.settings || webSearchSettings;
        const searchBtnSettings = document.getElementById('searchBtn');
        if (searchBtnSettings) {
          searchBtnSettings.classList.toggle('active', message.enabled);
        }
        break;

      case 'searchCacheCleared':
        showToast('Search cache cleared', 'info', null, true);
        break;

      case 'webSearching':
        showToast('Searching the web...', 'info', null, false);
        break;

      case 'webSearchComplete':
        clearToast();
        break;

      case 'webSearchCached':
        showToast('Using cached search results', 'info', null, true);
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
            // Preserve tool calls container
            const stoppedToolCalls = stoppedStreamEl.querySelector('.tool-calls-container');
            const stoppedToolCallsHtml = stoppedToolCalls ? stoppedToolCalls.outerHTML : '';

            stoppedStreamEl.remove();

            // Strip DSML from partial response
            const cleanStoppedContent = stripDSMLFromContent(currentResponse);

            addMessage({
              role: 'assistant',
              content: cleanStoppedContent + '\n\n*[Generation stopped]*',
              reasoning_content: currentReasoning || undefined,
              toolCallsHtml: stoppedToolCallsHtml
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
