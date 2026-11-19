// 验证页的静态文件服务：/ 是 demo，/r2/ 是核心的 dist，/assets/ 是 assets-utils 的默认资源包。
// 用法：node scripts/serve.mjs [地址]，默认 127.0.0.1:2415；先运行 npm run build。
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream";
import { defaultAssets, gzipAsset } from "./default-assets.mjs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mounts = [
  ["/r2/", join(root, "dist")],
  ["/", join(root, "demo")],
];
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".frag": "text/plain; charset=utf-8",
  ".map": "application/json",
};
const [host, port] = (process.argv[2] || "127.0.0.1:2415").split(":");
createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  if (path.startsWith("/assets/")) {
    const entry = defaultAssets.getEntry(path.slice(1));
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    const encodings = (request.headers["accept-encoding"] ?? "").toLowerCase().split(",").map(value => value.trim().split(/\s*;\s*/));
    const encoding = encodings.find(([name]) => name === "gzip") ?? encodings.find(([name]) => name === "*");
    const gzip = encoding && (encoding.length === 1 || Number(encoding[1].replace(/^q=/, "")) > 0);
    response.writeHead(200, {
      "Content-Type": types[extname(path)] || "application/octet-stream",
      "Content-Length": gzip ? entry.header.compressedSize + 18 : entry.header.size,
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    });
    if (request.method === "HEAD") return response.end();
    return response.end(gzip ? gzipAsset(entry) : entry.getData());
  }
  const [prefix, dir] = mounts.find(([prefix]) => path.startsWith(prefix));
  const file = normalize(join(dir, path.slice(prefix.length) || "index.html"));
  let size = -1;
  try {
    if (file.startsWith(dir + sep) || file === dir) size = statSync(file).isFile() ? statSync(file).size : -1;
  } catch {}
  if (size < 0) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") return response.end();
  pipeline(createReadStream(file), response, () => {});
}).listen(Number(port), host, () => console.log(`R2 验证页：http://${host}:${port}`));
