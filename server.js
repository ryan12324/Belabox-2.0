'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

/** ms to wait for FFmpeg to flush before sending SIGTERM on graceful shutdown */
const FFMPEG_GRACEFUL_SHUTDOWN_MS = 2000;
/** ms timeout for checking whether `ffmpeg -version` succeeds */
const FFMPEG_VERSION_CHECK_TIMEOUT_MS = 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Track active stream sessions
const sessions = new Map();
let clientCounter = 0;

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({
    activeStreams: sessions.size,
    version: '2.0.0',
    ffmpegAvailable: isFFmpegAvailable(),
  });
});

function isFFmpegAvailable() {
  try {
    const result = require('child_process').spawnSync('ffmpeg', ['-version'], {
      timeout: FFMPEG_VERSION_CHECK_TIMEOUT_MS,
      stdio: 'pipe',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientId = ++clientCounter;
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client ${clientId} connected from ${clientIp}`);

  let ffmpegProcess = null;
  let streamActive = false;
  let bytesReceived = 0;
  let streamStartTime = null;

  // Send initial state
  send(ws, { type: 'connected', clientId, version: '2.0.0' });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Control message (JSON)
      try {
        const msg = JSON.parse(data.toString());
        handleControl(msg);
      } catch (err) {
        console.error(`[WS] Invalid JSON from client ${clientId}:`, err.message);
      }
      return;
    }

    // Binary = video chunk — pipe to FFmpeg
    bytesReceived += data.length;
    if (ffmpegProcess && ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(data, (err) => {
        if (err && err.code !== 'EPIPE') {
          console.error(`[FFmpeg] stdin write error client ${clientId}:`, err.message);
        }
      });
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[WS] Client ${clientId} disconnected (${code} ${reason})`);
    stopStream();
    sessions.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client ${clientId} error:`, err.message);
  });

  // ── Control message handler ─────────────────────────────────────────────────

  function handleControl(msg) {
    switch (msg.type) {
      case 'start_stream':
        startStream(msg.config || {});
        break;
      case 'stop_stream':
        stopStream();
        break;
      case 'ping':
        send(ws, { type: 'pong', ts: Date.now() });
        break;
      default:
        console.warn(`[WS] Unknown message type from client ${clientId}: ${msg.type}`);
    }
  }

  // ── Stream management ───────────────────────────────────────────────────────

  function startStream(config) {
    if (streamActive) {
      stopStream();
    }

    const {
      outputUrl,
      outputType = 'rtmp',
      videoBitrate = 3000,
      audioBitrate = 128,
      framerate = 30,
      resolution = '1280x720',
    } = config;

    if (!outputUrl) {
      send(ws, { type: 'stream_error', message: 'No output URL provided' });
      return;
    }

    const args = buildFFmpegArgs({
      outputUrl,
      outputType,
      videoBitrate,
      audioBitrate,
      framerate,
      resolution,
    });

    console.log(`[FFmpeg] Starting for client ${clientId}: ffmpeg ${args.join(' ')}`);

    try {
      ffmpegProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error(`[FFmpeg] Failed to spawn for client ${clientId}:`, err.message);
      send(ws, { type: 'stream_error', message: `Failed to start FFmpeg: ${err.message}` });
      return;
    }

    streamActive = true;
    streamStartTime = Date.now();
    bytesReceived = 0;
    sessions.set(clientId, { ffmpegProcess, config, startTime: streamStartTime });

    ffmpegProcess.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      // Only forward meaningful lines (not the verbose init flood)
      if (/frame=|fps=|bitrate=|speed=/.test(line)) {
        send(ws, { type: 'stream_stats', data: parseFFmpegStats(line) });
      }
      if (/Error|error|warning/i.test(line)) {
        send(ws, { type: 'stream_log', level: 'warn', data: line.trim() });
      }
    });

    ffmpegProcess.stdout.on('data', () => {
      // stdout not used for RTMP/SRT output
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`[FFmpeg] Process for client ${clientId} exited with code ${code}`);
      streamActive = false;
      ffmpegProcess = null;
      sessions.delete(clientId);
      send(ws, { type: 'stream_ended', exitCode: code });
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`[FFmpeg] Process error for client ${clientId}:`, err.message);
      send(ws, { type: 'stream_error', message: err.message });
      streamActive = false;
    });

    send(ws, { type: 'stream_started', config });
  }

  function stopStream() {
    if (ffmpegProcess) {
      try {
        ffmpegProcess.stdin.end();
      } catch (_) {
        // ignore
      }
      setTimeout(() => {
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGTERM');
          ffmpegProcess = null;
        }
      }, FFMPEG_GRACEFUL_SHUTDOWN_MS);
      streamActive = false;
    }
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: 'stream_stopped' });
    }
  }
});

// ── FFmpeg helpers ────────────────────────────────────────────────────────────

function buildFFmpegArgs({ outputUrl, outputType, videoBitrate, audioBitrate, framerate }) {
  const bv = `${videoBitrate}k`;
  const ba = `${audioBitrate}k`;

  const inputArgs = [
    '-loglevel', 'warning',
    '-re',
    '-f', 'webm',
    '-i', 'pipe:0',
  ];

  const videoArgs = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', bv,
    '-maxrate', bv,
    '-bufsize', `${videoBitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(framerate * 2),
    '-r', String(framerate),
  ];

  const audioArgs = [
    '-c:a', 'aac',
    '-b:a', ba,
    '-ar', '44100',
    '-ac', '2',
  ];

  if (outputType === 'srt') {
    return [...inputArgs, ...videoArgs, ...audioArgs, '-f', 'mpegts', outputUrl];
  }

  // Default: RTMP (flv)
  return [...inputArgs, ...videoArgs, ...audioArgs, '-f', 'flv', outputUrl];
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

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎬  Belabox 2.0 streaming studio`);
  console.log(`    Running at http://localhost:${PORT}`);
  console.log(`    FFmpeg available: ${isFFmpegAvailable()}\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  sessions.forEach(({ ffmpegProcess }) => {
    if (ffmpegProcess) ffmpegProcess.kill('SIGTERM');
  });
  server.close(() => process.exit(0));
});
