// 编译 TS 并生成 WGSL 着色器；dist 的目录结构与 src 相同，着色器按 import.meta.url 相对路径加载。
// 同时分发可选的共享查看界面，再编译验证页 demo/，它按 dist 的类型声明检查对核心的使用。
import { transformSync } from "esbuild";
import { websrModels } from "./websr-models.mjs";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src"),
  dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", root], {
  stdio: "inherit",
});
// 目录版、单文件入口和离线播放器都从这个模块取得权重，使用时无需联网。
const srModule = join(dist, "render/websr.js");
const license = readFileSync(join(root, "vendor/websr/LICENSE"), "utf8");
const sr = transformSync(readFileSync(join(src, "render/websr.ts"), "utf8"), {
  loader: "ts", target: "es2023",
  define: { R2_WEBSR_MODELS: JSON.stringify(websrModels) },
  banner: "/*! WebSR\n" + license + "*/",
  charset: "utf8",
  sourcemap: "external",
  sourcesContent: false,
  sourcefile: "../../src/render/websr.ts",
});
writeFileSync(srModule, sr.code + "//# sourceMappingURL=websr.js.map\n");
writeFileSync(srModule + ".map", sr.map);
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "common_ui")], { stdio: "inherit" });
execFileSync(process.execPath, [join(root, "shaders/convert.cjs")], { stdio: "inherit" });
for (const name of ["layout.html", "style.css"]) cpSync(join(root, "common_ui", name), join(dist, "common_ui", name));
rmSync(join(root, "demo/dist"), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "demo")], {
  stdio: "inherit",
});

await import("./release.mjs");
