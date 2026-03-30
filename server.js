'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const NodeMediaServer = require('node-media-server');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

/** ms to wait for FFmpeg to flush before sending SIGTERM on graceful shutdown */
const FFMPEG_GRACEFUL_SHUTDOWN_MS = 2000;
/** ms timeout for checking whether `ffmpeg -version` succeeds */
const FFMPEG_VERSION_CHECK_TIMEOUT_MS = 3000;
/** RTMP ingest port for hardware encoders */
const RTMP_PORT = process.env.RTMP_PORT || 1935;
/** HTTP port for the web UI */
const HTTP_PORT = process.env.PORT || 3000;

// ── Express + WebSocket ───────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Global state ──────────────────────────────────────────────────────────────

/** Active FFmpeg compositing process */
let ffmpegProcess = null;
let streamActive = false;
let streamStartTime = null;

/**
 * Scene configuration maintained in memory.
 * Browser pushes updates; server reads it when building FFmpeg args.
 *
 * Shape:
 * {
 *   resolution: '1280x720',
 *   framerate: 30,
 *   inputs: [{ id, name, type ('rtmp'|'srt'|'rtmp_pull'), streamKey?, url? }],
 *   layers: [{ id, sourceId?, type, x, y, width, height, visible, opacity, text?, textStyle?, imgUrl? }],
 *   output: { protocol, url, key, videoBitrate, audioBitrate }
 * }
 */
let sceneConfig = {
  resolution: '1280x720',
  framerate: 30,
  inputs: [],
  layers: [],
  output: {
    protocol: 'rtmp',
    url: '',
    key: '',
    videoBitrate: 3000,
    audioBitrate: 128,
  },
};

/** Connected ingest streams: streamKey → { publishTime } */
const activeIngestStreams = new Map();

// ── RTMP Ingest Server (node-media-server) ────────────────────────────────────

const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  logType: 0, // silent; we handle our own logging
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', (id, streamPath, _args) => {
  const streamKey = streamPath.split('/').pop();
  console.log(`[RTMP] Ingest started: key=${streamKey} session=${id}`);
  activeIngestStreams.set(streamKey, { publishTime: Date.now(), sessionId: id });
  broadcast({ type: 'ingest_connected', streamKey });
});

nms.on('donePublish', (id, streamPath, _args) => {
  const streamKey = streamPath.split('/').pop();
  console.log(`[RTMP] Ingest ended: key=${streamKey} session=${id}`);
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

/** Get the current scene configuration */
app.get('/api/scene', (_req, res) => {
  res.json(sceneConfig);
});

/** Replace the full scene configuration */
app.post('/api/scene', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid scene config body' });
  }
  sceneConfig = { ...sceneConfig, ...body };
  console.log('[Scene] Config updated');
  broadcast({ type: 'scene_updated' });
  res.json({ ok: true });
});

/** Partially update the scene configuration */
app.patch('/api/scene', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid patch body' });
  }
  sceneConfig = deepMerge(sceneConfig, body);
  broadcast({ type: 'scene_updated' });
  res.json({ ok: true });
});

/** Start the composited output stream */
app.post('/api/stream/start', (_req, res) => {
  if (streamActive) {
    return res.status(409).json({ error: 'Stream already active' });
  }
  const err = startCompositor();
  if (err) {
    return res.status(500).json({ error: err });
  }
  res.json({ ok: true });
});

/** Stop the composited output stream */
app.post('/api/stream/stop', (_req, res) => {
  stopCompositor();
  res.json({ ok: true });
});

// ── FFmpeg compositor ─────────────────────────────────────────────────────────

/**
 * Build the FFmpeg argument list from the current sceneConfig using
 * filter_complex to composite multiple server-side RTMP/SRT inputs with
 * text and image overlays.
 *
 * Returns null on success, or an error string if config is invalid.
 */
function startCompositor() {
  const config = sceneConfig;
  const { resolution, framerate, inputs, layers, output } = config;

  if (!output || !output.url) {
    return 'No output URL configured';
  }

  const [outW, outH] = (resolution || '1280x720').split('x').map(Number);
  const fps = framerate || 30;
  const vBitrate = `${output.videoBitrate || 3000}k`;
  const aBitrate = `${output.audioBitrate || 128}k`;

  // Collect the video layers that reference an input source
  const videoLayers = layers.filter(
    l => l.visible !== false && l.sourceId && inputs.find(i => i.id === l.sourceId)
  );

  const args = ['-loglevel', 'warning'];

  // ── Inputs ────────────────────────────────────────────────────────────────
  const inputIndexMap = new Map(); // input.id → ffmpeg input index

  if (videoLayers.length === 0) {
    // No video inputs — create a black background using lavfi
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${outW}x${outH}:r=${fps}`);
  } else {
    for (const vl of videoLayers) {
      const input = inputs.find(i => i.id === vl.sourceId);
      if (!input) continue;
      if (!inputIndexMap.has(input.id)) {
        const idx = inputIndexMap.size;
        inputIndexMap.set(input.id, idx);
        const inputUrl = buildInputUrl(input);
        if (!inputUrl) continue;
        args.push('-i', inputUrl);
      }
    }
  }

  // ── filter_complex ────────────────────────────────────────────────────────
  const filterParts = [];
  let lastVideoTag = null;

  if (videoLayers.length === 0) {
    // Just the black background
    lastVideoTag = '0:v';
  } else {
    // Scale first input to full output size as the background
    const firstLayer = videoLayers[0];
    const firstInputIdx = inputIndexMap.get(firstLayer.sourceId) ?? 0;

    filterParts.push(
      `[${firstInputIdx}:v]scale=${firstLayer.width}:${firstLayer.height},` +
      `pad=${outW}:${outH}:${firstLayer.x}:${firstLayer.y}[base]`
    );
    lastVideoTag = 'base';

    // Overlay remaining video layers on top
    for (let i = 1; i < videoLayers.length; i++) {
      const vl = videoLayers[i];
      const inputIdx = inputIndexMap.get(vl.sourceId) ?? 0;
      const scaledTag = `v${i}scaled`;
      const composedTag = `composed${i}`;

      filterParts.push(
        `[${inputIdx}:v]scale=${vl.width}:${vl.height}[${scaledTag}]`
      );
      filterParts.push(
        `[${lastVideoTag}][${scaledTag}]overlay=${vl.x}:${vl.y}[${composedTag}]`
      );
      lastVideoTag = composedTag;
    }
  }

  // ── Text overlays ─────────────────────────────────────────────────────────
  const textLayers = layers.filter(
    l => l.visible !== false && l.type === 'text' && l.text
  );

  for (let i = 0; i < textLayers.length; i++) {
    const tl = textLayers[i];
    const s = tl.textStyle || {};
    const outTag = `text${i}out`;

    const fontSize = s.fontSize || 32;
    const fontColor = (s.color || '#ffffff').replace('#', '');
    const bgColor = s.bgColor ? s.bgColor.replace('#', '') : '000000';
    const bgOpacity = s.bgOpacity !== undefined ? s.bgOpacity : 0.5;
    const bold = s.bold ? 1 : 0;
    const italic = s.italic ? 1 : 0;
    const fontFamily = (s.fontFamily || 'Arial').replace(/[^a-zA-Z\s]/g, '');

    // Escape text for FFmpeg drawtext
    const escapedText = (tl.text || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:');

    const bgFilter = `box=1:boxcolor=0x${bgColor}@${bgOpacity}:boxborderw=6`;

    const drawtext =
      `[${lastVideoTag}]drawtext=` +
      `text='${escapedText}':` +
      `x=${Math.round(tl.x)}:y=${Math.round(tl.y)}:` +
      `fontsize=${fontSize}:fontcolor=0x${fontColor}:` +
      `font=${fontFamily}:bold=${bold}:italic=${italic}:` +
      `${bgFilter}[${outTag}]`;

    filterParts.push(drawtext);
    lastVideoTag = outTag;
  }

  // ── Image overlays ────────────────────────────────────────────────────────
  const imageLayers = layers.filter(
    l => l.visible !== false && l.type === 'image' && l.imgUrl
  );

  for (let i = 0; i < imageLayers.length; i++) {
    const il = imageLayers[i];
    const imgIdx = (inputIndexMap.size) + i;
    const scaledTag = `img${i}scaled`;
    const composedTag = `img${i}out`;

    args.push('-i', il.imgUrl);
    filterParts.push(
      `[${imgIdx}:v]scale=${il.width}:${il.height}[${scaledTag}]`
    );
    filterParts.push(
      `[${lastVideoTag}][${scaledTag}]overlay=${il.x}:${il.y}[${composedTag}]`
    );
    lastVideoTag = composedTag;
  }

  // ── Assemble filter_complex ───────────────────────────────────────────────
  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', `[${lastVideoTag}]`);
  } else {
    args.push('-map', `0:v`);
  }

  // Audio: mix all input audio tracks
  if (videoLayers.length > 0) {
    args.push('-map', '0:a?');
  }

  // ── Encode ────────────────────────────────────────────────────────────────
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', vBitrate,
    '-maxrate', vBitrate,
    '-bufsize', `${(output.videoBitrate || 3000) * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', aBitrate,
    '-ar', '44100',
    '-ac', '2'
  );

  // ── Output ────────────────────────────────────────────────────────────────
  const outputUrl = output.key ? `${output.url}/${output.key}` : output.url;

  if (output.protocol === 'srt') {
    args.push('-f', 'mpegts', outputUrl);
  } else {
    args.push('-f', 'flv', outputUrl);
  }

  console.log(`[FFmpeg] Starting compositor: ffmpeg ${args.join(' ')}`);

  try {
    ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[FFmpeg] Failed to spawn:', err.message);
    return `Failed to start FFmpeg: ${err.message}`;
  }

  streamActive = true;
  streamStartTime = Date.now();

  ffmpegProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (/frame=|fps=|bitrate=|speed=/.test(line)) {
      broadcast({ type: 'stream_stats', data: parseFFmpegStats(line) });
    }
    if (/Error|error|warning/i.test(line)) {
      broadcast({ type: 'stream_log', level: 'warn', data: line.trim() });
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[FFmpeg] Compositor exited with code ${code}`);
    streamActive = false;
    streamStartTime = null;
    ffmpegProcess = null;
    broadcast({ type: 'stream_ended', exitCode: code });
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[FFmpeg] Process error:', err.message);
    streamActive = false;
    streamStartTime = null;
    broadcast({ type: 'stream_error', message: err.message });
  });

  broadcast({ type: 'stream_started', config: { resolution, framerate, output } });
  return null;
}

function stopCompositor() {
  if (!ffmpegProcess) {
    broadcast({ type: 'stream_stopped' });
    return;
  }

  // Capture reference so the timeout closure uses it even if the outer
  // variable is reassigned (e.g. by a new stream starting during the wait).
  const proc = ffmpegProcess;
  setTimeout(() => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
  }, FFMPEG_GRACEFUL_SHUTDOWN_MS);

  ffmpegProcess = null;
  streamActive = false;
  streamStartTime = null;
  broadcast({ type: 'stream_stopped' });
}

/** Build an FFmpeg-compatible URL for a given input source */
function buildInputUrl(input) {
  if (input.type === 'rtmp') {
    // Ingest from local node-media-server
    return `rtmp://127.0.0.1:${RTMP_PORT}/live/${input.streamKey}`;
  }
  if (input.type === 'rtmp_pull' || input.type === 'srt') {
    return input.url || null;
  }
  return null;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);

  // Send current state on connect
  send(ws, {
    type: 'connected',
    version: '2.0.0',
    streamActive,
    streamStartTime,
    rtmpIngestPort: RTMP_PORT,
    sceneConfig,
    activeIngestStreams: Object.fromEntries(activeIngestStreams),
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') send(ws, { type: 'pong', ts: Date.now() });
    } catch (_) {
      // Ignore malformed messages
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

/** Send JSON to a single WebSocket client */
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** Broadcast JSON to all connected WebSocket clients */
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFFmpegAvailable() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], {
      timeout: FFMPEG_VERSION_CHECK_TIMEOUT_MS,
      stdio: 'pipe',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function parseFFmpegStats(line) {
  const stats = {};
  const frameMatch = line.match(/frame=\s*(\d+)/);
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+\s*\S*bits\/s)/);
  const speedMatch = line.match(/speed=\s*([\d.]+x)/);

  if (frameMatch) stats.frame = parseInt(frameMatch[1], 10);
  if (fpsMatch) stats.fps = parseFloat(fpsMatch[1]);
  if (bitrateMatch) stats.bitrate = bitrateMatch[1].trim();
  if (speedMatch) stats.speed = speedMatch[1];

  return stats;
}

/** Simple deep merge (objects only, arrays replaced) */
function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ── Start servers ─────────────────────────────────────────────────────────────

nms.run();
console.log(`    RTMP ingest listening on rtmp://0.0.0.0:${RTMP_PORT}/live/<stream-key>`);

server.listen(HTTP_PORT, () => {
  console.log(`\n🎬  Belabox 2.0 streaming studio`);
  console.log(`    Web UI at http://localhost:${HTTP_PORT}`);
  console.log(`    RTMP ingest at rtmp://YOUR_SERVER_IP:${RTMP_PORT}/live/<stream-key>`);
  console.log(`    FFmpeg available: ${isFFmpegAvailable()}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down…');
  if (ffmpegProcess) ffmpegProcess.kill('SIGTERM');
  nms.stop();
  server.close(() => process.exit(0));
});

