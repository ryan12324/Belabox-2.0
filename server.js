'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const NodeMediaServer = require('node-media-server');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const FFMPEG_GRACEFUL_SHUTDOWN_MS = 2000;
const FFMPEG_VERSION_CHECK_TIMEOUT_MS = 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const HTTP_PORT = process.env.PORT || 3000;
/** ms between MediaRecorder chunks from the browser (also defined in sources.js) */
const BROWSER_SOURCE_CHUNK_MS = 250;

// ── Express + WebSocket ───────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
/** Control WebSocket — browser config UI */
const wss = new WebSocket.Server({ noServer: true });
/** Browser source WebSocket — receives WebM binary data */
const wssSource = new WebSocket.Server({ noServer: true });

// Route WebSocket upgrades by path
server.on('upgrade', (req, socket, head) => {
  const pathname = (new URL(req.url, 'http://localhost')).pathname;
  if (pathname === '/ws/source') {
    wssSource.handleUpgrade(req, socket, head, (ws) => {
      wssSource.emit('connection', ws, req);
    });
  } else {
    // Default: control channel (matches /ws or /)
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Global state ──────────────────────────────────────────────────────────────

let ffmpegProcess = null;
let streamActive = false;
let streamStartTime = null;

/**
 * Global inputs (hardware RTMP, SRT, or browser sources).
 * Shared across all scenes so layouts can reference them by id.
 * { id, name, type ('rtmp'|'srt'|'rtmp_pull'|'browser'), streamKey?, url?, sourceId? }
 */
let inputs = [];

/**
 * Named scenes. Each has its own layer layout, resolution, framerate and output settings.
 * Layers reference input.id via sourceId.
 */
let scenes = [
  {
    id: 'scene-default',
    name: 'Scene 1',
    resolution: '1280x720',
    framerate: 30,
    layers: [],
    outputs: [
      {
        id: 'out-default',
        name: 'Stream',
        enabled: true,
        protocol: 'rtmp',
        url: '',
        key: '',
        videoBitrate: 3000,
        audioBitrate: 128,
        resolution: null, // null = use scene resolution
      },
    ],
  },
];
let activeSceneId = 'scene-default';

/** Connected hardware ingest streams: streamKey → { publishTime, sessionId } */
const activeIngestStreams = new Map();

/** Active browser source re-streamer processes: sourceId → { proc, streamKey } */
const browserSourceProcs = new Map();

// ── RTMP Ingest Server (node-media-server) ────────────────────────────────────

const nmsConfig = {
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  logType: 0,
};
const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', (id, streamPath, _args) => {
  const streamKey = streamPath.split('/').pop();
  console.log(`[RTMP] Ingest started: key=${streamKey}`);
  activeIngestStreams.set(streamKey, { publishTime: Date.now(), sessionId: id });
  broadcast({ type: 'ingest_connected', streamKey });
});

nms.on('donePublish', (id, streamPath, _args) => {
  const streamKey = streamPath.split('/').pop();
  console.log(`[RTMP] Ingest ended: key=${streamKey}`);
  activeIngestStreams.delete(streamKey);
  broadcast({ type: 'ingest_disconnected', streamKey });
});

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({
    version: '2.0.0',
    ffmpegAvailable: isFFmpegAvailable(),
    streamActive,
    streamStartTime,
    rtmpIngestPort: RTMP_PORT,
    activeIngestStreams: Object.fromEntries(activeIngestStreams),
  });
});

// ── Inputs API ────────────────────────────────────────────────────────────────

app.get('/api/inputs', (_req, res) => res.json(inputs));

app.post('/api/inputs', (req, res) => {
  const input = req.body;
  if (!input || !input.id || !input.type) return res.status(400).json({ error: 'Invalid input' });
  inputs = inputs.filter(i => i.id !== input.id);
  inputs.push(input);
  broadcast({ type: 'inputs_updated', inputs });
  res.json({ ok: true });
});

app.delete('/api/inputs/:id', (req, res) => {
  inputs = inputs.filter(i => i.id !== req.params.id);
  broadcast({ type: 'inputs_updated', inputs });
  res.json({ ok: true });
});

// ── Scenes API ────────────────────────────────────────────────────────────────

app.get('/api/scenes', (_req, res) => {
  res.json({ scenes, activeSceneId, inputs });
});

app.post('/api/scenes', (req, res) => {
  const { name } = req.body || {};
  const id = `scene-${Date.now()}`;
  const newScene = {
    id,
    name: name || `Scene ${scenes.length + 1}`,
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
  scenes.push(newScene);
  broadcast({ type: 'scenes_updated', scenes, activeSceneId });
  res.json(newScene);
});

app.put('/api/scenes/:id', (req, res) => {
  const idx = scenes.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Scene not found' });
  scenes[idx] = { ...scenes[idx], ...req.body, id: scenes[idx].id };
  broadcast({ type: 'scenes_updated', scenes, activeSceneId });
  res.json(scenes[idx]);
});

app.delete('/api/scenes/:id', (req, res) => {
  if (scenes.length <= 1) return res.status(400).json({ error: 'Cannot delete the last scene' });
  scenes = scenes.filter(s => s.id !== req.params.id);
  if (activeSceneId === req.params.id) activeSceneId = scenes[0].id;
  broadcast({ type: 'scenes_updated', scenes, activeSceneId });
  res.json({ ok: true });
});

app.post('/api/scenes/:id/activate', (req, res) => {
  const scene = scenes.find(s => s.id === req.params.id);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  activeSceneId = req.params.id;
  broadcast({ type: 'scene_activated', sceneId: activeSceneId, scene });
  // If currently streaming, restart compositor with new scene
  if (streamActive) {
    stopCompositor();
    setTimeout(() => startCompositor(), 500);
  }
  res.json({ ok: true, sceneId: activeSceneId });
});

// ── Legacy /api/scene compatibility (proxies to active scene) ─────────────────

app.get('/api/scene', (_req, res) => {
  const scene = scenes.find(s => s.id === activeSceneId) || scenes[0];
  res.json({ ...scene, inputs });
});

app.post('/api/scene', (req, res) => {
  const body = req.body || {};
  const idx = scenes.findIndex(s => s.id === activeSceneId);
  if (idx < 0) return res.status(404).json({ error: 'No active scene' });
  // Extract inputs if present (they're global)
  if (body.inputs !== undefined) {
    inputs = body.inputs;
    delete body.inputs;
  }
  scenes[idx] = { ...scenes[idx], ...body, id: scenes[idx].id };
  broadcast({ type: 'scenes_updated', scenes, activeSceneId });
  res.json({ ok: true });
});

app.patch('/api/scene', (req, res) => {
  const body = req.body || {};
  const idx = scenes.findIndex(s => s.id === activeSceneId);
  if (idx < 0) return res.status(404).json({ error: 'No active scene' });
  if (body.inputs !== undefined) { inputs = body.inputs; delete body.inputs; }
  scenes[idx] = deepMerge(scenes[idx], body);
  broadcast({ type: 'scenes_updated', scenes, activeSceneId });
  res.json({ ok: true });
});

// ── Stream control ────────────────────────────────────────────────────────────

app.post('/api/stream/start', (_req, res) => {
  if (streamActive) return res.status(409).json({ error: 'Stream already active' });
  const err = startCompositor();
  if (err) return res.status(500).json({ error: err });
  res.json({ ok: true });
});

app.post('/api/stream/stop', (_req, res) => {
  stopCompositor();
  res.json({ ok: true });
});

// ── FFmpeg compositor ─────────────────────────────────────────────────────────

/**
 * Return the enabled output destinations for a scene.
 * Handles both the new `outputs[]` array and the legacy `output` single-object form.
 * @param {object} scene
 * @returns {Array<{id,name,enabled,protocol,url,key,videoBitrate,audioBitrate,resolution}>}
 */
function normalizeOutputs(scene) {
  if (Array.isArray(scene.outputs)) {
    return scene.outputs.filter(o => o.enabled && o.url);
  }
  if (scene.output && scene.output.url) {
    return [{ ...scene.output, id: 'legacy', enabled: true, resolution: null }];
  }
  return [];
}

function startCompositor() {
  const scene = scenes.find(s => s.id === activeSceneId) || scenes[0];
  const { resolution, framerate, layers } = scene;

  // Support both `outputs[]` (new) and legacy `output` (single)
  const allOutputs = normalizeOutputs(scene);

  if (allOutputs.length === 0) return 'No output destinations configured (enable at least one and set its URL)';

  const [outW, outH] = (resolution || '1280x720').split('x').map(Number);
  const fps = framerate || 30;

  // Collect video layers that reference a known input
  const videoLayers = (layers || []).filter(
    l => l.visible !== false && l.sourceId && inputs.find(i => i.id === l.sourceId)
  );

  const args = ['-loglevel', 'warning'];
  const inputIndexMap = new Map(); // input.id → ffmpeg input index

  if (videoLayers.length === 0) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${outW}x${outH}:r=${fps}`);
  } else {
    for (const vl of videoLayers) {
      const input = inputs.find(i => i.id === vl.sourceId);
      if (!input || inputIndexMap.has(input.id)) continue;
      const inputUrl = buildInputUrl(input);
      if (!inputUrl) continue;
      inputIndexMap.set(input.id, inputIndexMap.size);
      args.push('-i', inputUrl);
    }
  }

  const filterParts = [];
  let lastVideoTag = null;

  if (videoLayers.length === 0) {
    lastVideoTag = '0:v';
  } else {
    const firstLayer = videoLayers[0];
    const firstInputIdx = inputIndexMap.get(firstLayer.sourceId) ?? 0;
    filterParts.push(
      `[${firstInputIdx}:v]scale=${firstLayer.width}:${firstLayer.height},` +
      `pad=${outW}:${outH}:${firstLayer.x}:${firstLayer.y}[base]`
    );
    lastVideoTag = 'base';

    for (let i = 1; i < videoLayers.length; i++) {
      const vl = videoLayers[i];
      const inputIdx = inputIndexMap.get(vl.sourceId) ?? 0;
      const scaledTag = `v${i}scaled`;
      const composedTag = `composed${i}`;
      filterParts.push(`[${inputIdx}:v]scale=${vl.width}:${vl.height}[${scaledTag}]`);
      filterParts.push(`[${lastVideoTag}][${scaledTag}]overlay=${vl.x}:${vl.y}[${composedTag}]`);
      lastVideoTag = composedTag;
    }
  }

  // Text overlays
  const textLayers = (layers || []).filter(l => l.visible !== false && l.type === 'text' && l.text);
  for (let i = 0; i < textLayers.length; i++) {
    const tl = textLayers[i];
    const s = tl.textStyle || {};
    const outTag = `text${i}out`;
    const fontColor = (s.color || '#ffffff').replace('#', '');
    const bgColor = (s.bgColor || '#000000').replace('#', '');
    const bgOpacity = s.bgOpacity !== undefined ? s.bgOpacity : 0.5;
    const escapedText = (tl.text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
    filterParts.push(
      `[${lastVideoTag}]drawtext=text='${escapedText}':x=${Math.round(tl.x)}:y=${Math.round(tl.y)}:` +
      `fontsize=${s.fontSize || 32}:fontcolor=0x${fontColor}:font=${(s.fontFamily || 'Arial').replace(/[^a-zA-Z\s]/g, '')}:` +
      `bold=${s.bold ? 1 : 0}:italic=${s.italic ? 1 : 0}:` +
      `box=1:boxcolor=0x${bgColor}@${bgOpacity}:boxborderw=6[${outTag}]`
    );
    lastVideoTag = outTag;
  }

  // Image overlays
  const imageLayers = (layers || []).filter(l => l.visible !== false && l.type === 'image' && l.imgUrl);
  for (let i = 0; i < imageLayers.length; i++) {
    const il = imageLayers[i];
    const imgIdx = inputIndexMap.size + i;
    const scaledTag = `img${i}scaled`;
    const composedTag = `img${i}out`;
    args.push('-i', il.imgUrl);
    filterParts.push(`[${imgIdx}:v]scale=${il.width}:${il.height}[${scaledTag}]`);
    filterParts.push(`[${lastVideoTag}][${scaledTag}]overlay=${il.x}:${il.y}[${composedTag}]`);
    lastVideoTag = composedTag;
  }

  // ── Multi-output: split composited video into one branch per destination ──────

  if (allOutputs.length === 1) {
    // Single output — no split needed, just map the composited video directly
    if (filterParts.length > 0) {
      // Check if we need to scale the output (e.g. TikTok vertical override)
      const dest = allOutputs[0];
      const destRes = dest.resolution;
      if (destRes && destRes !== resolution) {
        const [dw, dh] = destRes.split('x').map(Number);
        filterParts.push(`[${lastVideoTag}]scale=${dw}:${dh}[outfinal0]`);
        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', '[outfinal0]');
      } else {
        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', `[${lastVideoTag}]`);
      }
    } else {
      args.push('-map', '0:v');
    }

    if (videoLayers.length > 0) args.push('-map', '0:a?');

    const dest = allOutputs[0];
    const vBitrate = `${dest.videoBitrate || 3000}k`;
    const aBitrate = `${dest.audioBitrate || 128}k`;
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v', vBitrate, '-maxrate', vBitrate, '-bufsize', `${(dest.videoBitrate || 3000) * 2}k`,
      '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-r', String(fps),
      '-c:a', 'aac', '-b:a', aBitrate, '-ar', '44100', '-ac', '2'
    );
    const destUrl = dest.key ? `${dest.url}/${dest.key}` : dest.url;
    args.push('-f', dest.protocol === 'srt' ? 'mpegts' : 'flv', destUrl);

  } else {
    // Multiple outputs — use split filter to fan out to N encode chains
    const splitTags = allOutputs.map((_, i) => `[split${i}v]`).join('');
    if (filterParts.length > 0) {
      filterParts.push(`[${lastVideoTag}]split=${allOutputs.length}${splitTags}`);
    }

    // For each output: optional scale, then encode
    const finalTags = allOutputs.map((dest, i) => {
      const destRes = dest.resolution;
      if (destRes && destRes !== resolution) {
        const [dw, dh] = destRes.split('x').map(Number);
        if (filterParts.length > 0) {
          filterParts.push(`[split${i}v]scale=${dw}:${dh}[outfinal${i}]`);
        }
        return `[outfinal${i}]`;
      }
      return filterParts.length > 0 ? `[split${i}v]` : null;
    });

    if (filterParts.length > 0) {
      args.push('-filter_complex', filterParts.join(';'));
    }

    // Map + encode + output for each destination
    for (let i = 0; i < allOutputs.length; i++) {
      const dest = allOutputs[i];
      const vBitrate = `${dest.videoBitrate || 3000}k`;
      const aBitrate = `${dest.audioBitrate || 128}k`;

      if (filterParts.length > 0 && finalTags[i]) {
        args.push('-map', finalTags[i]);
      } else {
        args.push('-map', '0:v');
      }
      if (videoLayers.length > 0) args.push('-map', '0:a?');

      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-b:v', vBitrate, '-maxrate', vBitrate, '-bufsize', `${(dest.videoBitrate || 3000) * 2}k`,
        '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-r', String(fps),
        '-c:a', 'aac', '-b:a', aBitrate, '-ar', '44100', '-ac', '2'
      );
      const destUrl = dest.key ? `${dest.url}/${dest.key}` : dest.url;
      args.push('-f', dest.protocol === 'srt' ? 'mpegts' : 'flv', destUrl);
    }
  }

  console.log(`[FFmpeg] Compositor starting (${allOutputs.length} output(s)): ffmpeg ${args.join(' ')}`);
  try {
    ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `Failed to start FFmpeg: ${err.message}`;
  }

  streamActive = true;
  streamStartTime = Date.now();

  ffmpegProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (/frame=|fps=|bitrate=|speed=/.test(line)) broadcast({ type: 'stream_stats', data: parseFFmpegStats(line) });
    if (/Error|error|warning/i.test(line)) broadcast({ type: 'stream_log', level: 'warn', data: line.trim() });
  });
  ffmpegProcess.on('close', (code) => {
    streamActive = false;
    streamStartTime = null;
    ffmpegProcess = null;
    broadcast({ type: 'stream_ended', exitCode: code });
  });
  ffmpegProcess.on('error', (err) => {
    streamActive = false;
    streamStartTime = null;
    broadcast({ type: 'stream_error', message: err.message });
  });

  broadcast({ type: 'stream_started', config: { resolution, framerate, outputCount: allOutputs.length } });
  return null;
}

function stopCompositor() {
  if (!ffmpegProcess) { broadcast({ type: 'stream_stopped' }); return; }
  const proc = ffmpegProcess;
  setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); }, FFMPEG_GRACEFUL_SHUTDOWN_MS);
  ffmpegProcess = null; streamActive = false; streamStartTime = null;
  broadcast({ type: 'stream_stopped' });
}

function buildInputUrl(input) {
  if (input.type === 'rtmp') return `rtmp://127.0.0.1:${RTMP_PORT}/live/${input.streamKey}`;
  if (input.type === 'browser') return `rtmp://127.0.0.1:${RTMP_PORT}/live/browser-${input.sourceId}`;
  if (input.type === 'rtmp_pull' || input.type === 'srt') return input.url || null;
  return null;
}

// ── Browser source WebSocket (path /ws/source) ────────────────────────────────

wssSource.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, `http://localhost`);
  const sourceId = urlObj.searchParams.get('sourceId') || `anon-${Date.now()}`;
  const streamKey = `browser-${sourceId}`;

  console.log(`[BrowserSource] WebSocket connected: sourceId=${sourceId}`);

  // Spawn per-source FFmpeg: WebM from stdin → RTMP to local NMS
  const ffArgs = [
    '-loglevel', 'warning',
    '-re', '-f', 'webm', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-f', 'flv', `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`,
  ];

  let proc;
  try {
    proc = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    browserSourceProcs.set(sourceId, { proc, streamKey });
    broadcast({ type: 'browser_source_connected', sourceId, streamKey });
  } catch (err) {
    console.error('[BrowserSource] FFmpeg spawn failed:', err.message);
    ws.close();
    return;
  }

  proc.stderr.on('data', (d) => {
    const line = d.toString();
    if (/Error|error/i.test(line)) console.warn(`[BrowserSource:${sourceId}]`, line.trim());
  });

  proc.on('close', (code) => {
    console.log(`[BrowserSource] FFmpeg for ${sourceId} exited ${code}`);
    browserSourceProcs.delete(sourceId);
    broadcast({ type: 'browser_source_disconnected', sourceId });
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary && proc.stdin.writable) {
      proc.stdin.write(data, (err) => {
        if (err && err.code !== 'EPIPE') console.error(`[BrowserSource] stdin write error:`, err.message);
      });
    }
  });

  ws.on('close', () => {
    console.log(`[BrowserSource] WebSocket closed: sourceId=${sourceId}`);
    try { proc.stdin.end(); } catch (_) {}
    setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); }, FFMPEG_GRACEFUL_SHUTDOWN_MS);
  });

  ws.on('error', (err) => console.error(`[BrowserSource] WS error: ${err.message}`));
});

// ── Control WebSocket (path /ws) ──────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Control client connected from ${clientIp}`);

  send(ws, {
    type: 'connected',
    version: '2.0.0',
    streamActive,
    streamStartTime,
    rtmpIngestPort: RTMP_PORT,
    scenes,
    activeSceneId,
    inputs,
    activeIngestStreams: Object.fromEntries(activeIngestStreams),
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') send(ws, { type: 'pong', ts: Date.now() });
    } catch (_) {}
  });

  ws.on('error', (err) => console.error('[WS] Client error:', err.message));
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFFmpegAvailable() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: FFMPEG_VERSION_CHECK_TIMEOUT_MS, stdio: 'pipe' });
    return result.status === 0;
  } catch { return false; }
}

function parseFFmpegStats(line) {
  const stats = {};
  const m = (re) => (line.match(re) || [])[1];
  const f = m(/frame=\s*(\d+)/); if (f) stats.frame = parseInt(f, 10);
  const fps = m(/fps=\s*([\d.]+)/); if (fps) stats.fps = parseFloat(fps);
  const br = m(/bitrate=\s*([\d.]+\s*\S*bits\/s)/); if (br) stats.bitrate = br.trim();
  const sp = m(/speed=\s*([\d.]+x)/); if (sp) stats.speed = sp;
  return stats;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        typeof target[key] === 'object' && !Array.isArray(target[key])) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ── Start servers ─────────────────────────────────────────────────────────────

nms.run();

server.listen(HTTP_PORT, () => {
  console.log(`\n🎬  Belabox 2.0 streaming studio`);
  console.log(`    Web UI at http://localhost:${HTTP_PORT}`);
  console.log(`    RTMP ingest at rtmp://YOUR_SERVER_IP:${RTMP_PORT}/live/<stream-key>`);
  console.log(`    FFmpeg available: ${isFFmpegAvailable()}\n`);
});

