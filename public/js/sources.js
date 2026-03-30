/**
 * SourcesManager – manages server-side RTMP/SRT input sources.
 *
 * Hardware encoders (cameras, capture cards, etc.) push RTMP or SRT streams
 * directly to the Belabox server. This manager tracks those logical sources
 * and creates scene layers for each one. All video processing runs on the
 * server via FFmpeg; the browser only configures the layout.
 */

'use strict';

/** Generate a unique ID for an input source */
function generateInputId() {
  return `input-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

class SourcesManager {
  constructor(sceneEditor) {
    this._editor = sceneEditor;
    /** @type {Map<string, string>} layerId → inputId */
    this._layerInputMap = new Map();
    /** @type {Set<string>} currently live ingest stream keys */
    this._activeIngestKeys = new Set();
  }

  // ── Add RTMP ingest source ────────────────────────────────────────────────

  /**
   * Add a source that receives a push from a hardware encoder via the
   * built-in RTMP ingest server.
   *
   * The hardware encoder should be pointed at:
   *   rtmp://<server-ip>:1935/live/<streamKey>
   *
   * @param {string} name - Human-readable name (e.g. "Camera 1")
   * @param {string} streamKey - Unique key configured on the encoder
   * @returns {object} The created layer
   */
  addRtmpSource(name, streamKey) {
    if (!streamKey) throw new Error('Stream key is required for an RTMP ingest source');

    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'rtmp', streamKey };

    const layer = createLayer('rtmp', {
      name,
      sourceId: inputId,
      x: 0, y: 0, width: ow, height: oh,
      _input: input,
    });

    this._layerInputMap.set(layer.id, inputId);
    this._editor.addLayer(layer);
    this._syncInputToServer(input);

    return layer;
  }

  // ── Add external RTMP pull source ─────────────────────────────────────────

  /**
   * Add a source by pulling from an external RTMP URL.
   * FFmpeg will connect to the remote URL as a client.
   *
   * @param {string} name
   * @param {string} url - e.g. rtmp://192.168.1.100/live/stream
   * @returns {object} The created layer
   */
  addRtmpPullSource(name, url) {
    if (!url) throw new Error('URL is required for an RTMP pull source');

    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'rtmp_pull', url };

    const layer = createLayer('rtmp', {
      name,
      sourceId: inputId,
      x: 0, y: 0, width: ow, height: oh,
      _input: input,
    });

    this._layerInputMap.set(layer.id, inputId);
    this._editor.addLayer(layer);
    this._syncInputToServer(input);

    return layer;
  }

  // ── Add SRT source ────────────────────────────────────────────────────────

  /**
   * Add a source from a hardware encoder using SRT.
   * FFmpeg will connect to the SRT endpoint.
   *
   * @param {string} name
   * @param {string} url - e.g. srt://192.168.1.100:4000
   * @returns {object} The created layer
   */
  addSrtSource(name, url) {
    if (!url) throw new Error('URL is required for an SRT source');

    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const inputId = generateInputId();
    const input = { id: inputId, name, type: 'srt', url };

    const layer = createLayer('srt', {
      name,
      sourceId: inputId,
      x: 0, y: 0, width: ow, height: oh,
      _input: input,
    });

    this._layerInputMap.set(layer.id, inputId);
    this._editor.addLayer(layer);
    this._syncInputToServer(input);

    return layer;
  }

  // ── Remove source ─────────────────────────────────────────────────────────

  removeSource(layerId) {
    const inputId = this._layerInputMap.get(layerId);
    this._layerInputMap.delete(layerId);
    this._editor.removeLayer(layerId);

    if (inputId) {
      this._removeInputFromServer(inputId);
    }
  }

  // ── Active ingest status ──────────────────────────────────────────────────

  /** Called by app.js when the server reports an ingest connection event */
  onIngestConnected(streamKey) {
    this._activeIngestKeys.add(streamKey);
  }

  onIngestDisconnected(streamKey) {
    this._activeIngestKeys.delete(streamKey);
  }

  isKeyActive(streamKey) {
    return this._activeIngestKeys.has(streamKey);
  }

  // ── Server sync ───────────────────────────────────────────────────────────

  /**
   * Register a new input with the server's scene config via REST.
   * The server adds it to its inputs list so it knows to include it in the
   * FFmpeg filter_complex when Go Live is pressed.
   */
  async _syncInputToServer(input) {
    try {
      const res = await fetch('/api/scene');
      const config = await res.json();
      const inputs = [...(config.inputs || []), input];
      await fetch('/api/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, inputs }),
      });
    } catch (err) {
      console.error('[Sources] Failed to sync input to server:', err.message);
    }
  }

  async _removeInputFromServer(inputId) {
    try {
      const res = await fetch('/api/scene');
      const config = await res.json();
      const inputs = (config.inputs || []).filter(i => i.id !== inputId);
      await fetch('/api/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, inputs }),
      });
    } catch (err) {
      console.error('[Sources] Failed to remove input from server:', err.message);
    }
  }
}

