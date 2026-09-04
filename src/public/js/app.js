(function() {
  'use strict';

  // Initialize Socket.io
  const socket = io();

  // State
  let activeSource = 'deezer';
  let searchDebounceTimer = null;
  let isQueuePaused = false;

  // Queue panel state
  const queueItems = new Map(); // jobId -> { data, rowEl }
  const errorItems = new Map(); // jobId -> data (persistent errors)
  const maxPercents = new Map(); // jobId -> highest percent seen (prevent bar regression)
  let queuePanelCollapsed = false;
  let showingErrorsView = false;

  // DOM Elements
  const toggleDeezerBtn = document.getElementById('toggle-deezer');
  const toggleSpotifyBtn = document.getElementById('toggle-spotify');
  const searchInput = document.getElementById('search-input');
  const searchSpinner = document.getElementById('search-spinner');
  const resultsList = document.getElementById('results-list');
  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
  const urlForm = document.getElementById('url-form');
  const urlInput = document.getElementById('url-input');

  const PLACEHOLDER_COVER = '/images/placeholder.svg';

  /**
   * Validate and resolve cover image URL, falling back cleanly to PLACEHOLDER_COVER
   */
  function resolveCoverUrl(url) {
    if (!url || typeof url !== 'string' || !url.trim() || url.trim() === 'null' || url.trim() === 'undefined') {
      return PLACEHOLDER_COVER;
    }
    return url.trim();
  }

  // ==========================================
  // BUILD QUEUE PANEL DOM (once)
  // ==========================================
  const queuePanel = document.createElement('div');
  queuePanel.id = 'queue-panel';
  queuePanel.className = 'queue-panel';
  queuePanel.innerHTML = `
    <div class="queue-panel-header" id="queue-panel-header">
      <div class="queue-panel-title">
        <span class="queue-icon">⬇</span>
        <span id="queue-panel-label">Download Queue</span>
        <span class="queue-badge" id="queue-badge">0</span>
      </div>
      <div class="queue-header-actions">
        <button class="queue-btn queue-pause-btn" id="queue-pause-btn" title="Pause or resume queue dispatch">⏸ Pause</button>
        <button class="queue-btn queue-stopall-btn" id="queue-stopall-btn" title="Stop all active and pending downloads">✕ Stop All</button>
        <button class="queue-errors-btn" id="queue-errors-btn" style="display:none;" title="View download error log">
          ⚠ Errors (<span id="queue-errors-count">0</span>)
        </button>
        <button class="queue-toggle-btn" id="queue-toggle-btn" title="Collapse / Expand" aria-label="Collapse">−</button>
      </div>
    </div>
    <div class="queue-panel-body" id="queue-panel-body">
      <div class="queue-rows" id="queue-rows"></div>
      <div class="queue-empty" id="queue-empty">No active downloads</div>
    </div>
    <div class="queue-panel-body queue-errors-body" id="queue-errors-body" style="display:none;">
      <div class="queue-errors-title-bar">
        <span>⚠ Download Errors</span>
        <button class="queue-errors-clear-btn" id="queue-errors-clear-btn" title="Clear all error records">Clear all</button>
      </div>
      <div class="queue-rows" id="queue-errors-rows"></div>
      <div class="queue-empty" id="queue-errors-empty">No recorded errors</div>
    </div>
  `;
  document.body.appendChild(queuePanel);

  const queueToggleBtn = document.getElementById('queue-toggle-btn');
  const queuePauseBtn = document.getElementById('queue-pause-btn');
  const queueStopAllBtn = document.getElementById('queue-stopall-btn');
  const queueErrorsBtn = document.getElementById('queue-errors-btn');
  const queueErrorsCount = document.getElementById('queue-errors-count');
  const queueErrorsClearBtn = document.getElementById('queue-errors-clear-btn');
  const queuePanelBody = document.getElementById('queue-panel-body');
  const queueErrorsBody = document.getElementById('queue-errors-body');
  const queueBadge = document.getElementById('queue-badge');
  const queueRows = document.getElementById('queue-rows');
  const queueErrorsRows = document.getElementById('queue-errors-rows');
  const queueEmpty = document.getElementById('queue-empty');
  const queueErrorsEmpty = document.getElementById('queue-errors-empty');

  // Pause / Resume Toggle
  queuePauseBtn.addEventListener('click', () => {
    if (isQueuePaused) {
      socket.emit('queue:resume');
    } else {
      socket.emit('queue:pause');
    }
  });

  // Stop / Cancel All
  queueStopAllBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to stop all active and pending downloads?')) {
      socket.emit('queue:cancel_all');
    }
  });

  queueToggleBtn.addEventListener('click', () => {
    queuePanelCollapsed = !queuePanelCollapsed;
    queuePanel.classList.toggle('collapsed', queuePanelCollapsed);
    queueToggleBtn.textContent = queuePanelCollapsed ? '+' : '−';
    queueToggleBtn.setAttribute('aria-label', queuePanelCollapsed ? 'Expand' : 'Collapse');
  });

  queueErrorsBtn.addEventListener('click', () => {
    showingErrorsView = !showingErrorsView;
    if (showingErrorsView) {
      if (queuePanelCollapsed) {
        queuePanelCollapsed = false;
        queuePanel.classList.remove('collapsed');
        queueToggleBtn.textContent = '−';
      }
      queuePanelBody.style.display = 'none';
      queueErrorsBody.style.display = 'block';
      queueErrorsBtn.classList.add('active');
    } else {
      queueErrorsBody.style.display = 'none';
      queuePanelBody.style.display = 'block';
      queueErrorsBtn.classList.remove('active');
    }
  });

  queueErrorsClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    errorItems.clear();
    queueErrorsRows.innerHTML = '';
    updateErrorsView();
  });

  function showPanel() {
    queuePanel.classList.add('visible');
  }

  function updateBadge() {
    const activeCount = [...queueItems.values()].filter(
      item => item.data.type === 'progress'
    ).length;
    queueBadge.textContent = queueItems.size;
    queueBadge.className = 'queue-badge' + (activeCount > 0 ? ' queue-badge-active' : '');
    queueEmpty.style.display = queueItems.size === 0 ? 'block' : 'none';
  }

  function updateErrorsView() {
    queueErrorsCount.textContent = errorItems.size;
    queueErrorsBtn.style.display = errorItems.size > 0 ? 'inline-flex' : 'none';
    queueErrorsEmpty.style.display = errorItems.size === 0 ? 'block' : 'none';
    if (errorItems.size === 0 && showingErrorsView) {
      showingErrorsView = false;
      queueErrorsBody.style.display = 'none';
      queuePanelBody.style.display = 'block';
      queueErrorsBtn.classList.remove('active');
    }
  }

  // ==========================================
  // QUEUE ROW MANAGEMENT
  // ==========================================
  function upsertQueueRow(jobId, data) {
    showPanel();
    const existing = queueItems.get(jobId);

    // Prevent bar regression: always show the highest percent seen for this job
    const prevMax = maxPercents.get(jobId) || 0;
    const rawPct = typeof data.percent === 'number' ? data.percent : prevMax;
    const displayPct = data.type === 'done' ? 100 : Math.max(rawPct, prevMax);
    maxPercents.set(jobId, displayPct);
    const patchedData = { ...data, percent: displayPct };

    if (existing) {
      updateQueueRow(existing.rowEl, patchedData);
      existing.data = patchedData;
      queueItems.set(jobId, existing);
    } else {
      const rowEl = createQueueRow(jobId, patchedData);
      queueRows.appendChild(rowEl); // append in chronological order
      queueItems.set(jobId, { data: patchedData, rowEl });
    }

    updateBadge();

    // Auto-dismiss terminal states after delay
    if (data.type === 'done') {
      setTimeout(() => removeQueueRow(jobId), 8000);
    }
  }

  function createQueueRow(jobId, data) {
    const rowEl = document.createElement('div');
    rowEl.className = `queue-row queue-row-${data.type || 'progress'}`;
    rowEl.dataset.jobId = jobId;

    const coverUrl = resolveCoverUrl(data.cover || data.coverUrl);
    const pct = typeof data.percent === 'number' ? data.percent : 0;
    const isTerminal = data.type === 'done' || data.type === 'error' || data.type === 'skipped';

    rowEl.innerHTML = `
      <div class="queue-row-main">
        <img src="${escapeHtml(coverUrl)}" alt="" class="queue-row-cover" loading="lazy"
             onerror="this.onerror=null; this.src='${PLACEHOLDER_COVER}';">
        <div class="queue-row-info">
          <div class="queue-row-title">${escapeHtml(data.title || '...')}</div>
          <div class="queue-row-artist">${escapeHtml(data.artist || '')}</div>
        </div>
        <div class="queue-row-right">
          <div class="queue-row-status queue-status-${data.type || 'progress'}">${statusIcon(data.type)}${escapeHtml(shortStatus(data.status, data.type, pct))}</div>
          ${!isTerminal ? `<button class="queue-row-cancel-btn" title="Cancel this download">✕</button>` : ''}
        </div>
      </div>
      <div class="queue-row-bar-wrap">
        <div class="queue-row-bar-fill" style="width:${pct}%"></div>
      </div>
    `;

    const cancelBtn = rowEl.querySelector('.queue-row-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('queue:cancel_item', { jobId });
      });
    }

    return rowEl;
  }

  function updateQueueRow(rowEl, data) {
    const coverUrl = resolveCoverUrl(data.cover || data.coverUrl);
    const pct = typeof data.percent === 'number' ? data.percent : 0;
    const type = data.type || 'progress';

    rowEl.className = `queue-row queue-row-${type}`;

    const img = rowEl.querySelector('.queue-row-cover');
    if (img && data.cover) img.src = coverUrl;

    const titleEl = rowEl.querySelector('.queue-row-title');
    if (titleEl && data.title) titleEl.textContent = data.title;

    const artistEl = rowEl.querySelector('.queue-row-artist');
    if (artistEl) artistEl.textContent = data.artist || '';

    const fillEl = rowEl.querySelector('.queue-row-bar-fill');
    if (fillEl) fillEl.style.width = `${pct}%`;

    const statusEl = rowEl.querySelector('.queue-row-status');
    if (statusEl) {
      statusEl.className = `queue-row-status queue-status-${type}`;
      statusEl.innerHTML = statusIcon(type) + escapeHtml(shortStatus(data.status, type, pct));
    }

    const cancelBtn = rowEl.querySelector('.queue-row-cancel-btn');
    if (cancelBtn && (type === 'done' || type === 'error' || type === 'skipped')) {
      cancelBtn.style.display = 'none';
    }
  }

  function removeQueueRow(jobId) {
    const item = queueItems.get(jobId);
    if (!item) return;
    item.rowEl.classList.add('queue-row-leaving');
    setTimeout(() => {
      if (item.rowEl.parentNode) item.rowEl.parentNode.removeChild(item.rowEl);
      queueItems.delete(jobId);
      maxPercents.delete(jobId);
      updateBadge();
      if (queueItems.size === 0) queuePanel.classList.remove('visible');
    }, 350);
  }

  function statusIcon(type) {
    switch (type) {
      case 'done':    return '<span class="q-icon q-icon-done">✓</span> ';
      case 'error':   return '<span class="q-icon q-icon-error">✗</span> ';
      case 'skipped': return '<span class="q-icon q-icon-skip">⚠</span> ';
      default:        return '';
    }
  }

  function shortStatus(status, type, percent) {
    if (type === 'progress') {
      return typeof percent === 'number' ? `${percent}%` : '…';
    }
    if (!status) return '';
    return status.length > 24 ? status.slice(0, 24) + '…' : status;
  }

  function createErrorRow(jobId, data) {
    const rowEl = document.createElement('div');
    rowEl.className = 'queue-row queue-row-error queue-row-clickable';
    rowEl.dataset.jobId = jobId;

    const coverUrl = resolveCoverUrl(data.cover || data.coverUrl);
    const errMsg = data.status || data.error || 'Unknown error';

    rowEl.innerHTML = `
      <div class="queue-row-main">
        <img src="${escapeHtml(coverUrl)}" alt="" class="queue-row-cover" loading="lazy"
             onerror="this.onerror=null; this.src='${PLACEHOLDER_COVER}';">
        <div class="queue-row-info">
          <div class="queue-row-title">${escapeHtml(data.title || '...')}</div>
          <div class="queue-row-artist">${escapeHtml(data.artist || '')}</div>
        </div>
        <div class="queue-row-right">
          <div class="queue-row-status queue-status-error">
            <span class="q-icon q-icon-error">✗</span> Failed
            <span class="queue-expand-icon">▼</span>
          </div>
        </div>
      </div>
      <div class="queue-row-error-detail" style="display: none;">
        <div class="queue-error-reason">
          <strong>Failure reason:</strong>
          <div class="queue-error-msg">${escapeHtml(errMsg)}</div>
        </div>
      </div>
    `;

    rowEl.addEventListener('click', () => {
      const detail = rowEl.querySelector('.queue-row-error-detail');
      const icon = rowEl.querySelector('.queue-expand-icon');
      if (!detail) return;
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      if (icon) icon.textContent = isOpen ? '▼' : '▲';
    });

    return rowEl;
  }

  // ==========================================
  // ALERT TOAST NOTIFICATIONS
  // ==========================================
  const toastContainer = document.getElementById('toast-container');

  function showAlertToast(message, type = 'error', autoDismiss = 6000) {
    if (!toastContainer) return;
    const el = document.createElement('div');
    el.className = `alert-toast alert-toast-${type}`;
    el.innerHTML = `
      <span class="alert-toast-icon">${type === 'error' ? '✗' : '⚠'}</span>
      <span class="alert-toast-msg">${escapeHtml(message)}</span>
      <button class="alert-toast-close" aria-label="Close">×</button>
    `;
    el.querySelector('.alert-toast-close').addEventListener('click', () => dismissAlertToast(el));
    toastContainer.appendChild(el);
    if (autoDismiss) setTimeout(() => dismissAlertToast(el), autoDismiss);
  }

  function dismissAlertToast(el) {
    el.classList.add('alert-toast-leaving');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }

  // ==========================================
  // BATCH MANUAL REVIEW MODAL COMPONENT
  // ==========================================
  const reviewModal = document.createElement('div');
  reviewModal.id = 'batch-review-modal';
  reviewModal.className = 'review-modal-overlay';
  reviewModal.style.display = 'none';
  document.body.appendChild(reviewModal);

  function renderBatchReviewModal(items) {
    if (!items || !items.length) return;

    reviewModal.innerHTML = `
      <div class="review-modal-card">
        <div class="review-modal-header">
          <h2>🔍 Unmatched Tracks Review (${items.length})</h2>
          <p>The following tracks could not be automatically matched with high confidence. Pick a YouTube source candidate or skip each track below.</p>
        </div>
        <div class="review-modal-body">
          ${items.map((item, idx) => `
            <div class="review-item-card" data-job-id="${escapeHtml(item.jobId)}">
              <div class="review-item-header">
                <img src="${escapeHtml(resolveCoverUrl(item.cover || item.coverUrl))}" class="review-item-cover" alt="" onerror="this.onerror=null; this.src='${PLACEHOLDER_COVER}';">
                <div class="review-item-meta">
                  <div class="review-item-title">${escapeHtml(item.title)}</div>
                  <div class="review-item-artist">${escapeHtml(item.artist)} &bull; ${formatDuration(item.duration)}</div>
                </div>
              </div>
              <div class="review-candidates-label">Select YouTube Candidate:</div>
              <div class="review-candidates-grid">
                ${(item.candidates || []).map((cand, cIdx) => `
                  <label class="candidate-card ${cIdx === 0 ? 'selected' : ''}">
                    <input type="radio" name="cand_${escapeHtml(item.jobId)}" value="${escapeHtml(cand.url)}" ${cIdx === 0 ? 'checked' : ''}>
                    <div class="candidate-info">
                      <div class="candidate-title">${escapeHtml(cand.title)}</div>
                      <div class="candidate-channel">📺 ${escapeHtml(cand.channel)} &bull; ⏱ ${formatDuration(cand.duration)}</div>
                    </div>
                  </label>
                `).join('')}
                <label class="candidate-card candidate-card-skip">
                  <input type="radio" name="cand_${escapeHtml(item.jobId)}" value="skip">
                  <div class="candidate-info">
                    <div class="candidate-title">⏭ Skip this track</div>
                    <div class="candidate-channel">Do not download this item</div>
                  </div>
                </label>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="review-modal-footer">
          <button id="review-submit-btn" class="btn btn-primary">Confirm & Download Selected</button>
        </div>
      </div>
    `;

    reviewModal.style.display = 'flex';

    // Interactive card selection
    reviewModal.querySelectorAll('.candidate-card input[type="radio"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const grid = radio.closest('.review-candidates-grid');
        grid.querySelectorAll('.candidate-card').forEach(c => c.classList.remove('selected'));
        radio.closest('.candidate-card').classList.add('selected');
      });
    });

    const submitBtn = reviewModal.querySelector('#review-submit-btn');
    submitBtn.addEventListener('click', () => {
      const choices = {};
      items.forEach(item => {
        const selected = reviewModal.querySelector(`input[name="cand_${item.jobId}"]:checked`);
        choices[item.jobId] = selected ? selected.value : 'skip';
      });
      socket.emit('review:submit', { choices });
      reviewModal.style.display = 'none';
      showAlertToast(`Submitted review choices for ${items.length} track(s)`, 'skip', 4000);
    });
  }

  // ==========================================
  // SOURCE TOGGLE HANDLERS
  // ==========================================
  if (toggleDeezerBtn) {
    toggleDeezerBtn.addEventListener('click', () => {
      if (activeSource === 'deezer') return;
      activeSource = 'deezer';
      toggleDeezerBtn.classList.add('active');
      if (toggleSpotifyBtn) toggleSpotifyBtn.classList.remove('active');
      triggerSearch();
    });
  }

  if (toggleSpotifyBtn && !toggleSpotifyBtn.classList.contains('disabled')) {
    toggleSpotifyBtn.addEventListener('click', () => {
      if (activeSource === 'spotify') return;
      activeSource = 'spotify';
      toggleSpotifyBtn.classList.add('active');
      if (toggleDeezerBtn) toggleDeezerBtn.classList.remove('active');
      triggerSearch();
    });
  }

  // ==========================================
  // DEBOUNCED SEARCH HANDLER (300ms)
  // ==========================================
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      if (searchSpinner) searchSpinner.style.display = 'block';
      searchDebounceTimer = setTimeout(() => { triggerSearch(); }, 300);
    });
  }

  function triggerSearch() {
    const query = searchInput ? searchInput.value.trim() : '';
    if (!query) {
      if (searchSpinner) searchSpinner.style.display = 'none';
      renderEmptyState('Type an artist or track name to start searching.');
      return;
    }
    socket.emit('search', { query, source: activeSource });
  }

  // ==========================================
  // RENDER SEARCH RESULTS
  // ==========================================
  socket.on('search:results', (data) => {
    if (searchSpinner) searchSpinner.style.display = 'none';
    const { results = [], query, source } = data || {};

    if (resultsTitle) resultsTitle.textContent = `Results (${source.toUpperCase()})`;
    if (resultsCount) resultsCount.textContent = `${results.length} results`;

    if (!results.length) {
      renderEmptyState(`No results found for "${query}" on ${source.toUpperCase()}.`);
      return;
    }

    resultsList.innerHTML = '';
    results.forEach(track => {
      const itemEl = document.createElement('div');
      itemEl.className = 'track-item';

      const coverUrl = resolveCoverUrl(track.coverUrl || track.cover);
      const coverHtml = `<img src="${escapeHtml(coverUrl)}" alt="Cover" class="track-cover" loading="lazy" onerror="this.onerror=null; this.src='${PLACEHOLDER_COVER}';">`;
      const durationStr = formatDuration(track.duration);

      itemEl.innerHTML = `
        ${coverHtml}
        <div class="track-details">
          <div class="track-title">${escapeHtml(track.title)}</div>
          <div class="track-artist">${escapeHtml(track.artist)}</div>
          <div class="track-meta">
            <span>${escapeHtml(track.album || '')}</span>
            ${track.year ? `<span>&bull; ${escapeHtml(track.year)}</span>` : ''}
          </div>
        </div>
        <div class="track-duration">${durationStr}</div>
        <button class="btn btn-primary btn-icon add-btn" title="Download">+</button>
      `;

      const addBtn = itemEl.querySelector('.add-btn');
      addBtn.addEventListener('click', () => {
        addBtn.disabled = true;
        addBtn.textContent = '✓';
        socket.emit('queue:add', { item: track, source: activeSource });
      });

      resultsList.appendChild(itemEl); // preserve exact search relevance order (0..N)
    });
  });

  socket.on('search:error', (data) => {
    if (searchSpinner) searchSpinner.style.display = 'none';
    showAlertToast(data.message || 'Error occurred during search', 'error');
  });

  function renderEmptyState(message) {
    if (!resultsList) return;
    if (resultsTitle) resultsTitle.textContent = 'Tracks';
    if (resultsCount) resultsCount.textContent = '0 results';
    resultsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  // ==========================================
  // DIRECT URL & CSV DRAG-AND-DROP FILE HANDLER
  // ==========================================
  
  function handleCsvFile(file) {
    if (!file) return;
    const fileName = file.name || '';
    const fileType = file.type || '';
    const isCsv = fileName.toLowerCase().endsWith('.csv') || 
                  fileType.includes('csv') || 
                  fileType.includes('excel') || 
                  fileType.includes('text') || 
                  fileType === '';

    if (!isCsv && !fileName.toLowerCase().endsWith('.csv')) {
      showAlertToast(`File "${fileName}" is not a .csv file. Please drop a valid CSV playlist file.`, 'error');
      return;
    }

    showAlertToast(`Reading CSV file "${fileName}"...`, 'skip', 4000);

    const reader = new FileReader();
    reader.onload = (e) => {
      const csvText = e.target.result;
      socket.emit('queue:add_csv', { csvText, filename: fileName, source: activeSource });
    };
    reader.onerror = () => {
      showAlertToast('Failed to read CSV file', 'error');
    };
    reader.readAsText(file);
  }

  const csvFileInput = document.getElementById('csv-file-input');
  const browseCsvBtn = document.getElementById('browse-csv-btn');

  if (browseCsvBtn && csvFileInput) {
    browseCsvBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      csvFileInput.click();
    });
  }

  if (csvFileInput) {
    csvFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleCsvFile(e.target.files[0]);
        csvFileInput.value = '';
      }
    });
  }

  let dragCounter = 0;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
    }, false);
    document.addEventListener(eventName, (e) => {
      e.preventDefault();
    }, false);
  });

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (urlInput) urlInput.classList.add('drag-over');
    const card = document.getElementById('url-card');
    if (card) card.classList.add('drag-over');
  }, false);

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, false);

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (urlInput) urlInput.classList.remove('drag-over');
      const card = document.getElementById('url-card');
      if (card) card.classList.remove('drag-over');
    }
  }, false);

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (urlInput) urlInput.classList.remove('drag-over');
    const card = document.getElementById('url-card');
    if (card) card.classList.remove('drag-over');

    const dt = e.dataTransfer;
    const files = dt ? dt.files : null;

    if (files && files.length > 0) {
      handleCsvFile(files[0]);
    }
  }, false);

  if (urlForm) {
    urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = urlInput ? urlInput.value.trim() : '';
      if (!url) return;
      socket.emit('queue:add', { url, source: activeSource });
      if (urlInput) urlInput.value = '';
    });
  }

  // ==========================================
  // SOCKET QUEUE EVENTS → QUEUE PANEL
  // ==========================================
  socket.on('queue:state', (data) => {
    const { isPaused } = data || {};
    isQueuePaused = Boolean(isPaused);
    queuePauseBtn.textContent = isQueuePaused ? '▶ Resume' : '⏸ Pause';
    queuePauseBtn.classList.toggle('active', isQueuePaused);
  });

  socket.on('queue:info', (data) => {
    if (data && data.message) {
      showAlertToast(data.message, 'skip', 4000);
    }
  });

  socket.on('queue:added', (data) => {
    upsertQueueRow(data.jobId, {
      title: data.title,
      artist: data.artist,
      cover: data.cover || data.coverUrl,
      status: 'Pending...',
      percent: 0,
      type: 'progress'
    });
    if (queuePanelCollapsed) {
      queuePanelCollapsed = false;
      queuePanel.classList.remove('collapsed');
      queueToggleBtn.textContent = '−';
    }
  });

  socket.on('queue:progress', (data) => {
    upsertQueueRow(data.jobId, {
      title: data.title,
      artist: data.artist,
      cover: data.cover || data.coverUrl,
      status: data.status,
      percent: data.percent,
      type: data.type || 'progress'
    });
  });

  socket.on('queue:done', (data) => {
    upsertQueueRow(data.jobId, {
      title: data.title,
      artist: data.artist,
      cover: data.cover || data.coverUrl,
      status: data.message || 'Downloaded',
      percent: 100,
      type: 'done'
    });
  });

  socket.on('queue:skipped', (data) => {
    const reason = data.reason || 'Skipped';
    upsertQueueRow(data.jobId || 'skip_' + Date.now(), {
      title: data.title,
      artist: data.artist,
      cover: data.cover || data.coverUrl,
      status: reason,
      percent: 100,
      type: 'skipped'
    });
    showAlertToast(`⚠ ${data.title || ''} — ${reason}`, 'skip', 5000);
    setTimeout(() => removeQueueRow(data.jobId || ''), 10000);
  });

  socket.on('queue:canceled', (data) => {
    if (data && data.jobId) {
      removeQueueRow(data.jobId);
    }
  });

  socket.on('queue:canceled_all', () => {
    for (const jobId of queueItems.keys()) {
      removeQueueRow(jobId);
    }
    queueItems.clear();
    maxPercents.clear();
    updateBadge();
    showAlertToast('Stopped all queue downloads', 'skip', 4000);
  });

  socket.on('queue:error', (data) => {
    const errMsg = data.error || 'Download failed';
    const jobId = data.jobId || 'err_' + Date.now();
    const errData = {
      title: data.title || 'Error',
      artist: data.artist || '',
      cover: data.cover || data.coverUrl,
      status: errMsg,
      percent: 100,
      type: 'error'
    };

    upsertQueueRow(jobId, errData);

    if (!errorItems.has(jobId)) {
      errorItems.set(jobId, errData);
      const errRowEl = createErrorRow(jobId, errData);
      queueErrorsRows.appendChild(errRowEl);
      updateErrorsView();
    }

    showAlertToast(`✗ ${errData.title} — ${errMsg}`, 'error', 8000);
    setTimeout(() => removeQueueRow(jobId), 15000);
  });

  socket.on('batch:review_ready', (data) => {
    const { items = [] } = data || {};
    renderBatchReviewModal(items);
  });

  socket.on('playlist:import_complete', (data) => {
    const { playlistName, trackCount, tracks } = data || {};
    if (!playlistName || !tracks || !tracks.length) return;

    showPanel();
    renderPlaylistConfirmCard(playlistName, trackCount || tracks.length, tracks);
  });

  function renderPlaylistConfirmCard(playlistName, trackCount, tracks) {
    const existing = document.getElementById('playlist-confirm-card');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    const card = document.createElement('div');
    card.id = 'playlist-confirm-card';
    card.className = 'playlist-confirm-card';
    card.innerHTML = `
      <div class="playlist-confirm-header">
        <span class="playlist-confirm-icon">📂</span>
        <div class="playlist-confirm-info">
          <div class="playlist-confirm-title">Create Navidrome Playlist?</div>
          <div class="playlist-confirm-sub"><strong>"${escapeHtml(playlistName)}"</strong> &bull; ${trackCount} track${trackCount > 1 ? 's' : ''} downloaded</div>
        </div>
      </div>
      <div class="playlist-confirm-actions">
        <button class="btn btn-sm btn-primary" id="pl-confirm-btn">Add to Navidrome</button>
        <button class="btn btn-sm btn-outline" id="pl-skip-btn">Skip</button>
      </div>
    `;

    const confirmBtn = card.querySelector('#pl-confirm-btn');
    const skipBtn = card.querySelector('#pl-skip-btn');

    confirmBtn.addEventListener('click', () => {
      socket.emit('playlist:create_confirm', { playlistName, tracks });
      if (card.parentNode) card.parentNode.removeChild(card);
    });

    skipBtn.addEventListener('click', () => {
      socket.emit('playlist:create_skip', { playlistName });
      if (card.parentNode) card.parentNode.removeChild(card);
    });

    if (queuePanelBody) {
      queuePanelBody.insertBefore(card, queuePanelBody.firstChild);
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================
  function formatDuration(sec) {
    if (sec === undefined || sec === null || isNaN(sec) || sec <= 0) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initial search
  triggerSearch();

})();
