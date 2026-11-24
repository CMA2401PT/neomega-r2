// 三个 ESM 入口可以放在任意静态站点。代码、线程及着色器都以发布时的版本为准。
import { build } from "esbuild";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)),
  dist = join(root, "dist");
const text = (file) => readFileSync(join(dist, file), "utf8");
const archive = (name) => readFileSync(join(root, "../assets-utils", name)).toString("base64");
async function bundle(file, { format = "esm", define = {}, globalName } = {}) {
  const result = await build({
    entryPoints: [join(dist, file)],
    format,
    globalName,
    define,
    bundle: true,
    write: false,
    target: "es2022",
    charset: "utf8",
    minify: true,
    legalComments: "inline",
    plugins: [
      {
        name: "r2-host-path",
        setup(builder) {
          builder.onResolve({ filter: /^\/r2\// }, ({ path }) => ({ path: join(dist, path.slice(4)) }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}
const worker = await bundle("scene/worker.js", { format: "iife" });
const shaderFiles = readdirSync(join(dist, "render")).filter((name) => /\.(wgsl|frag)$/.test(name));
const engine = {
  R2_SHADERS: JSON.stringify(Object.fromEntries(shaderFiles.map((name) => [name, text("render/" + name)]))),
  R2_SCENE_WORKER: JSON.stringify(worker),
};
const material = {
  R2_MATERIAL_WORKER: JSON.stringify(await bundle("materials/worker.js", { format: "iife" })),
  R2_MATERIAL_INFO: JSON.stringify(archive("material-info.zip")),
  R2_MATERIAL_CONTROLS: JSON.stringify(readFileSync(join(root, "common_ui/material-controls.html"), "utf8")),
};
const layout = text("common_ui/layout.html")
  .replace('<slot name="actions"></slot>', "")
  .replace('<slot name="leading-actions"></slot>', "")
  .replace('<slot name="settings-extra"></slot>', '<div id="material-controls"></div>');
const html =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>' +
  text("common_ui/style.css") +
  "</style><body>" +
  layout;
// 在覆写目录版入口前完成所有内层打包，避免把同一个核心嵌入两次。
const player = await bundle("common_ui/player.js", {
  format: "iife",
  globalName: "R2Player",
  define: {
    ...engine,
    ...material,
    "import.meta.url": "document.baseURI",
    R2_DEFAULT_MATERIALS: JSON.stringify(archive("default-materials.zip")),
  },
});
const entries = await Promise.all([
  bundle("r2-core.js", { define: { ...engine, R2_MATERIAL_WORKER: material.R2_MATERIAL_WORKER } }),
  bundle("r2-frontend.js", {
    define: { R2_VIEW_HTML: JSON.stringify(html), R2_VIEW_SCRIPT: JSON.stringify(player) },
  }),
  bundle("r2-link.js"),
  bundle("common_ui/material-controls.js", { define: material }),
]);
// 单文件可以被独立复制，来源与许可声明也随对应入口一起分发。
const notice = (file) => readFileSync(join(root, file), "utf8").trim();
const sourceNotice = notice("LICENSE");
const libraryNotices = ["fflate", "fast-png", "iobuffer"].map((name) =>
  notice("node_modules/" + name + "/LICENSE"),
);
const assetNotice = notice("../assets-utils/sourceassets/THIRD_PARTY_NOTICES.txt");
const names = ["r2-core.js", "r2-frontend.js", "r2-link.js", "common_ui/material-controls.js"];
for (const [i, name] of names.entries()) {
  const licenses = [sourceNotice];
  if (name !== "r2-link.js") licenses.push(...libraryNotices);
  if (name === "r2-frontend.js" || name === "common_ui/material-controls.js") licenses.push(assetNotice);
  writeFileSync(join(dist, name), "/*!\n" + licenses.join("\n\n") + "\n*/\n" + entries[i]);
}

for (const name of ["default-materials.zip", "material-info.zip"])
  copyFileSync(join(root, "../assets-utils", name), join(dist, name));
copyFileSync(join(root, "examples/standalone.html"), join(dist, "standalone.html"));
