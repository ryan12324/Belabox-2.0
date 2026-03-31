'use strict';

const { spawn } = require('child_process');
const state = require('./state');
const { parseFFmpegStats } = require('./utils');
const { broadcast } = require('./ws');
const { RTMP_PORT, FFMPEG_GRACEFUL_SHUTDOWN_MS } = require('./constants');

/**
 * Return the enabled output destinations for a scene.
 * Handles both the new `outputs[]` array and the legacy `output` single-object form.
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

function buildInputUrl(input) {
  if (input.type === 'rtmp') return `rtmp://127.0.0.1:${RTMP_PORT}/live/${input.streamKey}`;
  if (input.type === 'browser') return `rtmp://127.0.0.1:${RTMP_PORT}/live/browser-${input.sourceId}`;
  if (input.type === 'rtmp_pull' || input.type === 'srt') return input.url || null;
  return null;
}

function startCompositor() {
  const scene = state.scenes.find(s => s.id === state.activeSceneId) || state.scenes[0];
  const { resolution, framerate, layers } = scene;

  // Support both `outputs[]` (new) and legacy `output` (single)
  const allOutputs = normalizeOutputs(scene);

  if (allOutputs.length === 0) return 'No output destinations configured (enable at least one and set its URL)';

  const [outW, outH] = (resolution || '1280x720').split('x').map(Number);
  const fps = framerate || 30;

  // Collect video layers that reference a known input
  const videoLayers = (layers || []).filter(
    l => l.visible !== false && l.sourceId && state.inputs.find(i => i.id === l.sourceId)
  );

  const args = ['-loglevel', 'warning'];
  const inputIndexMap = new Map(); // input.id → ffmpeg input index

  if (videoLayers.length === 0) {
    args.push('-f', 'lavfi', '-i', `color=c=black:s=${outW}x${outH}:r=${fps}`);
  } else {
    for (const vl of videoLayers) {
      const input = state.inputs.find(i => i.id === vl.sourceId);
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
    state.ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `Failed to start FFmpeg: ${err.message}`;
  }

  state.streamActive = true;
  state.streamStartTime = Date.now();

  state.ffmpegProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    if (/frame=|fps=|bitrate=|speed=/.test(line)) broadcast({ type: 'stream_stats', data: parseFFmpegStats(line) });
    if (/Error|error|warning/i.test(line)) broadcast({ type: 'stream_log', level: 'warn', data: line.trim() });
  });
  state.ffmpegProcess.on('close', (code) => {
    state.streamActive = false;
    state.streamStartTime = null;
    state.ffmpegProcess = null;
    broadcast({ type: 'stream_ended', exitCode: code });
  });
  state.ffmpegProcess.on('error', (err) => {
    state.streamActive = false;
    state.streamStartTime = null;
    broadcast({ type: 'stream_error', message: err.message });
  });

  broadcast({ type: 'stream_started', config: { resolution, framerate, outputCount: allOutputs.length } });
  return null;
}

function stopCompositor() {
  if (!state.ffmpegProcess) { broadcast({ type: 'stream_stopped' }); return; }
  const proc = state.ffmpegProcess;
  setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); }, FFMPEG_GRACEFUL_SHUTDOWN_MS);
  state.ffmpegProcess = null; state.streamActive = false; state.streamStartTime = null;
  broadcast({ type: 'stream_stopped' });
}

module.exports = { normalizeOutputs, buildInputUrl, startCompositor, stopCompositor };
