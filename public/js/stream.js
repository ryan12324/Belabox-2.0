/**
 * StreamController – manages WebSocket connection and server-side streaming.
 *
 * All video capture and compositing runs on the server.
 * The browser sends scene configuration via REST and receives real-time
 * status/stats via WebSocket.
 */

'use strict';

class StreamController {
  constructor(sceneEditor) {
    this._editor = sceneEditor;

    this._ws = null;
    this._isLive = false;

    this._timerInterval = null;
    this._startTime = null;

    this._connect();
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

  _connect() {
    try {
      // Use explicit /ws path (the server also has /ws/source for binary source streams)
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this._ws = new WebSocket(`${wsProto}//${location.host}/ws`);

      this._ws.onopen = () => {
        console.log('[WS] Connected to server');
        this._setConnected(true);
        document.getElementById('btn-go-live').disabled = false;
      };

      this._ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          try {
            this._handleServerMessage(JSON.parse(e.data));
          } catch (_) {}
        }
      };

      this._ws.onclose = () => {
        console.log('[WS] Disconnected');
        this._setConnected(false);
        document.getElementById('btn-go-live').disabled = true;
        if (this._isLive) this._onStreamEnded(null);
        setTimeout(() => this._connect(), 3000);
      };

      this._ws.onerror = (err) => {
        console.error('[WS] Error:', err);
      };
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      setTimeout(() => this._connect(), 3000);
    }
  }

  _setConnected(connected) {
    const el = document.getElementById('conn-indicator');
    if (connected) {
      el.textContent = '●';
      el.className = 'conn-indicator connected';
      el.title = 'Connected to server';
    } else {
      el.textContent = '○';
      el.className = 'conn-indicator disconnected';
      el.title = 'Disconnected from server';
    }
  }

  // ── Server messages ───────────────────────────────────────────────────────

  _handleServerMessage(msg) {
    switch (msg.type) {
      case 'connected':
        // Restore live state if server was already streaming
        if (msg.streamActive) {
          this._isLive = true;
          if (msg.streamStartTime) this._startTime = msg.streamStartTime;
          this._setLiveUI(true);
        }
        // Let app.js know about full server state (scenes, inputs, ingest)
        document.dispatchEvent(new CustomEvent('server-state', { detail: msg }));
        break;

      case 'stream_started':
        this._isLive = true;
        this._setLiveUI(true);
        showToast('🔴 Stream started', 'success');
        break;

      case 'stream_stopped':
      case 'stream_ended':
        this._onStreamEnded(msg.exitCode);
        break;

      case 'stream_error':
        showToast(`Stream error: ${msg.message}`, 'error');
        this._onStreamEnded(null);
        break;

      case 'stream_stats':
        this._updateStats(msg.data);
        break;

      case 'stream_log':
        if (msg.level === 'warn') console.warn('[FFmpeg]', msg.data);
        break;

      case 'ingest_connected':
      case 'ingest_disconnected':
        // Forward to app.js for layer status updates
        document.dispatchEvent(new CustomEvent('ingest-event', { detail: msg }));
        break;

      case 'scene_activated':
        // Scene was switched on the server; notify app.js to refresh UI
        document.dispatchEvent(new CustomEvent('scene-activated', { detail: msg }));
        break;

      case 'scenes_updated':
        document.dispatchEvent(new CustomEvent('scenes-updated', { detail: msg }));
        break;

      case 'inputs_updated':
        document.dispatchEvent(new CustomEvent('inputs-updated', { detail: msg }));
        break;

      case 'browser_source_connected':
      case 'browser_source_disconnected':
        document.dispatchEvent(new CustomEvent('browser-source-event', { detail: msg }));
        break;

      case 'scene_updated':
        // Scene config was updated (possibly by another browser tab)
        document.dispatchEvent(new CustomEvent('remote-scene-update'));
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  // ── Start streaming ───────────────────────────────────────────────────────

  async startStream() {
    if (this._isLive) return;

    // Push the current scene config to the server before starting
    await this._syncSceneToServer();

    try {
      const res = await fetch('/api/stream/start', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        showToast(`Cannot start: ${body.error}`, 'error');
      }
    } catch (err) {
      showToast(`Start failed: ${err.message}`, 'error');
    }
  }

  // ── Stop streaming ────────────────────────────────────────────────────────

  async stopStream() {
    try {
      await fetch('/api/stream/stop', { method: 'POST' });
    } catch (err) {
      showToast(`Stop failed: ${err.message}`, 'error');
    }
  }

  // ── Scene sync ────────────────────────────────────────────────────────────

  /**
   * Push the current browser-side scene layout to the server.
   * Reads resolution/framerate from the UI, gets outputs[] from OutputManager,
   * combines with the layer list from the scene editor, and PUTs the active scene.
   */
  async _syncSceneToServer() {
    const resolution = document.getElementById('output-resolution').value || '1280x720';
    const framerate = parseInt(document.getElementById('output-fps').value, 10) || 30;

    // Build layers list for the server (strip browser-only properties)
    const layers = this._editor.layers.map(l => ({
      id: l.id,
      type: l.type,
      sourceId: l.sourceId || null,
      name: l.name,
      x: Math.round(l.x),
      y: Math.round(l.y),
      width: Math.round(l.width),
      height: Math.round(l.height),
      visible: l.visible,
      opacity: l.opacity,
      text: l.text,
      textStyle: l.textStyle,
      imgUrl: l.imgUrl,
    }));

    // Get output destinations from OutputManager (injected via window)
    const outputs = window._outputManager ? window._outputManager.outputs : [];

    // Get active scene ID from SceneManager (injected via window)
    const sceneManager = window._sceneManager;
    const activeSceneId = sceneManager ? sceneManager.activeSceneId : null;

    const sceneData = { resolution, framerate, layers, outputs };

    try {
      if (activeSceneId) {
        await fetch(`/api/scenes/${activeSceneId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sceneData),
        });
      } else {
        await fetch('/api/scene', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sceneData),
        });
      }
    } catch (err) {
      console.error('[Stream] Failed to sync scene:', err.message);
    }
  }

  _onStreamEnded(exitCode) {
    this._isLive = false;
    this._setLiveUI(false);
    if (exitCode !== null && exitCode !== 0 && exitCode !== undefined) {
      showToast(`Stream ended (FFmpeg exit ${exitCode})`, 'error');
    }
  }

  // ── UI updates ────────────────────────────────────────────────────────────

  _setLiveUI(live) {
    const btn = document.getElementById('btn-go-live');
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const timerEl = document.getElementById('status-timer');

    if (live) {
      btn.textContent = '■ Stop';
      btn.classList.add('live');
      dot.classList.add('live');
      statusText.textContent = 'LIVE';
      statusText.classList.add('live');
      timerEl.style.display = '';
      this._startTimer(timerEl);
      document.getElementById('stream-stats').style.display = '';
    } else {
      btn.textContent = '▶ Go Live';
      btn.classList.remove('live');
      dot.classList.remove('live');
      statusText.textContent = 'Offline';
      statusText.classList.remove('live');
      timerEl.style.display = 'none';
      this._stopTimer();
      document.getElementById('stream-stats').style.display = 'none';
    }
  }

  _startTimer(el) {
    this._startTime = this._startTime || Date.now();
    this._timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
      const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
      const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toString().padStart(2, '0');
      el.textContent = `${h}:${m}:${s}`;
    }, 1000);
  }

  _stopTimer() {
    clearInterval(this._timerInterval);
    this._timerInterval = null;
    this._startTime = null;
    document.getElementById('status-timer').textContent = '00:00:00';
  }

  _updateStats(data) {
    if (data.frame !== undefined) document.getElementById('stat-frame').textContent = data.frame;
    if (data.fps !== undefined) document.getElementById('stat-fps').textContent = data.fps;
    if (data.bitrate !== undefined) document.getElementById('stat-bitrate').textContent = data.bitrate;
  }

  get isLive() { return this._isLive; }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast${type ? ' ' + type : ''}`;
  toast.style.display = 'block';

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.style.display = 'none';
  }, 3500);
}

