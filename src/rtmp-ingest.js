'use strict';

const NodeMediaServer = require('node-media-server');
const state = require('./state');
const { broadcast } = require('./ws');

function createRtmpServer(rtmpPort) {
  const nmsConfig = {
    rtmp: { port: rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    logType: 0,
  };
  const nms = new NodeMediaServer(nmsConfig);

  nms.on('prePublish', (id, streamPath, _args) => {
    const streamKey = streamPath.split('/').pop();
    console.log(`[RTMP] Ingest started: key=${streamKey}`);
    state.activeIngestStreams.set(streamKey, { publishTime: Date.now(), sessionId: id });
    broadcast({ type: 'ingest_connected', streamKey });
  });

  nms.on('donePublish', (id, streamPath, _args) => {
    const streamKey = streamPath.split('/').pop();
    console.log(`[RTMP] Ingest ended: key=${streamKey}`);
    state.activeIngestStreams.delete(streamKey);
    broadcast({ type: 'ingest_disconnected', streamKey });
  });

  return nms;
}

module.exports = { createRtmpServer };
