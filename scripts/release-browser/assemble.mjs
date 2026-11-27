// 从各包自己的构建产物组装 Go 宿主的网页或附带材质的独立播放器。
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [mode, output, materials] = process.argv.slice(2);
if (!output || !["web", "standalone"].includes(mode) || (mode === "standalone" && !materials)) {
  throw Error("用法：node assemble.mjs web 输出目录 或 standalone 输出目录 材质目录");
}
const out = resolve(output);
mkdirSync(out, { recursive: true });
for (const [pkg, name] of [["r2-core", "r2-core.js"], ["r2-link", "r2-link.js"], ["assets-utils", "r2-materials.js"]]) {
  copyFileSync(join(root, pkg, "dist/release", name), join(out, name));
}
const frontend = join(root, "r2-frontend");
if (mode === "web") {
  for (const name of ["r2-frontend.js", "style.css"]) copyFileSync(join(frontend, "dist/web", name), join(out, name));
} else {
  const assets = resolve(materials);
  for (const name of ["default-materials.zip", "material-info.zip", "THIRD_PARTY_NOTICES.txt"]) {
    copyFileSync(join(assets, name), join(out, name));
  }
  await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "player.mjs")],
    bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "inline",
    outfile: join(out, "r2-frontend.js"),
    banner: { js: "/*!\n" + readFileSync(join(assets, "THIRD_PARTY_NOTICES.txt"), "utf8") + "\n*/" },
    define: {
      DEFAULT_PACK: JSON.stringify(readFileSync(join(assets, "default-materials.zip")).toString("base64")),
      MATERIAL_RECIPE: JSON.stringify(readFileSync(join(assets, "material-info.zip")).toString("base64")),
    },
  });
  copyFileSync(join(root, "r2-core/examples/color-depth.html"), join(out, "color-depth.html"));
  for (const name of ["standalone.html", "datasource.html"]) {
    copyFileSync(join(frontend, "examples", name), join(out, name));
  }
}
