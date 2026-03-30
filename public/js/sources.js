/**
 * SourcesManager – handles camera and screen capture sources
 */

'use strict';

class SourcesManager {
  constructor(sceneEditor) {
    this._editor = sceneEditor;
    /** @type {Map<string, MediaStream>} layerId -> MediaStream */
    this._streams = new Map();
    /** @type {AudioContext|null} */
    this._audioCtx = null;
    /** @type {MediaStreamAudioDestinationNode|null} */
    this._audioDest = null;
    /** @type {Map<string, AudioNode>} */
    this._audioNodes = new Map();
  }

  // ── Audio context (lazy) ──────────────────────────────────────────────────

  _ensureAudioCtx() {
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this._audioDest = this._audioCtx.createMediaStreamDestination();
    }
    return { ctx: this._audioCtx, dest: this._audioDest };
  }

  /** Returns a combined audio MediaStream from all sources */
  getAudioStream() {
    if (!this._audioDest) return null;
    return this._audioDest.stream;
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  async addCamera() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      throw new Error(`Camera access denied: ${err.message}`);
    }

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true; // avoid echo
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    await videoEl.play().catch(() => {});

    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const layer = createLayer('camera', {
      name: 'Camera',
      videoEl,
      mirror: true,
      x: 0,
      y: 0,
      width: ow,
      height: oh,
    });

    this._streams.set(layer.id, stream);
    this._mixAudio(layer.id, stream);
    this._editor.addLayer(layer);

    return layer;
  }

  // ── Screen capture ────────────────────────────────────────────────────────

  async addScreen() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      throw new Error(`Screen capture cancelled or denied: ${err.message}`);
    }

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    await videoEl.play().catch(() => {});

    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const layer = createLayer('screen', {
      name: 'Screen',
      videoEl,
      mirror: false,
      x: 0,
      y: 0,
      width: ow,
      height: oh,
    });

    this._streams.set(layer.id, stream);
    this._mixAudio(layer.id, stream);
    this._editor.addLayer(layer);

    // Auto-remove if user stops sharing via browser UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      this.removeSource(layer.id);
      document.dispatchEvent(new CustomEvent('source-ended', { detail: layer }));
    });

    return layer;
  }

  // ── Audio mixing ──────────────────────────────────────────────────────────

  _mixAudio(layerId, stream) {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const { ctx, dest } = this._ensureAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(dest);
    this._audioNodes.set(layerId, source);
  }

  _unmixAudio(layerId) {
    const node = this._audioNodes.get(layerId);
    if (node) {
      node.disconnect();
      this._audioNodes.delete(layerId);
    }
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  removeSource(layerId) {
    const stream = this._streams.get(layerId);
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      this._streams.delete(layerId);
    }
    this._unmixAudio(layerId);
    this._editor.removeLayer(layerId);
  }

  /** Stop all active streams (called on app shutdown / stream stop) */
  stopAll() {
    for (const [id] of this._streams) {
      this.removeSource(id);
    }
  }
}
