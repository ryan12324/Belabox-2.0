'use strict';

// All mutable server state in one place
const state = {
  scenes: [
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
  ],
  activeSceneId: 'scene-default',
  inputs: [],
  ffmpegProcess: null,
  streamActive: false,
  streamStartTime: null,
  /** Connected hardware ingest streams: streamKey → { publishTime, sessionId } */
  activeIngestStreams: new Map(),
  /** Active browser source re-streamer processes: sourceId → { proc, streamKey } */
  browserSourceProcs: new Map(),
};

module.exports = state;
