import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { EditableNetworkedDOM, LocalObservableDOMFactory } from "@mml-io/networked-dom-server";
import express from "express";
import { WebSocketServer } from "ws";

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, "..");

// --- Configuration -----------------------------------------------------------

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

// Public HTTPS base URL of this service (Railway sets RAILWAY_PUBLIC_DOMAIN).
const publicUrl = (
  process.env.PUBLIC_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${port}`)
).replace(/\/+$/, "");

// The HLS playlist URL injected into the MML document's m-video src.
const hlsPublicUrl = process.env.HLS_URL ?? `${publicUrl}/hls/live/index.m3u8`;

// Public RTMP ingest address shown on the front page (Railway TCP proxy host:port).
const rtmpPublicUrl = (process.env.RTMP_PUBLIC_URL ?? "rtmp://localhost:1935").replace(/\/+$/, "");

// Stream key required to publish. If empty, publishing is open (local dev).
const streamKey = process.env.STREAM_KEY ?? "";

const mmlWebSocketUrl = `${publicUrl.replace(/^http/, "ws")}/mml`;

const HLS_INTERNAL_HOST = "127.0.0.1";
const HLS_INTERNAL_PORT = 8888;

// Shared secret between the HLS proxy and MediaMTX. Sending it as a Bearer
// token marks the proxy as a "CDN", which disables MediaMTX's per-viewer HLS
// session system (cookie/302 redirects that break behind a path prefix).
const hlsCdnSecret = crypto.randomBytes(32).toString("hex");

// --- MediaMTX (RTMP ingest -> LL-HLS) ----------------------------------------

function resolveMediaMtxBinary() {
  const candidates = [process.env.MEDIAMTX_PATH, path.join(projectRoot, "bin", "mediamtx")];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

function buildMediaMtxConfig() {
  const template = fs.readFileSync(path.join(projectRoot, "mediamtx.yml"), "utf8");
  let publishUser;
  if (streamKey) {
    publishUser = [
      "  # Publishing requires the stream key as the password",
      "  - user: publisher",
      `    pass: ${JSON.stringify(streamKey)}`,
      "    ips: []",
      "    permissions:",
      "      - action: publish",
    ].join("\n");
  } else {
    console.warn(
      "[mediamtx] STREAM_KEY is not set - anyone who can reach the RTMP port can publish",
    );
    publishUser = [
      "  # No STREAM_KEY configured - publishing is open",
      "  - user: any",
      "    pass:",
      "    ips: []",
      "    permissions:",
      "      - action: publish",
    ].join("\n");
  }
  if (!template.includes("__PUBLISH_USER__") || !template.includes("__HLS_CDN_SECRET__")) {
    throw new Error("mediamtx.yml is missing a required placeholder");
  }
  return template
    .replace("__PUBLISH_USER__", publishUser)
    .replace("__HLS_CDN_SECRET__", hlsCdnSecret);
}

function startMediaMtx() {
  const binary = resolveMediaMtxBinary();
  if (!binary) {
    console.warn(
      "[mediamtx] binary not found (set MEDIAMTX_PATH or run `npm run fetch-mediamtx`) - " +
        "RTMP ingest and HLS output are disabled",
    );
    return;
  }
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mediamtx-")), "mediamtx.yml");
  fs.writeFileSync(configPath, buildMediaMtxConfig());
  console.log(`[mediamtx] starting ${binary}`);
  const child = spawn(binary, [configPath], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => {
    console.error(`[mediamtx] exited (code=${code}, signal=${signal}) - shutting down`);
    process.exit(code ?? 1);
  });
  const stopChild = () => child.kill("SIGTERM");
  process.on("SIGINT", () => {
    stopChild();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopChild();
    process.exit(0);
  });
}

startMediaMtx();

// --- Networked MML document ---------------------------------------------------

const mmlDocumentPath = path.join(projectRoot, "mml", "stream.html");
const networkedDocument = new EditableNetworkedDOM(
  url.pathToFileURL(mmlDocumentPath).toString(),
  LocalObservableDOMFactory,
);

function loadMmlDocument() {
  const contents = fs
    .readFileSync(mmlDocumentPath, "utf8")
    .replaceAll("{{HLS_URL}}", hlsPublicUrl);
  networkedDocument.load(contents);
}

loadMmlDocument();

// Watch the containing directory (editors often replace files atomically,
// which breaks watchers attached directly to the file).
let reloadTimer = null;
fs.watch(path.dirname(mmlDocumentPath), (eventType, filename) => {
  if (filename && filename !== path.basename(mmlDocumentPath)) {
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      loadMmlDocument();
      console.log("[mml] document reloaded");
    } catch (error) {
      console.error("[mml] failed to reload document", error);
    }
  }, 100);
});

// --- HTTP server ---------------------------------------------------------------

const app = express();
app.set("trust proxy", true);

// Reverse proxy /hls/* -> MediaMTX's HLS server. LL-HLS blocking playlist
// requests (_HLS_msn/_HLS_part query params) pass through untouched.
app.use("/hls", (req, res) => {
  const proxyReq = http.request(
    {
      host: HLS_INTERNAL_HOST,
      port: HLS_INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${HLS_INTERNAL_HOST}:${HLS_INTERNAL_PORT}`,
        authorization: `Bearer ${hlsCdnSecret}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({ error: "Stream server unavailable" });
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
  res.on("close", () => proxyReq.destroy());
});

// Connection info consumed by the front page.
app.get("/api/info", (req, res) => {
  res.json({
    hlsUrl: hlsPublicUrl,
    mmlWebSocketUrl,
    obsServer: rtmpPublicUrl,
    obsStreamKey: streamKey ? "live?user=publisher&pass=<STREAM_KEY>" : "live",
    streamKeyConfigured: streamKey.length > 0,
  });
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(projectRoot, "public")));

const server = http.createServer(app);

// WebSocket endpoint serving the networked MML document.
const webSocketServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/mml" || pathname === "/mml/") {
    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      networkedDocument.addWebSocket(ws);
      ws.on("close", () => {
        networkedDocument.removeWebSocket(ws);
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log(`[server] listening on port ${port}`);
  console.log(`[server] front page:            ${publicUrl}/`);
  console.log(`[server] networked MML document: ${mmlWebSocketUrl}`);
  console.log(`[server] HLS playlist:           ${hlsPublicUrl}`);
  console.log(`[server] RTMP ingest:            ${rtmpPublicUrl}/live`);
});
