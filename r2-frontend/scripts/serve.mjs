// 验证页的静态文件服务：
// / -> r2-frontend/demo/
// /r2/ -> r2-frontend/dist/web/（与 Viewer 的 Go embed 目录一致）
// /release/ -> 合并 r2-core/dist/release/ 与 r2-frontend/dist/release/（独立 HTML 示例）
// /assets/ -> assets-utils/default-materials.zip
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAssets, gzipAsset } from "../../assets-utils/scripts/default-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mounts = [
  ["/r2/", [join(root, "dist/web")]],
  [
    "/release/",
    [
      join(root, "dist/release"),
      join(root, "../r2-core/dist/release"),
      join(root, "../r2-link/dist/release"),
      join(root, "../assets-utils/dist/release"),
      join(root, "../assets-utils"),
    ],
  ],
  ["/", [join(root, "demo")]],
];
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".zip": "application/zip",
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
    const encodings = (request.headers["accept-encoding"] ?? "").toLowerCase().split(",").map((value) => value.trim().split(/\s*;\s*/));
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
  const [prefix, dirs] = mounts.find(([p]) => path.startsWith(p));
  const rel = path.slice(prefix.length) || "index.html";
  let file = "";
  let size = -1;
  for (const dir of dirs) {
    const candidate = normalize(join(dir, rel));
    if (!(candidate.startsWith(dir + sep) || candidate === dir)) continue;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        file = candidate;
        size = statSync(candidate).size;
        break;
      }
    } catch {}
  }
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
