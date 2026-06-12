# MML + LL-HLS Live Stream Service

A single mini-service that:

1. Receives a live stream from **OBS** via RTMP ([MediaMTX](https://github.com/bluenviron/mediamtx))
2. Serves it as **Low-Latency HLS** (`.m3u8`)
3. Serves a **networked MML document** over WebSocket containing an `<m-video>` that plays the stream — ready to plug into Otherside or any MML-compatible world
4. Serves a minimal front page with OBS setup instructions

```
OBS ──RTMP──▶ MediaMTX ──LL-HLS──▶ Node (Express)
                                     ├── /                  front page (OBS instructions)
                                     ├── /hls/live/index.m3u8   HLS playlist (proxied)
                                     └── /mml               networked MML document (WebSocket)
```

The MML document ([mml/stream.html](mml/stream.html)) is run server-side with
`@mml-io/networked-dom-server` and synchronized to all connected clients, so everyone
in the world sees the same state:

```html
<m-video src="{{HLS_URL}}" y="1.856" sx="3" sy="3" sz="3"></m-video>
```

`{{HLS_URL}}` is replaced at load time with the public HLS playlist URL. The stream is
remuxed, not transcoded — resolution and bitrate are controlled entirely by OBS settings.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` / `HTTP_PORT` | no (default `8080`) | HTTP port. If Railway sets `PORT=1935` (it does this after you add the TCP proxy), the server ignores it and uses `8080` — set `HTTP_PORT` to override explicitly. |
| `PUBLIC_URL` | no | Public HTTPS base URL of the service. Defaults to `https://$RAILWAY_PUBLIC_DOMAIN` on Railway, `http://localhost:8080` locally. |
| `RTMP_PUBLIC_URL` | yes (on Railway) | Public RTMP ingest address shown on the front page, e.g. `rtmp://shuttle.proxy.rlwy.net:34521` (the Railway TCP proxy endpoint). |
| `STREAM_KEY` | recommended | Password required to publish. If unset, anyone who can reach the RTMP port can stream. |
| `HLS_URL` | no | Override the HLS URL injected into the `m-video` (defaults to `$PUBLIC_URL/hls/live/index.m3u8`). |
| `MEDIAMTX_PATH` | no | Path to the MediaMTX binary (set automatically in the Docker image). |

## Deploying to Railway

1. Create a new Railway service from this repo. Railway detects the `Dockerfile` automatically.
2. In **Settings → Networking**:
   - **Generate a domain** targeting port `8080` (gives you `https://<app>.up.railway.app`).
   - **Add a TCP Proxy** targeting internal port `1935`. Railway gives you a host and port,
     e.g. `shuttle.proxy.rlwy.net:34521` — this is your RTMP ingest address.
   - Adding the TCP proxy can flip the service's injected `PORT` variable to `1935`,
     which would collide with the RTMP listener. The server detects this and falls back
     to `8080` for HTTP — just make sure the **domain targets port 8080**.
3. In **Variables**, set:
   - `STREAM_KEY` — pick a long random secret
   - `RTMP_PUBLIC_URL` — `rtmp://<tcp-proxy-host>:<tcp-proxy-port>` from step 2
4. Deploy. Open the service domain for the front page with the exact OBS values.

### Resulting URLs

| What | URL |
| --- | --- |
| Networked MML document | `wss://<app>.up.railway.app/mml` ← add this to Otherside |
| HLS playlist | `https://<app>.up.railway.app/hls/live/index.m3u8` |
| Front page | `https://<app>.up.railway.app/` |

## OBS setup

In **Settings → Stream**:

- **Service**: Custom…
- **Server**: `rtmp://<tcp-proxy-host>:<tcp-proxy-port>` (shown on the front page)
- **Stream Key**: `live?user=publisher&pass=<STREAM_KEY>` (just `live` if no key is configured)

In **Settings → Output** (recommended "average" quality):

- Rate control **CBR**, bitrate **3000–4000 kbps**
- **Keyframe interval: 2 s** (important — HLS latency is bounded by the keyframe interval)
- Preset veryfast, tune `zerolatency`
- 1280×720 or 1920×1080 @ 30 fps, AAC audio 128 kbps

## Local development

```bash
npm ci
npm run fetch-mediamtx   # downloads the MediaMTX binary to ./bin (macOS/Linux)
npm start
```

Then:

- Front page: `http://localhost:8080/`
- Stream from OBS to server `rtmp://localhost:1935` with stream key `live`
  (or test with ffmpeg:
  `ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine -c:v libx264 -preset veryfast -g 60 -c:a aac -f flv rtmp://localhost:1935/live`)
- HLS playlist: `http://localhost:8080/hls/live/index.m3u8`
- Networked MML document: `ws://localhost:8080/mml`

Edits to `mml/stream.html` hot-reload for all connected clients.

## Notes

- MediaMTX is configured in [mediamtx.yml](mediamtx.yml) with `hlsVariant: lowLatency`
  (LL-HLS with 200 ms parts) and `hlsAlwaysRemux` so the playlist is available as soon
  as OBS connects. Expect roughly 2–5 s of glass-to-glass latency.
- HLS playback is intentionally public (Otherside clients fetch it anonymously);
  publishing is protected by `STREAM_KEY`.
