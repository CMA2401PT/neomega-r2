// 从各包自己的构建产物组装 Go 宿主的网页或附带材质的独立播放器。
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [mode, output, materials] = process.argv.slice(2);
if (!output || !["web", "standalone"].includes(mode) || (mode === "standalone" && !materials)) {
  throw Error("用法：node assemble.mjs web 输出目录 或 standalone 输出目录 材质目录");
}
const out = resolve(output);
mkdirSync(out, { recursive: true });
for (const [pkg, name] of [["r2-core", "r2-core.js"], ["r2-link", "r2-link.js"], ["r2-mc", "r2-mc.js"], ["assets-utils", "r2-materials.js"]]) {
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
  // 仓库中的示例直接加载 COS。发布包中的同一页改用同目录的模块和材质。
  const examples = join(root, "examples");
  for (const name of readdirSync(examples).filter(name => name.endsWith(".html"))) {
    const html = readFileSync(join(examples, name), "utf8");
    writeFileSync(join(out, name), html.replaceAll("https://omega-1259160345.cos.accelerate.myqcloud.com/r2/", "./"));
  }
}
