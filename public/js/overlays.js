/**
 * OverlaysManager – text and image overlay helpers
 */

'use strict';

class OverlaysManager {
  constructor(sceneEditor) {
    this._editor = sceneEditor;
  }

  // ── Text overlay ──────────────────────────────────────────────────────────

  addText(options = {}) {
    const ow = this._editor.outputCanvas.width;
    const oh = this._editor.outputCanvas.height;

    const layer = createLayer('text', {
      name: options.name || 'Text',
      text: options.text || 'Double-click to edit',
      x: options.x !== undefined ? options.x : Math.floor(ow * 0.05),
      y: options.y !== undefined ? options.y : Math.floor(oh * 0.8),
      width: options.width || Math.floor(ow * 0.9),
      height: options.height || Math.floor(oh * 0.15),
      textStyle: {
        fontSize: options.fontSize || 36,
        fontFamily: options.fontFamily || 'Arial',
        color: options.color || '#ffffff',
        bgColor: options.bgColor || '#000000',
        bgOpacity: options.bgOpacity !== undefined ? options.bgOpacity : 0.5,
        bold: options.bold || false,
        italic: options.italic || false,
        align: options.align || 'left',
        padding: options.padding || 10,
      },
    });

    this._editor.addLayer(layer);
    return layer;
  }

  // ── Image overlay ─────────────────────────────────────────────────────────

  addImage(src, options = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        const ow = this._editor.outputCanvas.width;
        const oh = this._editor.outputCanvas.height;

        // Fit into reasonable default size
        const maxW = Math.floor(ow * 0.3);
        const maxH = Math.floor(oh * 0.3);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(maxW / w, maxH / h, 1);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);

        const layer = createLayer('image', {
          name: options.name || 'Image',
          imgEl: img,
          x: options.x !== undefined ? options.x : Math.floor((ow - w) / 2),
          y: options.y !== undefined ? options.y : Math.floor((oh - h) / 2),
          width: options.width || w,
          height: options.height || h,
        });

        this._editor.addLayer(layer);
        resolve(layer);
      };

      img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
      img.src = src;
    });
  }

  addImageFromFile(file, options = {}) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.addImage(e.target.result, { ...options, name: options.name || file.name })
          .then(resolve)
          .catch(reject);
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  removeOverlay(layerId) {
    this._editor.removeLayer(layerId);
  }
}
