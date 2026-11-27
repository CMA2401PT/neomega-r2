import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { encode } from "fast-png";
import { buildTextures } from "../src/build.ts";
import { unpackMaterials } from "../src/archive.ts";
import { replacementReader } from "../src/tiles.ts";
import { blockHash, modelOf } from "neomega-r2-core";

const root = process.env.R2_GENERATED;
const archive = (name) => unpackMaterials(readFileSync(join(root, "browser-materials", name)));
const recipe = root && archive("material-info.zip");
const defaults = root && archive("default-materials.zip");
const manifest = root && JSON.parse(new TextDecoder().decode(recipe["textures.json"]));
const states = root && new Uint32Array(defaults["states.bin"].buffer);
function png(w, h, color) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(color(x, y), (y * w + x) * 4);
  return encode({ width: w, height: h, channels: 4, data });
}
const layer = (name) =>
  manifest.layers.findIndex((parts) => parts.length === 1 && parts[0].texture === "minecraft:block/" + name);
function pixel(set, file, id, x = 0, y = 0, level = 0) {
  let size = set.info.side,
    offset = 0;
  for (let i = 0; i < level; i++) {
    offset += size * size * 4 * set.info.layers;
    size /= 2;
  }
  offset += ((id * size + y) * size + x) * 4;
  return [...new Uint8Array(set.files.get(file), offset, 4)];
}
test("合成信息独立发布；从基表重建的默认材质与分发包逐字节一致", {skip: !root && "需要 R2_GENERATED 中的材质包"}, () => {
  assert.equal(Object.keys(recipe).length, 5);
  assert.equal(Object.keys(defaults).length, 14);
  const set = buildTextures(recipe, {});
  for (const [name, data] of set.files) assert.deepEqual(new Uint8Array(data), defaults[name], name);
  for (const name of [
    "sea_lantern",
    "glowstone",
    "shroomlight",
    "ochre_froglight_side",
    "verdant_froglight_top",
  ]) {
    for (let level = 0; level < set.info.levels; level++)
      assert.deepEqual(pixel(set, "surface-specular.bin", layer(name), 0, 0, level), [0, 0, 0, 190]);
  }
  for (const [i, parts] of manifest.layers.entries()) {
    if (!["minecraft:block/grass_block_side", "minecraft:block/grass_block_snow"].includes(parts[0].texture))
      continue;
    const side = set.info.side,
      bytes = new Uint8Array(set.files.get("surface-layers.bin"), i * side * side * 4, side * side * 4);
    assert.ok(bytes.every((v, j) => j % 4 !== 3 || v === 255));
  }
});
test("Java 自选包保留数据通道，并同步更新裁切、图集、缩小层与动画首帧", {skip: !root && "需要 R2_GENERATED 中的材质包"}, () => {
  const base = "assets/minecraft/textures/block/";
  const pack = Object.fromEntries(
    Object.entries({
      "stone.png": png(64, 64, (x) => (x < 32 ? [255, 0, 0, 255] : [0, 255, 0, 0])),
      "stone_n.png": png(64, 64, () => [32, 192, 77, 19]),
      "stone_s.png": png(32, 32, () => [203, 230, 11, 0]),
      "dandelion.png": png(16, 16, () => [0, 255, 255, 255]),
      "oak_leaves.png": png(32, 32, () => [255, 0, 255, 255]),
      "daylight_detector_side.png": png(128, 128, () => [128, 0, 0, 255]),
      "gold_block.png": png(32, 64, (_, y) => (y < 32 ? [0, 255, 0, 255] : [0, 0, 255, 255])),
      "gold_block.png.mcmeta": new TextEncoder().encode('{"animation":{"frames":[{"index":1},0]}}'),
      "dirt.png": new Uint8Array([0]),
    }).map(([name, data]) => [base + name, data]),
  );
  for (const limit of [128, 32]) {
    const set = buildTextures(recipe, pack, limit);
    assert.equal(set.info.side, Math.min(limit, 64));
    const last = set.info.levels - 1,
      stone = layer("stone");
    assert.deepEqual(pixel(set, "surface-layers.bin", stone, 0, 0, last), [188, 0, 0, 128]);
    assert.deepEqual(pixel(set, "surface-normals.bin", stone, 0, 0, last), [32, 192, 77, 19]);
    assert.deepEqual(pixel(set, "surface-specular.bin", stone, 0, 0, last), [203, 230, 11, 0]);
    assert.deepEqual(pixel(set, "surface-layers.bin", layer("gold_block")), [0, 0, 255, 255]);
    const model = set.catalog.models[modelOf(states, blockHash("minecraft:stone"))];
    assert.equal(model.kind, 3);
    assert.equal(new Float32Array(set.files.get("fast.bin"))[model.offset * 4 + 15], 0.5);
    const leaf = modelOf(
      states,
      blockHash('minecraft:oak_leaves ["distance"="1","persistent"="false","waterlogged"="false"]'),
    );
    assert.equal(set.catalog.models[leaf].kind, 1);
    const records = new Float32Array(set.files.get("quad-records.bin"));
    const rec = manifest.quads.indexOf("minecraft:block/stone") * 28;
    assert.equal(records[rec + 14], 1);
    const at =
      (records[rec + 17] * set.info.atlasHeight * set.info.atlasWidth +
        records[rec + 16] * set.info.atlasWidth) *
      4;
    assert.deepEqual([...new Uint8Array(set.files.get("atlas-specular.bin"), at, 4)], [203, 230, 11, 0]);
    assert.equal(records[manifest.quads.indexOf("minecraft:block/dandelion") * 28 + 14], 0);
  }
});
test("基岩高度图只采首帧，MER 常量转为高光通道", {skip: !root && "需要 R2_GENERATED 中的材质包"}, () => {
  const read = replacementReader({
    "Pack/textures/blocks/brick.texture_set.json": new TextEncoder().encode(
      JSON.stringify({
        "minecraft:texture_set": { heightmap: "height", metalness_emissive_roughness: [255, 255, 64] },
      }),
    ),
    "Pack/textures/blocks/height.png": png(4, 8, (x, y) => [
      y === 1 && x === 2 ? 175 : y === 1 && x === 1 ? 46 : y >= 4 ? 255 : 0,
      0,
      0,
      255,
    ]),
  });
  const [, normal, specular] = read("minecraft:block/bricks");
  assert.equal(normal.height, 4);
  assert.deepEqual(
    [0, 1, 2].map((x) => normal.data[(4 + x) * 4 + 3]),
    [233, 239, 255],
  );
  assert.ok(normal.data[20] < 128);
  assert.deepEqual([...specular.data], [191, 230, 0, 254]);
});
