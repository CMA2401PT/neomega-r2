// 编译 r2-mc TS 并在 dist/release/ 生成单文件浏览器入口 r2-mc.js。
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

// 固定素材与实现一起交付，目录版、在线查看器和单文件播放器共用相同的图片。
for (const directory of ["special-blocks/book", "special-blocks/pot", "special-blocks/banner", "special-blocks/sign", "entities/item-frame", "items"]) {
  await build({
    entryPoints: [join(root, "src", directory, "assets.ts")],
    outfile: join(dist, directory, "assets.js"),
    bundle: true,
    format: "esm",
    loader: { ".png": "dataurl", ".gz": "dataurl" },
  });
}

const result = await build({
  entryPoints: [join(dist, "index.js")],
  format: "esm",
  bundle: true,
  plugins: [{
    name: "core-browser-entry",
    setup(b) {
      b.onResolve({ filter: /^neomega-r2-core$/ }, () => ({ path: "./r2-core.js", external: true }));
    },
  }],
  write: false,
  target: "es2022",
  charset: "utf8",
  minify: true,
  legalComments: "inline",
});

const sourceNotice = ["LICENSE", "src/special-blocks/NOTICE.md", "src/special-blocks/sign/UNIFONT-LICENSE.txt", "src/items/THIRD_PARTY_NOTICES.txt"]
  .map(file => readFileSync(join(root, file), "utf8").trim()).join("\n\n");
mkdirSync(release, { recursive: true });
writeFileSync(join(release, "r2-mc.js"), `/*!\n${sourceNotice}\n*/\n${result.outputFiles[0].text}`);
