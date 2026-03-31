'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { setupWebSockets } = require('./src/ws');
const { createRtmpServer } = require('./src/rtmp-ingest');
const router = require('./src/routes/index');
const { isFFmpegAvailable } = require('./src/utils');
const { HTTP_PORT, RTMP_PORT } = require('./src/constants');
const { authMiddleware } = require('./src/auth');

const app = express();
app.use(express.json());

// Auth middleware runs before static files so the whole UI is protected
app.use(authMiddleware);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', router);

const server = http.createServer(app);
setupWebSockets(server);
createRtmpServer(RTMP_PORT).run();

server.listen(HTTP_PORT, () => {
  console.log(`\n🎬  Belabox 2.0 streaming studio`);
  console.log(`    Web UI at http://localhost:${HTTP_PORT}`);
  console.log(`    RTMP ingest at rtmp://YOUR_SERVER_IP:${RTMP_PORT}/live/<stream-key>`);
  console.log(`    FFmpeg available: ${isFFmpegAvailable()}\n`);
});

