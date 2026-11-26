// 从 Go 生成的几何基表制作两个独立归档；默认贴图与浏览器使用同一份 TS 合成代码。
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { buildTextures } from "../src/build.ts";
const folder = process.argv[2];
const read = (name) => new Uint8Array(readFileSync(join(folder, name)));
const recipe = Object.fromEntries(
  ["textures.json", "base-atlas.png", "base-catalog.json", "base-fast.bin", "base-quad-records.bin"].map(
    (name) => [name, read(name)],
  ),
);
const { files } = buildTextures(recipe, {});
function save(name, entries) {
  const zip = new AdmZip();
  for (const [file, data] of entries) {
    zip.addFile("assets/" + file, Buffer.from(data));
    zip.getEntry("assets/" + file).header.time = new Date(1980, 0, 1);
  }
  writeFileSync(name + ".tmp", zip.toBuffer());
  renameSync(name + ".tmp", name);
}
save("default-materials.zip", [
  ...files,
  ...["states.bin", "quad-references.bin", "book.png"].map((name) => [name, read(name)]),
]);
save("material-info.zip", Object.entries(recipe));
