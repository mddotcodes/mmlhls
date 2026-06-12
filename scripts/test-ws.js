// Quick verification that the networked MML document is served over WebSocket.
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:8080/mml", "networked-dom-v0.1");
const timeout = setTimeout(() => {
  console.error("TIMEOUT: no snapshot received");
  process.exit(1);
}, 5000);

ws.on("open", () => console.log("connected, negotiated protocol:", ws.protocol));
ws.on("message", (data) => {
  const text = data.toString();
  console.log("received:", text.slice(0, 400));
  if (text.toLowerCase().includes("m-video")) {
    console.log("OK: snapshot contains m-video element");
    clearTimeout(timeout);
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (error) => {
  console.error("WS error:", error.message);
  process.exit(1);
});
