import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream";
import { resolve, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { gzipAsset } from "./gzip-asset.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [dist, address = "127.0.0.1:2415"] = process.argv.slice(2);
if (!dist) throw Error("请传入发布目录（包含 web 和 standalone）");
const release = join(resolve(dist), "standalone");
const defaultAssets = new AdmZip(join(release, "default-materials.zip"));
const mounts = [
  ["/r2/", [join(resolve(dist), "web"), release]],
  ["/release/", [release]],
  ["/", [join(root, "r2-frontend/demo")]],
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
const [host, port] = address.split(":");
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
