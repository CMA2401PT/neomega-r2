// 验证页的静态文件服务：/ 是 demo，/r2/ 是核心的 dist，/assets/ 是 assets-utils 的默认资源包。
// 用法：node scripts/serve.mjs [地址]，默认 127.0.0.1:2415；先运行 npm run build。
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mounts = [
  ["/r2/", join(root, "dist")],
  ["/assets/", join(root, "../assets-utils/assets")],
  ["/", join(root, "demo")],
];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".frag": "text/plain; charset=utf-8",
  ".map": "application/json",
};
const [host, port] = (process.argv[2] || "127.0.0.1:2415").split(":");
createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
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
  createReadStream(file).pipe(response);
}).listen(Number(port), host, () => console.log(`R2 验证页：http://${host}:${port}`));
