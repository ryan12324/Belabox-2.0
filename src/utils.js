'use strict';

const { spawnSync } = require('child_process');
const { FFMPEG_VERSION_CHECK_TIMEOUT_MS } = require('./constants');

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

module.exports = { isFFmpegAvailable, parseFFmpegStats, deepMerge };
