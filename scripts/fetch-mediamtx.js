// Downloads the MediaMTX binary for the current platform into ./bin/mediamtx
// (used for local development; the Docker image copies the binary instead).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const VERSION = "v1.19.1";

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const binDir = path.resolve(dirname, "..", "bin");
const binaryPath = path.join(binDir, "mediamtx");

if (fs.existsSync(binaryPath)) {
  console.log(`MediaMTX already present at ${binaryPath}`);
  process.exit(0);
}

const osName = { darwin: "darwin", linux: "linux" }[process.platform];
const arch = { arm64: "arm64", x64: "amd64" }[process.arch];
if (!osName || !arch) {
  console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
  process.exit(1);
}

const archiveUrl = `https://github.com/bluenviron/mediamtx/releases/download/${VERSION}/mediamtx_${VERSION}_${osName}_${arch}.tar.gz`;
const archivePath = path.join(binDir, "mediamtx.tar.gz");

fs.mkdirSync(binDir, { recursive: true });
console.log(`Downloading ${archiveUrl}`);

const response = await fetch(archiveUrl, { redirect: "follow" });
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

execFileSync("tar", ["-xzf", archivePath, "-C", binDir, "mediamtx"]);
fs.chmodSync(binaryPath, 0o755);
fs.rmSync(archivePath);

console.log(`MediaMTX ${VERSION} installed at ${binaryPath}`);
