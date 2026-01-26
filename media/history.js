(function() {
  const vscode = acquireVsCodeApi();
  let currentSessions = [];
  let currentSessionId = null;

  // DOM Elements
  const sessionsList = document.getElementById('sessionsList');
  const searchInput = document.getElementById('searchInput');
  const exportAllBtn = document.getElementById('exportAllBtn');
  const clearAllBtn = document.getElementById('clearAllBtn');
  let searchDebounceTimer = null;

  // Initialize
  function init() {
    // Live search as user types (debounced)
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(searchSessions, 200);
    });
    exportAllBtn.addEventListener('click', showExportAllDialog);
    clearAllBtn.addEventListener('click', clearAllHistory);

    // Close dialogs when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.export-dialog') && !e.target.closest('.export-btn') && !e.target.closest('#exportAllBtn')) {
        closeExportDialog();
      }
    });

    // Request initial data
    vscode.postMessage({ type: 'loadSessions' });
  }

  // Render sessions list
  function renderSessions(sessions) {
    if (sessions.length === 0) {
      sessionsList.innerHTML = `
        <div class="empty-state">
          <h3>No chat history yet</h3>
          <p>Start chatting with DeepSeek Moby to see your conversations here.</p>
        </div>
      `;
      return;
    }

    sessionsList.innerHTML = sessions.map(session => `
      <div class="session-item ${session.id === currentSessionId ? 'active' : ''}" 
           data-session-id="${session.id}">
        <div class="session-title">
          <span>${escapeHtml(session.title)}</span>
          <span class="message-count">${session.messages.length} messages</span>
        </div>
        <div class="session-meta">
          <span>${formatDate(session.updatedAt)}</span>
          <span>${session.model}</span>
        </div>
        ${session.messages.length > 0 ? `
          <div class="session-preview">
            ${escapeHtml(session.messages[session.messages.length - 1].content.substring(0, 100))}
            ${session.messages[session.messages.length - 1].content.length > 100 ? '...' : ''}
          </div>
        ` : ''}
        ${session.tags.length > 0 ? `
          <div class="session-tags">
            ${session.tags.map(tag => `<span class="session-tag">${escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
        <div class="session-actions">
          <button class="open-btn" data-session-id="${session.id}">Open</button>
          <button class="rename-btn" data-session-id="${session.id}">Rename</button>
          <button class="export-btn" data-session-id="${session.id}">Export</button>
          <button class="delete-btn" data-session-id="${session.id}">Delete</button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    document.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.session-actions')) {
          const sessionId = item.dataset.sessionId;
          switchToSession(sessionId);
        }
      });
    });

    document.querySelectorAll('.open-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.sessionId;
        switchToSession(sessionId);
      });
    });

    document.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.sessionId;
        renameSession(sessionId);
      });
    });

    document.querySelectorAll('.export-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.sessionId;
        showExportSessionDialog(sessionId, btn);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.sessionId;
        vscode.postMessage({ type: 'deleteSession', sessionId });
      });
    });
  }

  // Helper functions
  function switchToSession(sessionId) {
    vscode.postMessage({ type: 'switchToSession', sessionId });
  }

  function renameSession(sessionId) {
    const session = currentSessions.find(s => s.id === sessionId);
    if (!session) return;

    // Request rename via backend (uses VSCode's input box)
    vscode.postMessage({
      type: 'requestRename',
      sessionId,
      currentTitle: session.title
    });
  }

  function searchSessions() {
    const query = searchInput.value.trim();
    if (query) {
      vscode.postMessage({ type: 'searchSessions', query });
    } else {
      loadSessions();
    }
  }

  function loadSessions() {
    vscode.postMessage({ type: 'loadSessions' });
  }

  // Export dialog functions
  function createExportDialog(isAll, sessionId = null) {
    // Remove any existing dialog
    closeExportDialog();

    const dialog = document.createElement('div');
    dialog.className = 'export-dialog';
    dialog.innerHTML = `
      <div class="export-dialog-title">${isAll ? 'Export All History' : 'Export Chat'}</div>
      <div class="export-dialog-options">
        <button class="export-format-btn" data-format="json">
          <span class="format-icon">{ }</span>
          <span class="format-name">JSON</span>
          <span class="format-desc">Structured data</span>
        </button>
        <button class="export-format-btn" data-format="markdown">
          <span class="format-icon">MD</span>
          <span class="format-name">Markdown</span>
          <span class="format-desc">Formatted text</span>
        </button>
        <button class="export-format-btn" data-format="txt">
          <span class="format-icon">TXT</span>
          <span class="format-name">Plain Text</span>
          <span class="format-desc">Simple text</span>
        </button>
      </div>
    `;

    // Add click handlers for format buttons
    dialog.querySelectorAll('.export-format-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const format = btn.dataset.format;
        if (isAll) {
          vscode.postMessage({ type: 'exportAllHistory', format });
        } else {
          vscode.postMessage({ type: 'exportSession', sessionId, format });
        }
        closeExportDialog();
      });
    });

    return dialog;
  }

  function showExportAllDialog(e) {
    e.stopPropagation();
    const dialog = createExportDialog(true);

    // Position below the export button
    const rect = exportAllBtn.getBoundingClientRect();
    dialog.style.position = 'fixed';
    dialog.style.top = `${rect.bottom + 5}px`;
    dialog.style.right = '10px';

    document.body.appendChild(dialog);
  }

  function showExportSessionDialog(sessionId, btn) {
    const dialog = createExportDialog(false, sessionId);

    // Position near the button
    const rect = btn.getBoundingClientRect();
    dialog.style.position = 'fixed';
    dialog.style.top = `${rect.bottom + 5}px`;
    dialog.style.left = `${Math.max(10, rect.left - 100)}px`;

    document.body.appendChild(dialog);
  }

  function closeExportDialog() {
    const existing = document.querySelector('.export-dialog');
    if (existing) {
      existing.remove();
    }
  }

  // Stats dialog functions
  function showStatsDialog(stats, balance) {
    closeStatsDialog();

    const modelEntries = Object.entries(stats.byModel || {});
    const modelStatsHtml = modelEntries.length > 0
      ? modelEntries.map(([model, count]) => `<div class="stats-model-item">${model}: ${count}</div>`).join('')
      : '<div class="stats-model-item">None</div>';

    const avgMessages = stats.totalSessions > 0
      ? (stats.totalMessages / stats.totalSessions).toFixed(1)
      : '0';

    // Format balance display
    let balanceHtml = '';
    if (balance) {
      const currencySymbol = balance.currency === 'USD' ? '$' : (balance.currency === 'CNY' ? '¥' : '');
      const statusClass = balance.available ? 'balance-ok' : 'balance-low';
      balanceHtml = `
        <div class="stats-row stats-row-balance ${statusClass}">
          <span class="stats-row-label">💰 API Balance</span>
          <span class="stats-row-value">${currencySymbol}${balance.balance} ${balance.currency}</span>
        </div>
      `;
    }

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'stats-dialog-overlay';
    overlay.addEventListener('click', closeStatsDialog);

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'stats-dialog';
    dialog.innerHTML = `
      <div class="stats-dialog-title">
        <span>Chat Statistics</span>
        <button class="stats-dialog-close">×</button>
      </div>
      <div class="stats-dialog-content">
        ${balanceHtml}
        <div class="stats-row">
          <span class="stats-row-label">Total Sessions</span>
          <span class="stats-row-value">${stats.totalSessions}</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">Total Messages</span>
          <span class="stats-row-value">${stats.totalMessages}</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">Total Tokens</span>
          <span class="stats-row-value">${stats.totalTokens.toLocaleString()}</span>
        </div>
        <div class="stats-row">
          <span class="stats-row-label">Avg Messages/Session</span>
          <span class="stats-row-value">${avgMessages}</span>
        </div>
        <div class="stats-row stats-row-vertical">
          <span class="stats-row-label">By Model:</span>
          <div class="stats-model-list">${modelStatsHtml}</div>
        </div>
      </div>
    `;

    // Add close handler
    dialog.querySelector('.stats-dialog-close').addEventListener('click', closeStatsDialog);

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);
  }

  function closeStatsDialog() {
    const overlay = document.querySelector('.stats-dialog-overlay');
    const dialog = document.querySelector('.stats-dialog');
    if (overlay) overlay.remove();
    if (dialog) dialog.remove();
  }

  function clearAllHistory() {
    vscode.postMessage({ type: 'clearAllHistory' });
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins} min ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Message handler
  window.addEventListener('message', (event) => {
    const message = event.data;
    
    switch (message.type) {
      case 'sessionsLoaded':
        currentSessions = message.sessions;
        renderSessions(currentSessions);
        break;
        
      case 'searchResults':
        currentSessions = message.sessions;
        renderSessions(currentSessions);
        break;
        
      case 'sessionSwitched':
        currentSessionId = message.sessionId;
        renderSessions(currentSessions);
        break;

      case 'statsLoaded':
        showStatsDialog(message.stats, message.balance);
        break;
    }
  });

  // Initialize
  document.addEventListener('DOMContentLoaded', init);
})();