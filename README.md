# Belabox 2.0 — Web-Based Streaming Studio

A web-based OBS-like streaming studio for **RTMP** and **SRT** streams, with easy overlay editing, multi-source support, and a drag-and-drop scene editor — all in your browser.

## Features

- 🎬 **Live scene editor** — drag, resize, and reorder sources on a real-time canvas preview
- 📷 **Multiple cameras** — add as many webcams as your system has available
- 🖥 **Screen / window capture** — capture your entire screen or a specific application window
- 📝 **Text overlays** — configurable font, size, colour, alignment, and background
- 🖼 **Image / logo overlays** — load from a URL or upload a local file
- 🔁 **Layer management** — reorder layers, toggle visibility, adjust opacity
- 🔴 **RTMP & SRT output** — stream to Twitch, YouTube, Kick, or any RTMP/SRT endpoint
- 📊 **Live stream stats** — frame count, FPS, and bitrate from FFmpeg
- ⚡ **Low-latency pipeline** — browser captures → WebSocket → FFmpeg → RTMP/SRT

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 16 |
| FFmpeg | any recent version (must be on `$PATH`) |
| Browser | Chrome 88+ or Firefox 90+ |

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
# → http://localhost:3000
```

Set a custom port with the `PORT` environment variable:

```bash
PORT=8080 npm start
```

## Usage

1. **Open** `http://localhost:3000` in Chrome or Firefox
2. **Add sources** using the toolbar or the **＋** button in the Sources panel:
   - **Camera** — grants webcam access and adds it full-screen
   - **Screen** — opens the browser screen-picker
   - **Text** — adds a configurable text overlay (double-click on canvas to edit inline)
   - **Image** — paste a URL or upload a file
3. **Arrange layers** — drag sources on the canvas to position them; drag the corner handles to resize
4. **Edit properties** — select any layer to configure it in the right-hand Properties panel
5. **Configure stream** in the right sidebar:
   - Choose **RTMP** or **SRT** protocol
   - Enter your stream URL (e.g. `rtmp://live.twitch.tv/app`)
   - Enter your stream key
   - Set video/audio bitrate and output resolution
6. Click **▶ Go Live** — the browser encodes video and sends it to the server where FFmpeg pushes it to your endpoint
7. Click **■ Stop** to end the stream

## Architecture

```
Browser                          Node.js Server
─────────────────────            ──────────────────────────────
getUserMedia / getDisplayMedia   Express (serves static files)
         ↓                              ↓
Canvas compositor (2D API)       WebSocket server (ws)
         ↓                              ↓
MediaRecorder (WebM/VP8)         FFmpeg child process
         ↓  ←── WebSocket ──────→      ↓
Binary chunks streamed           libx264 encode
                                        ↓
                                 RTMP / SRT output
```

## Project Structure

```
Belabox-2.0/
├── server.js               Node.js WebSocket + HTTP server
├── package.json
├── public/
│   ├── index.html          Application shell
│   ├── css/
│   │   └── style.css       Dark theme UI
│   └── js/
│       ├── app.js          Main bootstrap & UI wiring
│       ├── scene-editor.js Canvas compositor, drag/drop
│       ├── sources.js      Camera & screen capture
│       ├── overlays.js     Text & image overlays
│       └── stream.js       WebSocket, MediaRecorder, stats
└── README.md
```

## License

MIT
