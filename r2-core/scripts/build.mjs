// 编译核心 TS 与 WGSL 着色器；并在 dist/release/ 生成单文件浏览器发布入口 r2-core.js（不覆写 dist/ 目录版 ESM）。
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
execFileSync(process.execPath, [join(root, "shaders/convert.cjs")], { stdio: "inherit" });

async function bundle(entry, { format = "esm", define = {} } = {}) {
  const result = await build({
    entryPoints: [join(dist, entry)],
    format,
    define,
    bundle: true,
    write: false,
    target: "es2022",
    charset: "utf8",
    minify: true,
    legalComments: "inline",
  });
  return result.outputFiles[0].text;
}

const sceneWorker = await bundle("scene/worker.js", { format: "iife" });
const shaderFiles = readdirSync(join(dist, "render")).filter((name) => name.endsWith(".wgsl"));
const shaders = Object.fromEntries(shaderFiles.map((name) => [name, readFileSync(join(dist, "render", name), "utf8")]));

const coreBundle = await bundle("index.js", {
  define: {
    R2_SHADERS: JSON.stringify(shaders),
    R2_SCENE_WORKER: JSON.stringify(sceneWorker),
  },
});

const sourceNotice = readFileSync(join(root, "LICENSE"), "utf8").trim();
mkdirSync(release, { recursive: true });
writeFileSync(join(release, "r2-core.js"), `/*!\n${sourceNotice}\n*/\n${coreBundle}`);
// 随核心分发的示例读取同目录的核心、材质工具和默认材质包。
const example = readFileSync(join(root, "../examples/color-depth.html"), "utf8");
writeFileSync(join(release, "color-depth.html"), example.replaceAll("https://omega-1259160345.cos.accelerate.myqcloud.com/r2/", "./"));
