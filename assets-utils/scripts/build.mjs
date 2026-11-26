// 编译材质工具 TS 并在 dist/release/ 生成单文件浏览器入口 r2-materials.js。
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const materialWorker = (await build({
  entryPoints: [join(dist, "worker.js")],
  format: "iife",
  bundle: true,
  write: false,
  target: "es2022",
  charset: "utf8",
  minify: true,
  legalComments: "inline",
})).outputFiles[0].text;

const materialsBundle = (await build({
  entryPoints: [join(dist, "index.js")],
  format: "esm",
  bundle: true,
  write: false,
  target: "es2022",
  charset: "utf8",
  minify: true,
  legalComments: "inline",
  define: {
    R2_MATERIAL_WORKER: JSON.stringify(materialWorker),
  },
})).outputFiles[0].text;

const notice = (file) => readFileSync(file, "utf8").trim();
const depLicense = (name) => {
  for (const base of [join(root, "node_modules"), join(root, "../node_modules")]) {
    const file = join(base, name, "LICENSE");
    if (existsSync(file)) return notice(file);
  }
  throw Error("找不到依赖许可证：" + name);
};
const sourceNotice = notice(join(root, "LICENSE"));
const libraryNotices = ["fflate", "fast-png", "iobuffer"].map(depLicense);

mkdirSync(release, { recursive: true });
writeFileSync(
  join(release, "r2-materials.js"),
  `/*!\n${[sourceNotice, ...libraryNotices].join("\n\n")}\n*/\n${materialsBundle}`,
);
