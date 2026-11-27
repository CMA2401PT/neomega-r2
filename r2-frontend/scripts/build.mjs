// 构建可由宿主提供材质的 UI 和播放器，WebSR 权重随代码分发。
import { build, transformSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { websrModels } from "./websr-models.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = join(root, "../r2-core");
const assetsRoot = join(root, "../assets-utils");
const coreDist = join(coreRoot, "dist");
const assetsDist = join(assetsRoot, "dist");
const dist = join(root, "dist");
const web = join(dist, "web");

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

const layoutHTML = readFileSync(join(root, "src/ui/layout/layout.html"), "utf8");
const materialControlsHTML = readFileSync(join(root, "src/ui/settings/material-controls.html"), "utf8");
const styleCSS = readFileSync(join(root, "src/ui/layout/style.css"), "utf8");

async function bundle(entry, { format = "esm", define = {}, globalName, externalDeps = false } = {}) {
  const result = await build({
    alias: externalDeps ? {} : {
      "neomega-r2-core": join(coreDist, "release/r2-core.js"),
      "neomega-r2-materials": join(assetsDist, "release/r2-materials.js"),
    },
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
            b.onResolve({ filter: /^neomega-r2-mc$/ }, () => ({ path: "./r2-mc.js", external: true }));
            b.onResolve({ filter: /^neomega-r2-core$/ }, () => ({ path: "./r2-core.js", external: true }));
            b.onResolve({ filter: /^neomega-r2-materials$/ }, () => ({ path: "./r2-materials.js", external: true }));
          },
        }]
      : [],
  });
  return result.outputFiles[0].text;
}

const sourceNotice = ["LICENSE", "../r2-mc/src/special-blocks/NOTICE.md", "../r2-mc/src/special-blocks/sign/UNIFONT-LICENSE.txt", "../r2-mc/src/items/THIRD_PARTY_NOTICES.txt"]
  .map(file => readFileSync(join(root,file),"utf8").trim()).join("\n\n");
mkdirSync(web, { recursive: true });
copyFileSync(join(root, "src/ui/layout/style.css"), join(web, "style.css"));

const webFrontend = await bundle("ui.js", {
  externalDeps: true,
  define: {
    R2_WEBSR_MODELS: JSON.stringify(websrModels),
    R2_LAYOUT_HTML: JSON.stringify(layoutHTML),
    R2_MATERIAL_CONTROLS: JSON.stringify(materialControlsHTML),
  },
});
writeFileSync(join(web, "r2-frontend.js"), `/*!\n${sourceNotice}\n\n${websrLicense}\n*/\n${webFrontend}`);

// 单文件播放器复用依赖包已经编好的着色器和 Worker。
const player = await bundle("ui/player/player.js", {
  format: "iife",
  globalName: "R2Player",
  define: {
    "import.meta.url": "document.baseURI",
    R2_WEBSR_MODELS: JSON.stringify(websrModels),
    R2_LAYOUT_HTML: JSON.stringify(layoutHTML),
    R2_MATERIAL_CONTROLS: JSON.stringify(materialControlsHTML),
  },
});

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styleCSS}</style><body>`;
const releaseFrontend = await bundle("index.js", {
  define: {
    R2_VIEW_HTML: JSON.stringify(html),
    R2_VIEW_SCRIPT: JSON.stringify(player),
  },
});

writeFileSync(join(dist, "index.js"), `/*!\n${sourceNotice}\n${websrLicense}\n*/\n${releaseFrontend}`);

// 编译引用 UI 的验证页面。
rmSync(join(root, "demo/dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, "-p", join(root, "demo")], { stdio: "inherit" });
