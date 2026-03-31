/**
 * app.js – Belabox 2.0 main application
 *
 * Bootstraps all modules, wires up UI events, and manages the properties
 * panel so that it reflects the currently selected scene layer.
 *
 * Supports:
 *  - Server-side hardware RTMP/SRT ingest (composited by FFmpeg)
 *  - Browser sources: camera, screen capture, microphone (streamed to server)
 *  - Multi-scene switching (each scene = independent layout + output settings)
 *  - Multi-destination simulcast (Twitch, YouTube, TikTok vertical, etc.)
 */

'use strict';

(function () {
  // ── Initialise modules ────────────────────────────────────────────────────

  const editor = new SceneEditor();
  const sceneManager = new SceneManager(editor);
  const outputManager = new OutputManager();
  const sources = new SourcesManager(editor);
  const overlays = new OverlaysManager(editor);
  const stream = new StreamController(editor);

  // Expose globally so stream.js and scenes.js can access them
  window._sceneManager = sceneManager;
  window._outputManager = outputManager;

  // Initial render of output list
  outputManager._renderList();
  outputManager._syncPreviewSelect();

  // ── Output destinations ───────────────────────────────────────────────────

  document.getElementById('btn-add-output').addEventListener('click', () => {
    // Reset modal
    document.getElementById('new-output-name').value = '';
    document.getElementById('new-output-protocol').value = 'rtmp';
    document.getElementById('new-output-url').value = '';
    document.getElementById('new-output-key').value = '';
    document.getElementById('new-output-vbitrate').value = '3000';
    document.getElementById('new-output-abitrate').value = '128';
    const resEl = document.getElementById('new-output-resolution');
    if (resEl) resEl.value = '';
    const hintEl = document.getElementById('output-preset-hint');
    if (hintEl) hintEl.style.display = 'none';
    openModal('modal-add-output');
  });

  // Platform preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      outputManager.addFromPreset(btn.dataset.preset);
    });
  });

  document.getElementById('btn-confirm-add-output').addEventListener('click', () => {
    try {
      outputManager.addFromModal();
      closeModal('modal-add-output');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Toolbar / source buttons ──────────────────────────────────────────────

  document.getElementById('btn-add-source').addEventListener('click', () => {
    openModal('modal-add-source');
  });

  document.getElementById('btn-add-camera').addEventListener('click', () => addCamera());
  document.getElementById('btn-add-screen').addEventListener('click', () => addScreen());
  document.getElementById('btn-add-mic').addEventListener('click', () => addMicrophone());
  document.getElementById('btn-add-rtmp').addEventListener('click', () => openModal('modal-add-rtmp'));
  document.getElementById('btn-add-srt').addEventListener('click', () => openModal('modal-add-srt'));
  document.getElementById('btn-add-text').addEventListener('click', () => overlays.addText());
  document.getElementById('btn-add-image').addEventListener('click', () => openModal('modal-add-image'));
  document.getElementById('btn-add-browser-url').addEventListener('click', () => openModal('modal-add-browser-url'));

  // Source picker modal
  document.querySelectorAll('.source-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      closeModal('modal-add-source');
      switch (type) {
        case 'camera':     addCamera();             break;
        case 'screen':     addScreen();             break;
        case 'microphone': addMicrophone();         break;
        case 'rtmp':       openModal('modal-add-rtmp'); break;
        case 'rtmp_pull':  openModal('modal-add-rtmp-pull'); break;
        case 'srt':        openModal('modal-add-srt'); break;
        case 'text':       overlays.addText();      break;
        case 'image':      openModal('modal-add-image'); break;
        case 'browser_url': openModal('modal-add-browser-url'); break;
      }
    });
  });

  // ── Browser source helpers ────────────────────────────────────────────────

  async function addCamera() {
    try {
      await sources.addCamera();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function addScreen() {
    try {
      await sources.addScreen();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function addMicrophone() {
    try {
      await sources.addMicrophone();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ── RTMP Ingest modal ─────────────────────────────────────────────────────

  document.getElementById('btn-confirm-add-rtmp').addEventListener('click', () => {
    const name = document.getElementById('rtmp-name-input').value.trim() || 'RTMP Source';
    const key  = document.getElementById('rtmp-key-input').value.trim();
    if (!key) { showToast('Stream key is required', 'error'); return; }
    try {
      sources.addRtmpSource(name, key);
      document.getElementById('rtmp-name-input').value = '';
      document.getElementById('rtmp-key-input').value = '';
      closeModal('modal-add-rtmp');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── RTMP Pull modal ───────────────────────────────────────────────────────

  document.getElementById('btn-confirm-add-rtmp-pull').addEventListener('click', () => {
    const name = document.getElementById('rtmp-pull-name-input').value.trim() || 'RTMP Pull';
    const url  = document.getElementById('rtmp-pull-url-input').value.trim();
    if (!url) { showToast('RTMP URL is required', 'error'); return; }
    try {
      sources.addRtmpPullSource(name, url);
      document.getElementById('rtmp-pull-name-input').value = '';
      document.getElementById('rtmp-pull-url-input').value = '';
      closeModal('modal-add-rtmp-pull');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── SRT modal ─────────────────────────────────────────────────────────────

  document.getElementById('btn-confirm-add-srt').addEventListener('click', () => {
    const name = document.getElementById('srt-name-input').value.trim() || 'SRT Source';
    const url  = document.getElementById('srt-url-input').value.trim();
    if (!url) { showToast('SRT URL is required', 'error'); return; }
    try {
      sources.addSrtSource(name, url);
      document.getElementById('srt-name-input').value = '';
      document.getElementById('srt-url-input').value = '';
      closeModal('modal-add-srt');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Browser URL modal ─────────────────────────────────────────────────────

  document.getElementById('btn-confirm-add-browser-url').addEventListener('click', () => {
    const name = document.getElementById('browser-url-name-input').value.trim() || 'Browser Source';
    const url  = document.getElementById('browser-url-url-input').value.trim();
    const wVal = parseInt(document.getElementById('browser-url-width-input').value, 10);
    const hVal = parseInt(document.getElementById('browser-url-height-input').value, 10);
    if (!url) { showToast('URL is required', 'error'); return; }
    try {
      sources.addBrowserUrl(name, url, {
        width:  !isNaN(wVal) && wVal > 0 ? wVal : undefined,
        height: !isNaN(hVal) && hVal > 0 ? hVal : undefined,
      });
      document.getElementById('browser-url-name-input').value = '';
      document.getElementById('browser-url-url-input').value = '';
      document.getElementById('browser-url-width-input').value = '';
      document.getElementById('browser-url-height-input').value = '';
      closeModal('modal-add-browser-url');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Settings modal ────────────────────────────────────────────────────────

  document.getElementById('btn-settings').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const s = await res.json();
        document.getElementById('settings-auth-enabled').checked = !!s.enabled;
        document.getElementById('settings-username').value = s.username || 'admin';
        document.getElementById('settings-password').value = '';
        document.getElementById('settings-password-confirm').value = '';
        document.getElementById('settings-current-password').value = '';
        const showCurrentPw = s.enabled && s.hasPassword;
        document.getElementById('settings-current-pw-label').style.display = showCurrentPw ? 'block' : 'none';
        document.getElementById('settings-current-password').style.display = showCurrentPw ? 'block' : 'none';
      }
    } catch (_) {}
    openModal('modal-settings');
  });

  document.getElementById('btn-confirm-settings').addEventListener('click', async () => {
    const enabled  = document.getElementById('settings-auth-enabled').checked;
    const username = document.getElementById('settings-username').value.trim();
    const password = document.getElementById('settings-password').value;
    const confirm  = document.getElementById('settings-password-confirm').value;
    const currentPassword = document.getElementById('settings-current-password').value;

    if (password && password !== confirm) {
      showToast('Passwords do not match', 'error');
      return;
    }

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, username, password, currentPassword }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Failed to save settings', 'error'); return; }
      showToast('Settings saved', 'success');
      closeModal('modal-settings');
      if (enabled) showToast('Authentication is now enabled', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Add Image modal ───────────────────────────────────────────────────────

  document.getElementById('btn-confirm-add-image').addEventListener('click', async () => {
    const urlInput  = document.getElementById('img-url-input');
    const fileInput = document.getElementById('img-file-input');
    closeModal('modal-add-image');
    try {
      if (fileInput.files && fileInput.files[0]) {
        await overlays.addImageFromFile(fileInput.files[0]);
        fileInput.value = '';
      } else if (urlInput.value.trim()) {
        await overlays.addImage(urlInput.value.trim());
        urlInput.value = '';
      } else {
        showToast('Please provide an image URL or file', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Scenes ────────────────────────────────────────────────────────────────

  document.getElementById('btn-add-scene').addEventListener('click', () => {
    openModal('modal-add-scene');
  });

  document.getElementById('btn-confirm-add-scene').addEventListener('click', async () => {
    const name = document.getElementById('new-scene-name').value.trim();
    try {
      await sceneManager.createScene(name);
      document.getElementById('new-scene-name').value = '';
      closeModal('modal-add-scene');
      renderSceneList();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Layer order buttons ───────────────────────────────────────────────────

  document.getElementById('btn-layer-up').addEventListener('click', () => {
    if (editor.selectedLayer) editor.layerMoveUp(editor.selectedLayer.id);
  });
  document.getElementById('btn-layer-down').addEventListener('click', () => {
    if (editor.selectedLayer) editor.layerMoveDown(editor.selectedLayer.id);
  });

  // ── Go live / stop button ─────────────────────────────────────────────────

  document.getElementById('btn-go-live').addEventListener('click', () => {
    if (stream.isLive) stream.stopStream();
    else stream.startStream();
  });

  // ── Modal close buttons ───────────────────────────────────────────────────

  document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
    el.addEventListener('click', () => {
      const modalId = el.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // ── Resolution / FPS changes ──────────────────────────────────────────────

  document.getElementById('output-resolution').addEventListener('change', (e) => {
    editor.setResolution(e.target.value);
    // Reset preview dropdown to scene when scene resolution changes
    const previewSel = document.getElementById('preview-output-select');
    if (previewSel) previewSel.value = '';
  });

  document.getElementById('preview-output-select').addEventListener('change', (e) => {
    const res = e.target.value || document.getElementById('output-resolution').value || '1280x720';
    editor.setResolution(res);
  });

  document.addEventListener('resolution-changed', (e) => {
    editor.setResolution(e.detail);
  });

  // ── Server events ─────────────────────────────────────────────────────────

  document.addEventListener('server-state', (e) => {
    const msg = e.detail;
    // Load scenes from server
    if (msg.scenes) {
      sceneManager.loadFromServerState(msg);
      renderSceneList();
      // Load outputs for the active scene
      const activeScene = msg.scenes.find(s => s.id === msg.activeSceneId);
      if (activeScene && activeScene.outputs) {
        outputManager.loadOutputs(activeScene.outputs);
      }
    }
    // Ingest panel
    if (msg.rtmpIngestPort) {
      updateIngestPanel(msg.rtmpIngestPort, msg.activeIngestStreams || {});
    }
  });

  document.addEventListener('scenes-updated', (e) => {
    const { scenes, activeSceneId } = e.detail;
    sceneManager.onScenesUpdated(scenes, activeSceneId);
    renderSceneList();
  });

  document.addEventListener('scene-switched', () => {
    renderSceneList();
  });

  document.addEventListener('scene-activated', (e) => {
    const { sceneId } = e.detail;
    sceneManager.onScenesUpdated(sceneManager.scenes, sceneId);
    renderSceneList();
    showToast(`🎬 Switched to ${(sceneManager.activeScene && sceneManager.activeScene.name) || sceneId}`, '');
  });

  document.addEventListener('ingest-event', (e) => {
    const { type, streamKey } = e.detail;
    if (type === 'ingest_connected') {
      sources.onIngestConnected(streamKey);
      for (const layer of editor.layers) {
        if (layer._input && layer._input.streamKey === streamKey) layer._isActive = true;
      }
      showToast(`📡 ${streamKey} connected`, 'success');
    } else {
      sources.onIngestDisconnected(streamKey);
      for (const layer of editor.layers) {
        if (layer._input && layer._input.streamKey === streamKey) layer._isActive = false;
      }
      showToast(`📡 ${streamKey} disconnected`, '');
    }
    fetch('/api/status').then(r => r.json()).then(s => {
      updateIngestPanel(s.rtmpIngestPort, s.activeIngestStreams || {});
    }).catch(() => {});
  });

  document.addEventListener('source-ended', (e) => {
    showToast(`${e.detail.name} stopped sharing`, '');
  });

  // ── Layer events ──────────────────────────────────────────────────────────

  document.addEventListener('layers-changed', (e) => {
    renderSourceList(e.detail);
    renderLayerList(e.detail);
  });

  document.addEventListener('selection-changed', (e) => {
    renderPropertiesPanel(e.detail);
    renderLayerList(editor.layers);
    renderSourceList(editor.layers);
  });

  // ── Ingest panel ──────────────────────────────────────────────────────────

  function updateIngestPanel(port, activeStreams) {
    const host = location.hostname;
    const url = `rtmp://${host}:${port}/live/<key>`;
    document.getElementById('ingest-url').textContent = url;
    const hintEl = document.getElementById('modal-ingest-url');
    if (hintEl) hintEl.textContent = `rtmp://${host}:${port}/live/<key>`;
    const listEl = document.getElementById('ingest-active-list');
    const keys = Object.keys(activeStreams);
    if (keys.length === 0) {
      listEl.innerHTML = '<span class="ingest-none">None connected</span>';
    } else {
      listEl.innerHTML = keys.map(k => `<span class="ingest-stream-key">● ${esc(k)}</span>`).join('');
    }
  }

  fetch('/api/status').then(r => r.json()).then(s => {
    updateIngestPanel(s.rtmpIngestPort || 1935, s.activeIngestStreams || {});
  }).catch(() => {});

  // ── Scene list rendering ──────────────────────────────────────────────────

  function renderSceneList() {
    const ul = document.getElementById('scene-list');
    const scenes = sceneManager.scenes;
    const activeId = sceneManager.activeSceneId;
    ul.innerHTML = '';
    for (const scene of scenes) {
      const li = document.createElement('li');
      li.className = `scene-item${scene.id === activeId ? ' active' : ''}`;
      li.dataset.sceneId = scene.id;
      li.innerHTML = `
        <span class="scene-name" title="${esc(scene.name)}">${esc(scene.name)}</span>
        <div class="scene-actions">
          <button class="btn-icon scene-switch-btn" data-id="${scene.id}" title="Switch to scene">${scene.id === activeId ? '●' : '○'}</button>
          <button class="btn-icon scene-del-btn" data-id="${scene.id}" title="Delete scene">✕</button>
        </div>
      `;
      li.querySelector('.scene-switch-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await sceneManager.switchScene(scene.id);
      });
      li.querySelector('.scene-del-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (scenes.length <= 1) { showToast('Cannot delete the last scene', 'error'); return; }
        try { await sceneManager.deleteScene(scene.id); renderSceneList(); } catch (err) { showToast(err.message, 'error'); }
      });
      li.addEventListener('click', () => sceneManager.switchScene(scene.id));
      ul.appendChild(li);
    }
  }

  // ── Source list rendering ─────────────────────────────────────────────────

  function renderSourceList(layers) {
    const ul = document.getElementById('source-list');
    if (!layers || layers.length === 0) {
      ul.innerHTML = '<li class="source-empty">No sources added yet.<br>Click ＋ to add a source.</li>';
      return;
    }
    ul.innerHTML = '';
    for (const layer of [...layers].reverse()) {
      const li = document.createElement('li');
      li.className = `source-item${editor.selectedLayer && editor.selectedLayer.id === layer.id ? ' selected' : ''}`;
      li.dataset.id = layer.id;
      const icon = typeIcon(layer.type);
      const isHardwareSource = layer.type === 'rtmp' || layer.type === 'srt';
      const isActive = layer._isActive;
      li.innerHTML = `
        <span class="source-icon-sm">${icon}</span>
        <span class="source-name" title="${esc(layer.name)}">${esc(layer.name)}</span>
        ${isHardwareSource ? `<span class="ingest-dot" title="${isActive ? 'Live' : 'Waiting'}">${isActive ? '🟢' : '⚪'}</span>` : ''}
        <button class="vis-toggle${layer.visible ? '' : ' hidden'}" data-id="${layer.id}" title="Toggle visibility">
          ${layer.visible ? '👁' : '🚫'}
        </button>
        <div class="source-actions">
          <button class="btn-icon" data-action="delete" data-id="${layer.id}" title="Remove">✕</button>
        </div>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]') || e.target.closest('.vis-toggle')) return;
        editor.selectLayer(layer);
      });
      li.querySelector('.vis-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        editor.toggleVisibility(layer.id);
      });
      li.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        removeLayer(layer);
      });
      ul.appendChild(li);
    }
  }

  // ── Layer list rendering ──────────────────────────────────────────────────

  function renderLayerList(layers) {
    const ul = document.getElementById('layer-list');
    if (!layers || layers.length === 0) {
      ul.innerHTML = '<li class="source-empty">No layers.</li>';
      return;
    }
    ul.innerHTML = '';
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const li = document.createElement('li');
      li.className = `layer-item${editor.selectedLayer && editor.selectedLayer.id === layer.id ? ' selected' : ''}`;
      li.dataset.id = layer.id;
      li.innerHTML = `
        <span class="source-icon-sm">${typeIcon(layer.type)}</span>
        <span class="source-name">${esc(layer.name)}</span>
      `;
      li.addEventListener('click', () => editor.selectLayer(layer));
      ul.appendChild(li);
    }
  }

  // ── Properties panel ──────────────────────────────────────────────────────

  function renderPropertiesPanel(layer) {
    const container = document.getElementById('properties-content');
    if (!layer) {
      container.innerHTML = '<p class="prop-empty">Select a layer to edit its properties.</p>';
      return;
    }

    let html = `
      <label class="prop-label">Name</label>
      <input class="prop-input" id="prop-name" type="text" value="${esc(layer.name)}" />
      <div class="prop-group">
        <span class="prop-group-title">Transform</span>
        <div class="prop-row">
          <div><label class="prop-label">X</label><input class="prop-input" id="prop-x" type="number" value="${Math.round(layer.x)}" step="1" /></div>
          <div><label class="prop-label">Y</label><input class="prop-input" id="prop-y" type="number" value="${Math.round(layer.y)}" step="1" /></div>
        </div>
        <div class="prop-row">
          <div><label class="prop-label">Width</label><input class="prop-input" id="prop-w" type="number" value="${Math.round(layer.width)}" min="20" step="1" /></div>
          <div><label class="prop-label">Height</label><input class="prop-input" id="prop-h" type="number" value="${Math.round(layer.height)}" min="20" step="1" /></div>
        </div>
        <label class="prop-label">Opacity: <span id="prop-opacity-val">${Math.round(layer.opacity * 100)}%</span></label>
        <input class="prop-input" id="prop-opacity" type="range" min="0" max="1" step="0.01" value="${layer.opacity}" />
      </div>
    `;

    if (layer.type === 'camera') {
      html += `
        <div class="prop-group">
          <span class="prop-group-title">Camera Options</span>
          <label class="prop-label"><input type="checkbox" id="prop-mirror" ${layer.mirror ? 'checked' : ''} /> Mirror horizontally</label>
        </div>
      `;
    }

    if (layer.type === 'rtmp' || layer.type === 'srt') {
      const input = layer._input || {};
      const isRtmpIngest = layer.type === 'rtmp' && input.type === 'rtmp';
      html += `
        <div class="prop-group">
          <span class="prop-group-title">${layer.type.toUpperCase()} Source</span>
          ${isRtmpIngest ? `
            <label class="prop-label">Stream Key</label>
            <input class="prop-input" type="text" readonly value="${esc(input.streamKey || '')}" />
            <p class="prop-label" style="color:${layer._isActive ? '#2ecc71' : '#888'}">${layer._isActive ? '● Live' : '○ Waiting for stream'}</p>
          ` : `
            <label class="prop-label">URL</label>
            <input class="prop-input" type="text" readonly value="${esc(input.url || '')}" />
          `}
        </div>
      `;
    }

    if (layer.type === 'browser_url') {
      html += `
        <div class="prop-group">
          <span class="prop-group-title">Browser Source</span>
          <label class="prop-label">URL</label>
          <input class="prop-input" id="prop-browser-url" type="url" value="${esc(layer.url || '')}" placeholder="https://…" />
          <p class="modal-hint-sm" style="margin-top:4px">The iframe updates when you change the URL. Position and size control where the overlay appears in the scene.</p>
        </div>
      `;
    }

    if (layer.type === 'text') {
      const s = layer.textStyle || {};
      html += `
        <div class="prop-group">
          <span class="prop-group-title">Text</span>
          <label class="prop-label">Content (double-click on canvas to edit inline)</label>
          <textarea class="prop-input" id="prop-text" rows="3" style="resize:vertical">${esc(layer.text || '')}</textarea>
          <div class="prop-row">
            <div>
              <label class="prop-label">Font</label>
              <select class="prop-input" id="prop-font-family">
                ${['Arial','Helvetica','Georgia','Times New Roman','Courier New','Verdana','Impact','Comic Sans MS'].map(
                  f => `<option value="${f}"${s.fontFamily === f ? ' selected' : ''}>${f}</option>`
                ).join('')}
              </select>
            </div>
            <div>
              <label class="prop-label">Size (px)</label>
              <input class="prop-input" id="prop-font-size" type="number" value="${s.fontSize || 36}" min="8" max="200" />
            </div>
          </div>
          <div class="prop-row">
            <div><label class="prop-label">Text Color</label><input class="prop-input" id="prop-text-color" type="color" value="${s.color || '#ffffff'}" /></div>
            <div>
              <label class="prop-label">Alignment</label>
              <select class="prop-input" id="prop-text-align">
                <option value="left"${s.align === 'left' ? ' selected' : ''}>Left</option>
                <option value="center"${s.align === 'center' ? ' selected' : ''}>Center</option>
                <option value="right"${s.align === 'right' ? ' selected' : ''}>Right</option>
              </select>
            </div>
          </div>
          <div class="prop-row">
            <div><label class="prop-label"><input type="checkbox" id="prop-bold" ${s.bold ? 'checked' : ''} /> Bold</label></div>
            <div><label class="prop-label"><input type="checkbox" id="prop-italic" ${s.italic ? 'checked' : ''} /> Italic</label></div>
          </div>
          <label class="prop-label">Background Color</label>
          <input class="prop-input" id="prop-bg-color" type="color" value="${s.bgColor || '#000000'}" />
          <label class="prop-label">Background Opacity: <span id="prop-bg-opacity-val">${Math.round((s.bgOpacity !== undefined ? s.bgOpacity : 0.5) * 100)}%</span></label>
          <input class="prop-input" id="prop-bg-opacity" type="range" min="0" max="1" step="0.01" value="${s.bgOpacity !== undefined ? s.bgOpacity : 0.5}" />
        </div>
      `;
    }

    html += `<button class="btn" id="prop-delete" style="margin-top:8px;border-color:#c0392b;color:#e74c3c;width:100%">✕ Remove Layer</button>`;
    container.innerHTML = html;

    bindPropInput('prop-name', v => { layer.name = v; fireLayersChanged(); });
    bindPropNumber('prop-x', v => { layer.x = v; });
    bindPropNumber('prop-y', v => { layer.y = v; });
    bindPropNumber('prop-w', v => { layer.width = Math.max(20, v); });
    bindPropNumber('prop-h', v => { layer.height = Math.max(20, v); });

    const opacityInput = document.getElementById('prop-opacity');
    if (opacityInput) {
      opacityInput.addEventListener('input', () => {
        layer.opacity = parseFloat(opacityInput.value);
        document.getElementById('prop-opacity-val').textContent = `${Math.round(layer.opacity * 100)}%`;
      });
    }

    if (layer.type === 'camera') {
      const mirrorEl = document.getElementById('prop-mirror');
      if (mirrorEl) mirrorEl.addEventListener('change', () => { layer.mirror = mirrorEl.checked; });
    }

    if (layer.type === 'text') {
      bindPropInput('prop-text', v => { layer.text = v; });
      bindPropNumber('prop-font-size', v => { layer.textStyle.fontSize = v; });
      bindPropInput('prop-font-family', v => { layer.textStyle.fontFamily = v; });
      bindPropInput('prop-text-color', v => { layer.textStyle.color = v; });
      bindPropInput('prop-text-align', v => { layer.textStyle.align = v; });
      const boldEl = document.getElementById('prop-bold');
      if (boldEl) boldEl.addEventListener('change', () => { layer.textStyle.bold = boldEl.checked; });
      const italicEl = document.getElementById('prop-italic');
      if (italicEl) italicEl.addEventListener('change', () => { layer.textStyle.italic = italicEl.checked; });
      bindPropInput('prop-bg-color', v => { layer.textStyle.bgColor = v; });
      const bgOpEl = document.getElementById('prop-bg-opacity');
      if (bgOpEl) {
        bgOpEl.addEventListener('input', () => {
          layer.textStyle.bgOpacity = parseFloat(bgOpEl.value);
          document.getElementById('prop-bg-opacity-val').textContent = `${Math.round(layer.textStyle.bgOpacity * 100)}%`;
        });
      }
    }

    if (layer.type === 'browser_url') {
      const urlEl = document.getElementById('prop-browser-url');
      if (urlEl) {
        urlEl.addEventListener('change', () => {
          const newUrl = urlEl.value.trim();
          layer.url = newUrl;
          // Update iframe src if it exists — validate scheme first
          const iframe = sources._browserUrlIframes && sources._browserUrlIframes.get(layer.id);
          if (iframe) {
            try {
              const parsed = new URL(newUrl);
              iframe.src = (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : 'about:blank';
            } catch (_) {
              iframe.src = 'about:blank';
            }
          }
        });
      }
    }

    document.getElementById('prop-delete').addEventListener('click', () => removeLayer(layer));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function removeLayer(layer) {
    if (layer.type === 'rtmp' || layer.type === 'srt' ||
        layer.type === 'camera' || layer.type === 'screen' || layer.type === 'microphone' ||
        layer.type === 'browser_url') {
      sources.removeSource(layer.id);
    } else {
      overlays.removeOverlay(layer.id);
    }
  }

  function bindPropInput(id, setter) {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => setter(el.value));
  }

  function bindPropNumber(id, setter) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => { const v = parseFloat(el.value); if (!isNaN(v)) setter(v); });
  }

  function fireLayersChanged() {
    document.dispatchEvent(new CustomEvent('layers-changed', { detail: editor.layers }));
  }

  function typeIcon(type) {
    return { camera: '📷', screen: '🖥', microphone: '🎙', rtmp: '📡', srt: '🔗', text: '📝', image: '🖼', browser_url: '🌐' }[type] || '▪';
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  window.showToast = showToast;
  function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast${type ? ' ' + type : ''}`;
    toast.style.display = 'block';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.style.display = 'none'; }, 3500);
  }

  showToast('👋 Belabox 2.0 — ready', '');
}());
