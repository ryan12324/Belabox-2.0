'use strict';

const { Router } = require('express');
const state = require('../state');
const { isFFmpegAvailable } = require('../utils');
const { startCompositor, stopCompositor } = require('../compositor');
const { RTMP_PORT } = require('../constants');

const router = Router();

router.get('/status', (_req, res) => {
  res.json({
    version: '2.0.0',
    ffmpegAvailable: isFFmpegAvailable(),
    streamActive: state.streamActive,
    streamStartTime: state.streamStartTime,
    rtmpIngestPort: RTMP_PORT,
    activeIngestStreams: Object.fromEntries(state.activeIngestStreams),
  });
});

router.post('/stream/start', (_req, res) => {
  if (state.streamActive) return res.status(409).json({ error: 'Stream already active' });
  const err = startCompositor();
  if (err) return res.status(500).json({ error: err });
  res.json({ ok: true });
});

router.post('/stream/stop', (_req, res) => {
  stopCompositor();
  res.json({ ok: true });
});

module.exports = router;
