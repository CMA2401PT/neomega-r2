// 编译 r2-frontend TS，生成精简的 Go 嵌入目录 dist/web/、独立单文件 dist/release/r2-frontend.js 及 demo/dist/。
import { build, transformSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { websrModels } from "./websr-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = join(root, "../r2-core");
const linkRoot = join(root, "../r2-link");
const assetsRoot = join(root, "../assets-utils");
const coreDist = join(coreRoot, "dist");
const linkDist = join(linkRoot, "dist");
const assetsDist = join(assetsRoot, "dist");
const dist = join(root, "dist");
const web = join(dist, "web");
const release = join(dist, "release");
const require = createRequire(import.meta.url);
const tscBin = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, "-p", root], { stdio: "inherit" });

// 为工作区 ESM 引用直接注入 WebSR 权重，保持源码独立运行能力。
const srModule = join(dist, "compositor/websr.js");
const websrLicense = readFileSync(join(root, "vendor/websr/LICENSE"), "utf8").trim();
const sr = transformSync(readFileSync(join(root, "src/compositor/websr.ts"), "utf8"), {
  loader: "ts",
  target: "es2023",
  define: { R2_WEBSR_MODELS: JSON.stringify(websrModels) },
  banner: "/*! WebSR\n" + websrLicense + "\n*/",
  charset: "utf8",
  sourcemap: "external",
  sourcesContent: false,
  sourcefile: "../../src/compositor/websr.ts",
});
writeFileSync(srModule, sr.code + "//# sourceMappingURL=websr.js.map\n");
writeFileSync(srModule + ".map", sr.map);

const layoutHTML = readFileSync(join(root, "src/ui/layout.html"), "utf8");
const materialControlsHTML = readFileSync(join(root, "src/ui/material-controls.html"), "utf8");
const styleCSS = readFileSync(join(root, "src/ui/style.css"), "utf8");

async function bundle(entry, { format = "esm", define = {}, globalName, externalDeps = false } = {}) {
  const result = await build({
    entryPoints: [join(dist, entry)],
    format,
    globalName,
    define,
    bundle: true,
    write: false,
    target: "es2022",
    charset: "utf8",
    minify: true,
    legalComments: "inline",
    plugins: externalDeps
      ? [{
          name: "external-r2-deps",
          setup(b) {
            b.onResolve({ filter: /^neomega-r2-core$/ }, () => ({ path: "./r2-core.js", external: true }));
            b.onResolve({ filter: /^neomega-r2-materials$/ }, () => ({ path: "./r2-materials.js", external: true }));
          },
        }]
      : [],
  });
  return result.outputFiles[0].text;
}

const notice = (file) => readFileSync(file, "utf8").trim();
const depLicense = (name) => {
  for (const base of [join(root, "node_modules"), join(root, "../node_modules")]) {
    const file = join(base, name, "LICENSE");
    if (existsSync(file)) return notice(file);
  }
  throw Error("找不到依赖许可证：" + name);
};
const sourceNotice = notice(join(root, "LICENSE"));
const materialLibraryNotices = ["fflate", "fast-png", "iobuffer"].map(depLicense);
const assetNotice = notice(join(assetsRoot, "sourceassets/THIRD_PARTY_NOTICES.txt"));
const archive = (name) => readFileSync(join(assetsRoot, name)).toString("base64");

// 1. 精简 Go 嵌入目录 dist/web/：r2-frontend.js 外链 ./r2-core.js 与 ./r2-materials.js，不重复打包依赖。
mkdirSync(web, { recursive: true });
copyFileSync(join(coreDist, "release/r2-core.js"), join(web, "r2-core.js"));
copyFileSync(join(linkDist, "release/r2-link.js"), join(web, "r2-link.js"));
copyFileSync(join(assetsDist, "release/r2-materials.js"), join(web, "r2-materials.js"));
copyFileSync(join(root, "src/ui/style.css"), join(web, "style.css"));
copyFileSync(join(assetsRoot, "material-info.zip"), join(web, "material-info.zip"));

const webFrontend = await bundle("ui.js", {
  externalDeps: true,
  define: {
    R2_WEBSR_MODELS: JSON.stringify(websrModels),
    R2_LAYOUT_HTML: JSON.stringify(layoutHTML),
    R2_MATERIAL_CONTROLS: JSON.stringify(materialControlsHTML),
  },
});
writeFileSync(join(web, "r2-frontend.js"), `/*!\n${sourceNotice}\n\n${websrLicense}\n*/\n${webFrontend}`);

// 2. 独立单文件 COS 分发入口 dist/release/r2-frontend.js（自包含默认材质与着色器）。
const shaderFiles = readdirSync(join(coreDist, "render")).filter((name) => name.endsWith(".wgsl"));
const shaders = Object.fromEntries(shaderFiles.map((name) => [name, readFileSync(join(coreDist, "render", name), "utf8")]));
const sceneWorker = (await build({
  entryPoints: [join(coreDist, "scene/worker.js")],
  format: "iife",
  bundle: true,
  write: false,
  target: "es2022",
  minify: true,
})).outputFiles[0].text;
const materialWorker = (await build({
  entryPoints: [join(assetsDist, "worker.js")],
  format: "iife",
  bundle: true,
  write: false,
  target: "es2022",
  minify: true,
})).outputFiles[0].text;

const player = await bundle("ui/player.js", {
  format: "iife",
  globalName: "R2Player",
  define: {
    "import.meta.url": "document.baseURI",
    R2_SHADERS: JSON.stringify(shaders),
    R2_SCENE_WORKER: JSON.stringify(sceneWorker),
    R2_MATERIAL_WORKER: JSON.stringify(materialWorker),
    R2_WEBSR_MODELS: JSON.stringify(websrModels),
    R2_LAYOUT_HTML: JSON.stringify(layoutHTML),
    R2_MATERIAL_CONTROLS: JSON.stringify(materialControlsHTML),
    R2_MATERIAL_INFO: JSON.stringify(archive("material-info.zip")),
    R2_DEFAULT_MATERIALS: JSON.stringify(archive("default-materials.zip")),
  },
});

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styleCSS}</style><body>`;
const releaseFrontend = await bundle("index.js", {
  define: {
    R2_VIEW_HTML: JSON.stringify(html),
    R2_VIEW_SCRIPT: JSON.stringify(player),
  },
});

mkdirSync(release, { recursive: true });
writeFileSync(
  join(release, "r2-frontend.js"),
  `/*!\n${[sourceNotice, ...materialLibraryNotices, websrLicense, assetNotice].join("\n\n")}\n*/\n${releaseFrontend}`,
);
for (const name of ["standalone.html", "datasource.html"]) {
  copyFileSync(join(root, "examples", name), join(release, name));
}

// 3. 编译演示页面 demo/
rmSync(join(root, "demo/dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, "-p", join(root, "demo")], { stdio: "inherit" });
