/**
 * SceneManager – manages multiple named scenes for Belabox 2.0.
 *
 * Each scene has its own layer layout, resolution, framerate and output
 * settings. Switching scenes is instant from the browser; if a stream is
 * active the server will restart the FFmpeg compositor with the new scene.
 */

'use strict';

class SceneManager {
  constructor(sceneEditor) {
    this._editor = sceneEditor;
    /** @type {Array<{id,name,resolution,framerate,layers,output}>} */
    this._scenes = [];
    this._activeSceneId = null;
    /** @type {Map<string,object>} sceneId → browser-side layer state */
    this._sceneLayerCache = new Map();
  }

  // ── State ─────────────────────────────────────────────────────────────────

  get scenes() { return this._scenes; }
  get activeSceneId() { return this._activeSceneId; }
  get activeScene() { return this._scenes.find(s => s.id === this._activeSceneId) || null; }

  // ── Load from server ──────────────────────────────────────────────────────

  /**
   * Initialise from the data sent in the 'connected' WebSocket message.
   * @param {object} serverState - { scenes, activeSceneId }
   */
  loadFromServerState(serverState) {
    this._scenes = serverState.scenes || [];
    this._activeSceneId = serverState.activeSceneId || (this._scenes[0] && this._scenes[0].id);
  }

  /**
   * Update scene list when server broadcasts `scenes_updated`.
   */
  onScenesUpdated(scenes, activeSceneId) {
    this._scenes = scenes;
    if (activeSceneId) this._activeSceneId = activeSceneId;
  }

  // ── Save current editor state into scene cache ────────────────────────────

  /**
   * Save the current editor layers into the active scene's cache so we can
   * restore them when switching back.
   */
  saveCurrentScene() {
    if (!this._activeSceneId) return;
    // Shallow-clone layers array for caching
    this._sceneLayerCache.set(this._activeSceneId, this._editor.layers.slice());
  }

  // ── Switch scene ──────────────────────────────────────────────────────────

  /**
   * Switch to a scene by ID.
   * Saves current editor layers, restores (or clears) the target scene's
   * layers in the editor, and notifies the server.
   *
   * @param {string} sceneId
   */
  async switchScene(sceneId) {
    if (sceneId === this._activeSceneId) return;

    // Save current layers
    this.saveCurrentScene();

    // Clear the editor
    const prevLayers = this._editor.layers.slice();
    for (const l of prevLayers) this._editor.removeLayer(l.id);

    // Restore cached layers for the new scene (if any)
    const cached = this._sceneLayerCache.get(sceneId);
    if (cached) {
      for (const l of cached) this._editor.addLayer(l);
    }

    this._activeSceneId = sceneId;

    // Update UI output settings from the target scene
    const scene = this._scenes.find(s => s.id === sceneId);
    if (scene) {
      this._applySceneSettings(scene);
    }

    // Notify server
    try {
      await fetch(`/api/scenes/${sceneId}/activate`, { method: 'POST' });
    } catch (err) {
      console.error('[Scenes] Switch failed:', err.message);
    }

    document.dispatchEvent(new CustomEvent('scene-switched', { detail: { sceneId } }));
  }

  /** Apply scene resolution/framerate/output settings to the UI controls */
  _applySceneSettings(scene) {
    const resEl = document.getElementById('output-resolution');
    const fpsEl = document.getElementById('output-fps');

    if (resEl && scene.resolution) resEl.value = scene.resolution;
    if (fpsEl && scene.framerate) fpsEl.value = String(scene.framerate);

    // Reload output destinations for the new scene via OutputManager
    if (window._outputManager && scene.outputs) {
      window._outputManager.loadOutputs(scene.outputs);
    }

    if (resEl) {
      document.dispatchEvent(new CustomEvent('resolution-changed', { detail: resEl.value }));
    }
  }

  // ── Create scene ──────────────────────────────────────────────────────────

  async createScene(name) {
    try {
      const res = await fetch('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || `Scene ${this._scenes.length + 1}` }),
      });
      const scene = await res.json();
      if (!this._scenes.find(s => s.id === scene.id)) {
        this._scenes.push(scene);
      }
      return scene;
    } catch (err) {
      console.error('[Scenes] Create failed:', err.message);
      throw err;
    }
  }

  // ── Rename scene ──────────────────────────────────────────────────────────

  async renameScene(sceneId, name) {
    try {
      await fetch(`/api/scenes/${sceneId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const s = this._scenes.find(x => x.id === sceneId);
      if (s) s.name = name;
    } catch (err) {
      console.error('[Scenes] Rename failed:', err.message);
    }
  }

  // ── Delete scene ──────────────────────────────────────────────────────────

  async deleteScene(sceneId) {
    if (this._scenes.length <= 1) throw new Error('Cannot delete the last scene');
    try {
      await fetch(`/api/scenes/${sceneId}`, { method: 'DELETE' });
      this._scenes = this._scenes.filter(s => s.id !== sceneId);
      this._sceneLayerCache.delete(sceneId);
      if (this._activeSceneId === sceneId) {
        await this.switchScene(this._scenes[0].id);
      }
    } catch (err) {
      console.error('[Scenes] Delete failed:', err.message);
      throw err;
    }
  }

  // ── Duplicate scene ───────────────────────────────────────────────────────

  async duplicateScene(sceneId) {
    const src = this._scenes.find(s => s.id === sceneId);
    if (!src) return;
    return this.createScene(`${src.name} (copy)`);
  }
}
