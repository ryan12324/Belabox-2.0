/**
 * SceneEditor – canvas-based compositor for Belabox 2.0
 *
 * Manages all scene layers (video sources, text, images), renders them
 * to an output canvas (used for streaming), and mirrors the result onto
 * the visible preview canvas with drag / resize UI on top.
 */

'use strict';

/** Minimum pixel dimension for a layer (width or height) */
const MIN_LAYER_SIZE = 20;
/** Hit area radius around a resize handle (pixels in preview coords) */
const HANDLE_HIT_AREA_SIZE = 10;

class SceneEditor {
  constructor() {
    // Hidden canvas used for the actual stream output
    this._output = document.createElement('canvas');
    this._output.width = 1280;
    this._output.height = 720;
    this._outCtx = this._output.getContext('2d');

    // Visible preview canvas
    this._preview = document.getElementById('preview-canvas');
    this._preCtx = this._preview.getContext('2d');

    /** @type {SceneLayer[]} */
    this._layers = [];
    this._selected = null;

    // Drag / resize state
    this._drag = null;

    this._bindEvents();
    this._resizePreview();
    this._loop();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Returns the hidden output canvas (used by StreamController.captureStream) */
  get outputCanvas() { return this._output; }

  /** All layers in render order (index 0 = bottom) */
  get layers() { return this._layers; }

  /** Currently selected layer, or null */
  get selectedLayer() { return this._selected; }

  /** Set output resolution, e.g. '1280x720' */
  setResolution(res) {
    const [w, h] = res.split('x').map(Number);
    this._output.width = w;
    this._output.height = h;
    this._resizePreview();
  }

  /** Add a layer to the scene */
  addLayer(layer) {
    this._layers.push(layer);
    this.selectLayer(layer);
    this._emitLayersChanged();
    return layer;
  }

  /** Remove a layer by id */
  removeLayer(id) {
    const idx = this._layers.findIndex(l => l.id === id);
    if (idx === -1) return;
    this._layers.splice(idx, 1);
    if (this._selected && this._selected.id === id) {
      this._selected = null;
      this._emitSelectionChanged();
    }
    this._emitLayersChanged();
  }

  /** Select a layer (pass null to deselect) */
  selectLayer(layer) {
    this._selected = layer;
    this._emitSelectionChanged();
  }

  /** Move layer one step toward the viewer */
  layerMoveUp(id) {
    const idx = this._layers.findIndex(l => l.id === id);
    if (idx < this._layers.length - 1) {
      [this._layers[idx], this._layers[idx + 1]] = [this._layers[idx + 1], this._layers[idx]];
      this._emitLayersChanged();
    }
  }

  /** Move layer one step away from the viewer */
  layerMoveDown(id) {
    const idx = this._layers.findIndex(l => l.id === id);
    if (idx > 0) {
      [this._layers[idx], this._layers[idx - 1]] = [this._layers[idx - 1], this._layers[idx]];
      this._emitLayersChanged();
    }
  }

  /** Toggle layer visibility */
  toggleVisibility(id) {
    const layer = this._layers.find(l => l.id === id);
    if (layer) {
      layer.visible = !layer.visible;
      this._emitLayersChanged();
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _loop() {
    this._renderOutput();
    this._renderPreview();
    requestAnimationFrame(() => this._loop());
  }

  _renderOutput() {
    const ctx = this._outCtx;
    const W = this._output.width;
    const H = this._output.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (const layer of this._layers) {
      if (!layer.visible) continue;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      this._drawLayer(ctx, layer);
      ctx.restore();
    }
  }

  _renderPreview() {
    const ctx = this._preCtx;
    const W = this._preview.width;
    const H = this._preview.height;

    // Copy output canvas scaled to preview
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this._output, 0, 0, W, H);

    // Draw selection handles on top
    if (this._selected) {
      const r = this._toPreview(this._selected);
      this._drawHandles(ctx, r);
    }
  }

  _drawLayer(ctx, layer) {
    const { x, y, width, height } = layer;

    switch (layer.type) {
      case 'camera':
      case 'screen':
        // Browser source: render the real video element if available
        if (layer.videoEl && layer.videoEl.readyState >= 2) {
          if (layer.mirror) {
            ctx.save();
            ctx.scale(-1, 1);
            ctx.drawImage(layer.videoEl, -(x + width), y, width, height);
            ctx.restore();
          } else {
            ctx.drawImage(layer.videoEl, x, y, width, height);
          }
          // Small "BROWSER" badge so user knows it's a local capture
          this._drawBrowserBadge(ctx, x, y, width);
        } else {
          this._drawBrowserSourcePlaceholder(ctx, layer);
        }
        break;

      case 'microphone':
        this._drawMicrophonePlaceholder(ctx, layer);
        break;

      case 'rtmp':
      case 'srt':
        this._drawVideoSourcePlaceholder(ctx, layer);
        break;

      case 'text':
        this._drawTextLayer(ctx, layer);
        break;

      case 'image':
        if (layer.imgEl && layer.imgEl.complete && layer.imgEl.naturalWidth > 0) {
          ctx.drawImage(layer.imgEl, x, y, width, height);
        } else {
          ctx.fillStyle = '#222';
          ctx.fillRect(x, y, width, height);
          ctx.fillStyle = '#555';
          ctx.font = '13px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🖼 Loading…', x + width / 2, y + height / 2);
        }
        break;

      default:
        break;
    }
  }

  /** Small overlay badge to indicate a live browser capture in the preview */
  _drawBrowserBadge(ctx, x, y, width) {
    const label = '● BROWSER';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + 4, y + 4, tw + 8, 16);
    ctx.fillStyle = '#2ecc71';
    ctx.fillText(label, x + 8, y + 6);
  }

  /** Placeholder shown while camera/screen is initialising */
  _drawBrowserSourcePlaceholder(ctx, layer) {
    const { x, y, width, height } = layer;
    const icon = layer.type === 'camera' ? '📷' : '🖥';
    ctx.fillStyle = '#111';
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = '#555';
    ctx.font = `${Math.min(28, height / 5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${icon} Starting…`, x + width / 2, y + height / 2);
  }

  /** Placeholder for an audio-only microphone source */
  _drawMicrophonePlaceholder(ctx, layer) {
    const { x, y, width, height } = layer;
    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.min(28, height / 4)}px sans-serif`;
    ctx.fillStyle = '#888';
    ctx.fillText('🎙', x + width / 2, y + height / 2 - 10);
    ctx.font = `bold ${Math.min(12, height / 8)}px sans-serif`;
    ctx.fillStyle = '#666';
    ctx.fillText(layer.name || 'Microphone', x + width / 2, y + height / 2 + 16);
  }

  /**
   * Draw a placeholder for a server-side hardware video source (RTMP/SRT).
   * Shows live/waiting status and stream key hint.
   */
  _drawVideoSourcePlaceholder(ctx, layer) {
    const { x, y, width, height } = layer;
    const isActive = layer._isActive; // set by app.js based on ingest events
    const isRtmp = layer.type === 'rtmp';

    const bg = isRtmp ? '#0a1a0a' : '#0a0a1a';
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = isActive ? '#2ecc71' : '#444';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);

    const dotR = Math.min(8, width / 20);
    const dotX = x + width - dotR - 8;
    const dotY = y + dotR + 8;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? '#2ecc71' : '#555';
    ctx.fill();

    // Icon + label
    const icon = isRtmp ? '📡' : '🔗';
    const label = layer.name || (isRtmp ? 'RTMP Source' : 'SRT Source');
    const subLabel = isActive ? '● Live from hardware' : '○ Waiting for stream…';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const cx = x + width / 2;
    const cy = y + height / 2;

    // Icon
    ctx.font = `${Math.min(32, height / 6)}px sans-serif`;
    ctx.fillStyle = '#888';
    ctx.fillText(icon, cx, cy - Math.min(24, height / 8));

    // Source name
    ctx.font = `bold ${Math.min(16, height / 10)}px sans-serif`;
    ctx.fillStyle = isActive ? '#2ecc71' : '#888';
    ctx.fillText(label, cx, cy + Math.min(8, height / 16));

    // Status
    ctx.font = `${Math.min(11, height / 14)}px sans-serif`;
    ctx.fillStyle = isActive ? '#27ae60' : '#555';
    ctx.fillText(subLabel, cx, cy + Math.min(28, height / 6));

    // Stream key / URL hint at bottom
    const hint = layer._input
      ? (isRtmp ? `key: ${layer._input.streamKey || ''}` : layer._input.url || '')
      : '';
    if (hint) {
      ctx.font = `${Math.min(10, height / 16)}px monospace`;
      ctx.fillStyle = '#444';
      // Truncate hint to fit
      const maxW = width - 20;
      let displayHint = hint;
      while (ctx.measureText(displayHint).width > maxW && displayHint.length > 6) {
        displayHint = displayHint.slice(0, -4) + '…';
      }
      ctx.fillText(displayHint, cx, y + height - Math.min(12, height / 10));
    }
  }

  _drawTextLayer(ctx, layer) {
    const { x, y, width, height } = layer;
    const style = layer.textStyle || {};
    const fontSize = style.fontSize || 32;
    const fontFamily = style.fontFamily || 'Arial';
    const fontWeight = style.bold ? 'bold' : 'normal';
    const fontStyle = style.italic ? 'italic' : 'normal';
    const color = style.color || '#ffffff';
    const bgColor = style.bgColor || 'transparent';
    const bgOpacity = style.bgOpacity !== undefined ? style.bgOpacity : 0.6;
    const padding = style.padding || 10;
    const align = style.align || 'left';

    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}"`;
    ctx.textBaseline = 'top';

    // Background
    if (bgColor !== 'transparent') {
      const [r, g, b] = hexToRgb(bgColor);
      ctx.fillStyle = `rgba(${r},${g},${b},${bgOpacity})`;
      ctx.fillRect(x, y, width, height);
    }

    // Text
    ctx.fillStyle = color;
    ctx.textAlign = align;

    const lines = wrapText(ctx, layer.text || '', width - padding * 2);
    let lineY = y + padding;
    const lineHeight = fontSize * 1.3;

    let textX;
    if (align === 'center') textX = x + width / 2;
    else if (align === 'right') textX = x + width - padding;
    else textX = x + padding;

    for (const line of lines) {
      if (lineY + lineHeight > y + height) break;
      ctx.fillText(line, textX, lineY);
      lineY += lineHeight;
    }
  }

  // ── Preview UI handles ────────────────────────────────────────────────────

  _drawHandles(ctx, r) {
    const { x, y, w, h } = r;
    const hs = 8; // handle size

    // Dashed border
    ctx.save();
    ctx.strokeStyle = '#0078d4';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // Corner + edge handles
    const handles = this._getHandlePositions(r);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#0078d4';
    ctx.lineWidth = 1.5;

    for (const { hx, hy } of handles) {
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
  }

  _getHandlePositions({ x, y, w, h }) {
    const mx = x + w / 2;
    const my = y + h / 2;
    return [
      { hx: x,      hy: y,      cursor: 'nw-resize', dir: 'nw' },
      { hx: mx,     hy: y,      cursor: 'n-resize',  dir: 'n'  },
      { hx: x + w,  hy: y,      cursor: 'ne-resize', dir: 'ne' },
      { hx: x + w,  hy: my,     cursor: 'e-resize',  dir: 'e'  },
      { hx: x + w,  hy: y + h,  cursor: 'se-resize', dir: 'se' },
      { hx: mx,     hy: y + h,  cursor: 's-resize',  dir: 's'  },
      { hx: x,      hy: y + h,  cursor: 'sw-resize', dir: 'sw' },
      { hx: x,      hy: my,     cursor: 'w-resize',  dir: 'w'  },
    ];
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  _toPreview(layer) {
    const sx = this._preview.width / this._output.width;
    const sy = this._preview.height / this._output.height;
    return {
      x: layer.x * sx,
      y: layer.y * sy,
      w: layer.width * sx,
      h: layer.height * sy,
    };
  }

  _toOutput(px, py) {
    const sx = this._output.width / this._preview.width;
    const sy = this._output.height / this._preview.height;
    return { x: px * sx, y: py * sy };
  }

  _canvasPoint(e) {
    const rect = this._preview.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Mouse event handling ──────────────────────────────────────────────────

  _bindEvents() {
    window.addEventListener('resize', () => {
      this._resizePreview();
    });

    const cv = this._preview;
    cv.addEventListener('mousedown', e => this._onMouseDown(e));
    cv.addEventListener('mousemove', e => this._onMouseMove(e));
    cv.addEventListener('mouseup',   e => this._onMouseUp(e));
    cv.addEventListener('mouseleave', e => this._onMouseUp(e));
    cv.addEventListener('dblclick',  e => this._onDblClick(e));
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const pt = this._canvasPoint(e);

    // Check if clicking a handle of selected layer
    if (this._selected) {
      const r = this._toPreview(this._selected);
      const handle = this._hitTestHandle(pt, r);
      if (handle) {
        this._drag = {
          type: 'resize',
          dir: handle.dir,
          layer: this._selected,
          startPt: pt,
          startLayer: { ...this._selected },
        };
        return;
      }
    }

    // Hit test layers (from top to bottom)
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i];
      if (!layer.visible) continue;
      const r = this._toPreview(layer);
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
        this.selectLayer(layer);
        this._drag = {
          type: 'move',
          layer,
          startPt: pt,
          startLayer: { x: layer.x, y: layer.y },
        };
        return;
      }
    }

    // Click on empty space — deselect
    this.selectLayer(null);
  }

  _onMouseMove(e) {
    if (!this._drag) {
      this._updateCursor(this._canvasPoint(e));
      return;
    }

    const pt = this._canvasPoint(e);
    const dx = pt.x - this._drag.startPt.x;
    const dy = pt.y - this._drag.startPt.y;

    // Convert pixel delta to output coords
    const ow = this._output.width;
    const oh = this._output.height;
    const pw = this._preview.width;
    const ph = this._preview.height;
    const odx = dx * ow / pw;
    const ody = dy * oh / ph;

    const sl = this._drag.startLayer;
    const layer = this._drag.layer;
    const MIN = MIN_LAYER_SIZE;

    if (this._drag.type === 'move') {
      layer.x = clamp(sl.x + odx, 0, ow - layer.width);
      layer.y = clamp(sl.y + ody, 0, oh - layer.height);
    } else if (this._drag.type === 'resize') {
      applyResize(layer, sl, odx, ody, this._drag.dir, ow, oh, MIN);
    }

    this._emitSelectionChanged();
  }

  _onMouseUp(_e) {
    this._drag = null;
  }

  _onDblClick(e) {
    const pt = this._canvasPoint(e);
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i];
      if (!layer.visible || layer.type !== 'text') continue;
      const r = this._toPreview(layer);
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
        this._editText(layer, r);
        return;
      }
    }
  }

  _editText(layer, r) {
    const editor = document.getElementById('inline-text-editor');
    const wrapper = document.getElementById('canvas-wrapper');
    const wrRect = wrapper.getBoundingClientRect();
    const cvRect = this._preview.getBoundingClientRect();

    const left = cvRect.left - wrRect.left + r.x;
    const top = cvRect.top - wrRect.top + r.y;

    editor.style.display = 'block';
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
    editor.style.width = `${r.w}px`;
    editor.style.height = `${r.h}px`;
    editor.style.fontSize = `${(layer.textStyle.fontSize || 32) * (this._preview.width / this._output.width)}px`;
    editor.value = layer.text || '';
    editor.focus();

    const finish = () => {
      layer.text = editor.value;
      editor.style.display = 'none';
      editor.removeEventListener('blur', finish);
      editor.removeEventListener('keydown', onKey);
      this._emitSelectionChanged();
      this._emitLayersChanged();
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish();
    };

    editor.addEventListener('blur', finish);
    editor.addEventListener('keydown', onKey);
  }

  _hitTestHandle(pt, r) {
    const handles = this._getHandlePositions(r);
    for (const h of handles) {
      if (Math.abs(pt.x - h.hx) <= HANDLE_HIT_AREA_SIZE && Math.abs(pt.y - h.hy) <= HANDLE_HIT_AREA_SIZE) {
        return h;
      }
    }
    return null;
  }

  _updateCursor(pt) {
    if (this._selected) {
      const r = this._toPreview(this._selected);
      const handle = this._hitTestHandle(pt, r);
      if (handle) {
        this._preview.style.cursor = handle.cursor;
        return;
      }
    }

    // Check if over any layer
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const layer = this._layers[i];
      if (!layer.visible) continue;
      const r = this._toPreview(layer);
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
        this._preview.style.cursor = 'move';
        return;
      }
    }

    this._preview.style.cursor = 'default';
  }

  // ── Canvas sizing ─────────────────────────────────────────────────────────

  _resizePreview() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const padding = 24;
    const maxW = rect.width - padding * 2;
    const maxH = rect.height - padding * 2;
    const aspect = this._output.width / this._output.height;

    let previewW = maxW;
    let previewH = previewW / aspect;

    if (previewH > maxH) {
      previewH = maxH;
      previewW = previewH * aspect;
    }

    this._preview.width = Math.floor(previewW);
    this._preview.height = Math.floor(previewH);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  _emitLayersChanged() {
    document.dispatchEvent(new CustomEvent('layers-changed', { detail: this._layers }));
  }

  _emitSelectionChanged() {
    document.dispatchEvent(new CustomEvent('selection-changed', { detail: this._selected }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function wrapText(ctx, text, maxW) {
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    // Support explicit newlines
    const parts = word.split('\n');
    for (let p = 0; p < parts.length; p++) {
      const test = current ? `${current} ${parts[p]}` : parts[p];
      if (ctx.measureText(test).width > maxW && current) {
        lines.push(current);
        current = parts[p];
      } else {
        current = test;
      }
      if (p < parts.length - 1) {
        lines.push(current);
        current = '';
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function applyResize(layer, sl, odx, ody, dir, maxW, maxH, minSize) {
  let { x, y, width, height } = sl;

  if (dir.includes('e')) width = Math.max(minSize, width + odx);
  if (dir.includes('s')) height = Math.max(minSize, height + ody);
  if (dir.includes('w')) {
    const newW = Math.max(minSize, width - odx);
    x = x + width - newW;
    width = newW;
  }
  if (dir.includes('n')) {
    const newH = Math.max(minSize, height - ody);
    y = y + height - newH;
    height = newH;
  }

  layer.x = clamp(x, 0, maxW - minSize);
  layer.y = clamp(y, 0, maxH - minSize);
  layer.width = Math.min(width, maxW - layer.x);
  layer.height = Math.min(height, maxH - layer.y);
}

/**
 * Factory for creating a new scene layer with defaults.
 * @param {string} type - 'camera' | 'screen' | 'text' | 'image'
 * @param {object} overrides
 */
function createLayer(type, overrides = {}) {
  const id = `layer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const defaults = {
    id,
    type,
    name: type.charAt(0).toUpperCase() + type.slice(1),
    visible: true,
    opacity: 1,
    x: 0,
    y: 0,
    width: 640,
    height: 360,
  };
  return Object.assign(defaults, overrides);
}
