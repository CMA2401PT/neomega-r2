// 独立提供指定提交的纯色 brickmap；不修改旧 viewer 或 R2 的运行源码。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
const here = path.dirname(fileURLToPath(import.meta.url));
const [binary, world, commit = "fcdaeae"] = process.argv.slice(2);
if (!binary || !world)
  throw Error(
    "用法：node serve-baseline.mjs <旧 viewer 二进制> <存档> [core 提交]",
  );
const root = path.resolve(here, "../.."),
  directory = fs.mkdtempSync("/tmp/r2-baseline-");
fs.mkdirSync(path.join(directory, "core"));
for (const name of [
  "gpu.ts",
  "renderer.ts",
  "shaders.ts",
  "volume.ts",
  "coverage.ts",
]) {
  const source = execFileSync("git", [
    "-C",
    path.join(root, "neomega-viewer-core"),
    "show",
    `${commit}:viewer/brickmap/web/${name}`,
  ]);
  fs.writeFileSync(path.join(directory, "core", name), source);
}
fs.copyFileSync(
  path.join(here, "baseline.ts"),
  path.join(directory, "baseline.ts"),
);
execFileSync(
  "npx",
  [
    "--yes",
    "esbuild@0.25.12",
    path.join(directory, "baseline.ts"),
    "--bundle",
    "--format=esm",
    `--outfile=${directory}/main.js`,
  ],
  { stdio: "inherit" },
);
const log = fs.openSync(path.join(directory, "server.log"), "w");
const backend = spawn(
  binary,
  ["-browser=false", "-listen", "127.0.0.1:2423", "-world", world],
  {
    env: { ...process.env, NEOMEGA_BRICKMAP_TEXTURES: "0" },
    stdio: ["ignore", log, log],
  },
);
const server = http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      const result = await fetch("http://127.0.0.1:2423" + req.url);
      res.writeHead(result.status, {
        "content-type": result.headers.get("content-type"),
      });
      res.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (req.url === "/main.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(fs.readFileSync(path.join(directory, "main.js")));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      '<html><link rel="icon" href="data:,"><style>body{margin:0}canvas{width:100vw;height:100vh;display:block}</style><canvas></canvas><script type="module" src="/main.js"></script></html>',
    );
  })
  .listen(2424, "127.0.0.1", () =>
    console.log("旧版基准：http://127.0.0.1:2424；日志：" + directory),
  );
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    backend.kill("SIGTERM");
  });
