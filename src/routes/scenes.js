'use strict';

const { Router } = require('express');
const state = require('../state');
const { broadcast } = require('../ws');
const { startCompositor, stopCompositor } = require('../compositor');
const { deepMerge } = require('../utils');

const router = Router();

router.get('/', (_req, res) => {
  res.json({ scenes: state.scenes, activeSceneId: state.activeSceneId, inputs: state.inputs });
});

router.post('/', (req, res) => {
  const { name } = req.body || {};
  const id = `scene-${Date.now()}`;
  const newScene = {
    id,
    name: name || `Scene ${state.scenes.length + 1}`,
    resolution: '1280x720',
    framerate: 30,
    layers: [],
    outputs: [
      {
        id: `out-${Date.now()}`,
        name: 'Stream',
        enabled: true,
        protocol: 'rtmp',
        url: '',
        key: '',
        videoBitrate: 3000,
        audioBitrate: 128,
        resolution: null,
      },
    ],
  };
  state.scenes.push(newScene);
  broadcast({ type: 'scenes_updated', scenes: state.scenes, activeSceneId: state.activeSceneId });
  res.json(newScene);
});

router.put('/:id', (req, res) => {
  const idx = state.scenes.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Scene not found' });
  state.scenes[idx] = { ...state.scenes[idx], ...req.body, id: state.scenes[idx].id };
  broadcast({ type: 'scenes_updated', scenes: state.scenes, activeSceneId: state.activeSceneId });
  res.json(state.scenes[idx]);
});

router.delete('/:id', (req, res) => {
  if (state.scenes.length <= 1) return res.status(400).json({ error: 'Cannot delete the last scene' });
  state.scenes = state.scenes.filter(s => s.id !== req.params.id);
  if (state.activeSceneId === req.params.id) state.activeSceneId = state.scenes[0].id;
  broadcast({ type: 'scenes_updated', scenes: state.scenes, activeSceneId: state.activeSceneId });
  res.json({ ok: true });
});

router.post('/:id/activate', (req, res) => {
  const scene = state.scenes.find(s => s.id === req.params.id);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  state.activeSceneId = req.params.id;
  broadcast({ type: 'scene_activated', sceneId: state.activeSceneId, scene });
  // If currently streaming, restart compositor with new scene
  if (state.streamActive) {
    stopCompositor();
    setTimeout(() => startCompositor(), 500);
  }
  res.json({ ok: true, sceneId: state.activeSceneId });
});

// ── Legacy /api/scene compatibility (proxies to active scene) ─────────────────

router.get('/legacy', (_req, res) => {
  const scene = state.scenes.find(s => s.id === state.activeSceneId) || state.scenes[0];
  res.json({ ...scene, inputs: state.inputs });
});

router.post('/legacy', (req, res) => {
  const body = req.body || {};
  const idx = state.scenes.findIndex(s => s.id === state.activeSceneId);
  if (idx < 0) return res.status(404).json({ error: 'No active scene' });
  if (body.inputs !== undefined) {
    state.inputs = body.inputs;
    delete body.inputs;
  }
  state.scenes[idx] = { ...state.scenes[idx], ...body, id: state.scenes[idx].id };
  broadcast({ type: 'scenes_updated', scenes: state.scenes, activeSceneId: state.activeSceneId });
  res.json({ ok: true });
});

router.patch('/legacy', (req, res) => {
  const body = req.body || {};
  const idx = state.scenes.findIndex(s => s.id === state.activeSceneId);
  if (idx < 0) return res.status(404).json({ error: 'No active scene' });
  if (body.inputs !== undefined) { state.inputs = body.inputs; delete body.inputs; }
  state.scenes[idx] = deepMerge(state.scenes[idx], body);
  broadcast({ type: 'scenes_updated', scenes: state.scenes, activeSceneId: state.activeSceneId });
  res.json({ ok: true });
});

module.exports = router;
