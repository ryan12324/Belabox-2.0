# Belabox 2.0 — Web-Based Streaming Studio

A web-based streaming studio for **RTMP** and **SRT** streams. All video processing runs **server-side** — hardware encoders push RTMP/SRT streams directly to the Belabox server, which composites them using FFmpeg and outputs to any RTMP/SRT destination. The browser is a pure configuration UI.

## Features

- 📡 **Hardware RTMP ingest** — built-in RTMP server on port 1935 receives streams from cameras, encoder boxes, hardware capture cards, etc.
- 🔗 **SRT & RTMP pull** — connect to external SRT or RTMP stream URLs
- 🎬 **Server-side FFmpeg compositing** — multi-source overlay using `filter_complex` (all processing on the server, nothing in the browser)
- 📝 **Text overlays** — configurable font, size, colour, alignment, bold/italic, background opacity — rendered by FFmpeg `drawtext`
- 🖼 **Image / logo overlays** — composited by FFmpeg `overlay`
- 🔁 **Layer management** — drag and resize sources in the browser to set positions; server builds the FFmpeg layout
- 🔴 **RTMP & SRT output** — stream composed output to Twitch, YouTube, Kick, or any endpoint
- 📊 **Live stats** — frame count, FPS, and bitrate from FFmpeg relayed to the browser
- ⚡ **Real-time ingest monitoring** — browser shows which hardware encoders are actively connected

## Architecture

```
Hardware Encoder (Camera / GoPro / Encoder Box)
    │  RTMP push to rtmp://SERVER:1935/live/<key>
    ▼
Node.js Server  ──────────────────────────────────────────────────
│                                                                 │
│  node-media-server (RTMP ingest)    Express (Web UI + REST)    │
│           │                                │                    │
│           └──────────────┬─────────────────┘                    │
│                          ▼                                      │
│              FFmpeg filter_complex                              │
│              (compositing, overlays,                            │
│               H.264 encode)                                     │
│                          │                                      │
│                          ▼                                      │
│              RTMP / SRT output to                               │
│              Twitch / YouTube / etc.                            │
└─────────────────────────────────────────────────────────────────┘
         ▲ configure via browser (REST + WebSocket)
```

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 16 |
| FFmpeg | any recent version (must be on `$PATH`) |
| Browser | Chrome 88+ or Firefox 90+ (for the config UI only) |

### Installing FFmpeg

- **macOS**: `brew install ffmpeg`
- **Ubuntu/Debian**: `sudo apt install ffmpeg`
- **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH

## Setup

```bash
# 1. Clone and enter the repo
git clone https://github.com/ryan12324/Belabox-2.0.git
cd Belabox-2.0

# 2. Install Node.js dependencies
npm install

# 3. Start the server
npm start
# → Web UI: http://localhost:3000
# → RTMP ingest: rtmp://YOUR_SERVER_IP:1935/live/<stream-key>
```

Set custom ports with environment variables:

```bash
PORT=8080 RTMP_PORT=1936 npm start
```

## Usage

1. **Open** `http://localhost:3000` in a browser
2. Note the **RTMP ingest URL** shown in the Hardware Ingest panel on the left
3. **Configure your hardware encoder** (camera, GoPro, encoder box, OBS, etc.) to push to:
   ```
   rtmp://YOUR_SERVER_IP:1935/live/camera1
   ```
4. **Add sources** in Belabox via the **＋** button or toolbar:
   - **RTMP Ingest** — enter the same stream key you used above (e.g. `camera1`)
   - **SRT Input** — enter the SRT URL of your hardware device
   - **RTMP Pull** — Belabox pulls from an external RTMP stream
   - **Text** — text overlay rendered by FFmpeg `drawtext`
   - **Image** — logo / watermark composited by FFmpeg
5. **Arrange the scene** — drag sources in the canvas preview to position them; resize with handles. All positions configure the FFmpeg `filter_complex` layout
6. **Configure output** in the right sidebar: protocol, URL, stream key, bitrate
7. Click **▶ Go Live** — the server starts FFmpeg compositing and pushes to your streaming platform
8. Click **■ Stop** to end the stream

## Project Structure

```
Belabox-2.0/
├── server.js               Node.js server: RTMP ingest + REST API + FFmpeg compositor
├── package.json
├── public/
│   ├── index.html          Browser config UI shell
│   ├── css/
│   │   └── style.css       Dark theme UI
│   └── js/
│       ├── app.js          Main bootstrap & UI wiring
│       ├── scene-editor.js Canvas layout editor, drag/drop
│       ├── sources.js      Server-side RTMP/SRT source management
│       ├── overlays.js     Text & image overlay configuration
│       └── stream.js       WebSocket client, REST stream control
└── README.md
```

## License

MIT
