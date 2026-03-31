'use strict';

const WebSocket = require('ws');
const { spawn } = require('child_process');
const state = require('./state');
const { RTMP_PORT, FFMPEG_GRACEFUL_SHUTDOWN_MS } = require('./constants');

/** Control WebSocket — browser config UI */
const wss = new WebSocket.Server({ noServer: true });
/** Browser source WebSocket — receives WebM binary data */
const wssSource = new WebSocket.Server({ noServer: true });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function setupWebSockets(server) {
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

  // ── Browser source WebSocket (path /ws/source) ──────────────────────────────
  wssSource.on('connection', (ws, req) => {
    const urlObj = new URL(req.url, 'http://localhost');
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
      state.browserSourceProcs.set(sourceId, { proc, streamKey });
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
      state.browserSourceProcs.delete(sourceId);
      broadcast({ type: 'browser_source_disconnected', sourceId });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary && proc.stdin.writable) {
        proc.stdin.write(data, (err) => {
          if (err && err.code !== 'EPIPE') console.error('[BrowserSource] stdin write error:', err.message);
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

  // ── Control WebSocket (path /ws) ─────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WS] Control client connected from ${clientIp}`);

    send(ws, {
      type: 'connected',
      version: '2.0.0',
      streamActive: state.streamActive,
      streamStartTime: state.streamStartTime,
      rtmpIngestPort: RTMP_PORT,
      scenes: state.scenes,
      activeSceneId: state.activeSceneId,
      inputs: state.inputs,
      activeIngestStreams: Object.fromEntries(state.activeIngestStreams),
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') send(ws, { type: 'pong', ts: Date.now() });
      } catch (_) {}
    });

    ws.on('error', (err) => console.error('[WS] Client error:', err.message));
  });
}

module.exports = { send, broadcast, wss, wssSource, setupWebSockets };
