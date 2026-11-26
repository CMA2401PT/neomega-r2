// 编译 r2-link TS 并在 dist/release/ 生成单文件浏览器入口 r2-link.js。
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const release = join(dist, "release");
const require = createRequire(import.meta.url);
const tscBin = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, "-p", root], { stdio: "inherit" });

const result = await build({
  entryPoints: [join(dist, "index.js")],
  format: "esm",
  bundle: true,
  write: false,
  target: "es2022",
  charset: "utf8",
  minify: true,
  legalComments: "inline",
});

const sourceNotice = readFileSync(join(root, "LICENSE"), "utf8").trim();
mkdirSync(release, { recursive: true });
writeFileSync(join(release, "r2-link.js"), `/*!\n${sourceNotice}\n*/\n${result.outputFiles[0].text}`);
