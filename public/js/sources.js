/**
 * SourcesManager – manages both hardware RTMP/SRT sources and browser sources.
 *
 * Hardware sources: encoders push RTMP to server port 1935; server composites
 * them via FFmpeg. Browser sources: captured with getUserMedia/getDisplayMedia,
 * streamed to server via a dedicated WebSocket where a per-source FFmpeg
 * re-encodes them to local RTMP so the compositor can pick them up.
 * Audio is included automatically for browser sources.
 */

'use strict';

/** Generate a unique source ID */
function generateInputId() {
  return `input-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** WebM mime type preferred by MediaRecorder for streaming */
function getStreamMimeType() {
  const candidates = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return candidates.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

/** Interval in ms between MediaRecorder data chunks sent to the server */
const BROWSER_SOURCE_CHUNK_MS = 250;

class SourcesManager {
  constructor(sceneEditor) {
    this._editor = sceneEditor;
    /** @type {Map<string, string>} layerId → inputId */
    this._layerInputMap = new Map();
    /** @type {Set<string>} currently live hardware ingest keys */
    this._activeIngestKeys = new Set();
    /**
     * Active browser source sessions.
     * @type {Map<string, {ws:WebSocket, recorder:MediaRecorder, stream:MediaStream, layer:object}>}
     */
    this._browserSources = new Map();
  }

  // ── Hardware RTMP ingest source ───────────────────────────────────────────

  addRtmpSource(name, streamKey) {
    if (!streamKey) throw new Error('Stream key is required for an RTMP ingest source');
    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'rtmp', streamKey };
    const layer = this._createHardwareLayer('rtmp', name, inputId, input);
    this._syncInputToServer(input);
    return layer;
  }

  // ── External RTMP pull source ─────────────────────────────────────────────

  addRtmpPullSource(name, url) {
    if (!url) throw new Error('URL is required for an RTMP pull source');
    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'rtmp_pull', url };
    const layer = this._createHardwareLayer('rtmp', name, inputId, input);
    this._syncInputToServer(input);
    return layer;
  }

  // ── SRT source ────────────────────────────────────────────────────────────

  addSrtSource(name, url) {
    if (!url) throw new Error('URL is required for an SRT source');
    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'srt', url };
    const layer = this._createHardwareLayer('srt', name, inputId, input);
    this._syncInputToServer(input);
    return layer;
  }

  _createHardwareLayer(type, name, inputId, input) {
    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;
    const layer = createLayer(type, { name, sourceId: inputId, x: 0, y: 0, width: ow, height: oh, _input: input });
    this._layerInputMap.set(layer.id, inputId);
    this._editor.addLayer(layer);
    return layer;
  }

  // ── Browser camera source ─────────────────────────────────────────────────

  /**
   * Capture from the user's camera/microphone.
   * The video renders live in the canvas preview AND is streamed to the
   * server where it feeds the FFmpeg compositor.
   */
  async addCamera(name) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      throw new Error(`Camera access denied: ${err.message}`);
    }
    return this._addBrowserSource(name || 'Camera', 'camera', stream);
  }

  // ── Browser screen capture source ─────────────────────────────────────────

  /**
   * Capture the user's screen or an application window.
   */
  async addScreen(name) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      throw new Error(`Screen capture cancelled or denied: ${err.message}`);
    }

    const layer = await this._addBrowserSource(name || 'Screen', 'screen', stream);

    // Auto-remove if user stops sharing via browser UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      this.removeSource(layer.id);
      document.dispatchEvent(new CustomEvent('source-ended', { detail: layer }));
    });

    return layer;
  }

  // ── Browser microphone-only source ────────────────────────────────────────

  /**
   * Capture microphone audio only.
   * Sends audio to the server as a browser source; canvas shows a waveform placeholder.
   */
  async addMicrophone(name) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      throw new Error(`Microphone access denied: ${err.message}`);
    }
    return this._addBrowserSource(name || 'Microphone', 'microphone', stream);
  }

  // ── Internal browser source setup ────────────────────────────────────────

  /**
   * Create a canvas layer, open a WebSocket to the server, start MediaRecorder
   * and pipe WebM chunks to the server-side FFmpeg re-streamer.
   *
   * @param {string} name
   * @param {'camera'|'screen'|'microphone'} type
   * @param {MediaStream} stream
   * @returns {object} the scene layer
   */
  async _addBrowserSource(name, type, stream) {
    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    // Create a raw sourceId (used for the server-side RTMP key)
    const rawId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inputId = `input-${rawId}`;
    const input = { id: inputId, name, type: 'browser', sourceId: rawId };

    // Build a video element for canvas preview (microphone has no video)
    let videoEl = null;
    if (type !== 'microphone') {
      videoEl = document.createElement('video');
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      await videoEl.play().catch(() => {});
    }

    const layer = createLayer(type, {
      name,
      sourceId: inputId,
      videoEl,
      mirror: type === 'camera',
      x: 0, y: 0, width: ow, height: oh,
      _input: input,
      _isBrowserSource: true,
    });

    this._layerInputMap.set(layer.id, inputId);
    this._editor.addLayer(layer);

    // Open WebSocket to server for this source
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${location.host}/ws/source?sourceId=${rawId}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      const mimeType = getStreamMimeType();
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2500000,
        audioBitsPerSecond: 128000,
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      recorder.onerror = (e) => {
        console.error('[BrowserSource] Recorder error:', e.error);
      };

      recorder.start(BROWSER_SOURCE_CHUNK_MS);
      this._browserSources.set(rawId, { ws, recorder, stream, layer });
      console.log(`[BrowserSource] Started: ${name} (${mimeType})`);
    };

    ws.onerror = (err) => console.error('[BrowserSource] WS error:', err);

    ws.onclose = () => {
      console.log(`[BrowserSource] WS closed: ${name}`);
    };

    // Register with server
    this._syncInputToServer(input);

    return layer;
  }

  // ── Remove source ─────────────────────────────────────────────────────────

  removeSource(layerId) {
    const inputId = this._layerInputMap.get(layerId);
    this._layerInputMap.delete(layerId);

    const layer = this._editor.layers.find(l => l.id === layerId);

    // Stop browser source streams
    if (layer && layer._isBrowserSource) {
      const rawId = layer._input && layer._input.sourceId;
      if (rawId) {
        const session = this._browserSources.get(rawId);
        if (session) {
          if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
          session.stream.getTracks().forEach(t => t.stop());
          if (session.ws.readyState === WebSocket.OPEN) session.ws.close();
          this._browserSources.delete(rawId);
        }
      }
    }

    this._editor.removeLayer(layerId);

    if (inputId) {
      this._removeInputFromServer(inputId);
    }
  }

  // ── Active ingest status ──────────────────────────────────────────────────

  onIngestConnected(streamKey) { this._activeIngestKeys.add(streamKey); }
  onIngestDisconnected(streamKey) { this._activeIngestKeys.delete(streamKey); }
  isKeyActive(streamKey) { return this._activeIngestKeys.has(streamKey); }

  // ── Server sync ───────────────────────────────────────────────────────────

  async _syncInputToServer(input) {
    try {
      await fetch('/api/inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
    } catch (err) {
      console.error('[Sources] Failed to sync input to server:', err.message);
    }
  }

  async _removeInputFromServer(inputId) {
    try {
      await fetch(`/api/inputs/${inputId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('[Sources] Failed to remove input from server:', err.message);
    }
  }
}
