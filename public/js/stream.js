/**
 * StreamController – manages WebSocket connection, MediaRecorder, and streaming
 */

'use strict';

/** How often (in ms) MediaRecorder emits a data chunk to the server */
const RECORDER_CHUNK_INTERVAL_MS = 250;

class StreamController {
  constructor(sceneEditor, sourcesManager) {
    this._editor = sceneEditor;
    this._sources = sourcesManager;

    this._ws = null;
    this._recorder = null;
    this._isLive = false;

    this._timerInterval = null;
    this._startTime = null;

    this._wsUrl = `ws://${location.host}`;
    this._connect();
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

  _connect() {
    try {
      this._ws = new WebSocket(this._wsUrl);
      this._ws.binaryType = 'arraybuffer';

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
        // Reconnect after 3 s
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

      case 'pong':
        // Latency measurement placeholder
        break;

      default:
        break;
    }
  }

  // ── Start streaming ───────────────────────────────────────────────────────

  async startStream() {
    if (this._isLive) return;

    const url = document.getElementById('stream-url').value.trim();
    const key = document.getElementById('stream-key').value.trim();
    const protocol = document.getElementById('stream-protocol').value;
    const vbitrate = parseInt(document.getElementById('stream-vbitrate').value, 10) || 3000;
    const abitrate = parseInt(document.getElementById('stream-abitrate').value, 10) || 128;
    const fpsEl = document.getElementById('output-fps');
    const resEl = document.getElementById('output-resolution');
    const fps = parseInt(fpsEl ? fpsEl.value : '30', 10);
    const resolution = resEl ? resEl.value : '1280x720';

    if (!url) {
      showToast('Please enter a stream URL', 'error');
      return;
    }

    const outputUrl = key ? `${url}/${key}` : url;

    // Build combined stream: video from canvas + audio from sources
    const videoStream = this._editor.outputCanvas.captureStream(fps);

    const audioStream = this._sources.getAudioStream();
    const tracks = [...videoStream.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    const combined = new MediaStream(tracks);

    // Choose best supported mime type
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      showToast('Browser does not support MediaRecorder — try Chrome/Firefox', 'error');
      return;
    }

    // Send start command to server
    this._sendControl({
      type: 'start_stream',
      config: { outputUrl, outputType: protocol, videoBitrate: vbitrate, audioBitrate: abitrate, framerate: fps, resolution },
    });

    // Start recording
    try {
      this._recorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: vbitrate * 1000,
        audioBitsPerSecond: abitrate * 1000,
      });
    } catch (err) {
      showToast(`MediaRecorder error: ${err.message}`, 'error');
      return;
    }

    this._recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(e.data);
      }
    };

    this._recorder.onerror = (e) => {
      showToast(`Recording error: ${e.error.message}`, 'error');
      this.stopStream();
    };

    this._recorder.start(RECORDER_CHUNK_INTERVAL_MS);
    console.log(`[Recorder] Started with mime: ${mimeType}`);
  }

  // ── Stop streaming ────────────────────────────────────────────────────────

  stopStream() {
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
    this._recorder = null;
    this._sendControl({ type: 'stop_stream' });
  }

  _onStreamEnded(exitCode) {
    if (this._recorder && this._recorder.state !== 'inactive') {
      this._recorder.stop();
    }
    this._recorder = null;
    this._isLive = false;
    this._setLiveUI(false);
    if (exitCode !== null && exitCode !== 0 && exitCode !== undefined) {
      showToast(`Stream ended (FFmpeg exit ${exitCode})`, 'error');
    } else if (exitCode === null) {
      // Normal stop, no toast needed
    } else {
      showToast('Stream ended', '');
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
    this._startTime = Date.now();
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  _sendControl(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  get isLive() { return this._isLive; }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || null;
}

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
