import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { isCompound, parseSNBT } from "../src/libs/snbt.ts";
import { signSides } from "../src/special-blocks/sign/text.ts";

// 和浏览器构建共用素材加载方式，在无 WebGPU 的环境验证数据源到绘制描述的边界。
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
    export { defaultMinecraftAssets } from "./r2-mc/src/assets.ts";
    export { frameRenderer } from "./r2-mc/src/entities/item-frame/frame.ts";
    export { bannerLayers } from "./r2-mc/src/special-blocks/banner/banner.ts";
    export { potFaces } from "./r2-mc/src/special-blocks/pot/pot.ts";`,
  },
  alias: { "neomega-r2-core": root + "r2-core/src/index.ts" },
  loader: { ".png": "dataurl", ".gz": "dataurl" },
  bundle: true,
  format: "esm",
  write: false,
});
const { defaultMinecraftAssets, bannerLayers, potFaces, frameRenderer } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
test("读取 Go SNBT 的长整数、数值数组与原文转义", () => {
  const root = parseSNBT('{a:[L;9007199254740993,-1],b:[B;-128,127],i:[I;],s:"\\\"\\\\\n"}');
  assert.deepEqual(root.a, BigInt64Array.of(9007199254740993n, -1n));
  assert.deepEqual(root.b, Int8Array.of(-128, 127));
  assert.deepEqual(root.i, new Int32Array());
  assert.equal(isCompound(root.i), false);
  assert.equal(parseSNBT("9007199254740993l"), 9007199254740993n);
  assert.throws(() => parseSNBT("{}junk"), SyntaxError);
  assert.throws(() => parseSNBT("[B;128]"), SyntaxError);
  assert.equal(root.s, '"\\\n');
});

test("方块外观兼容 Java 和 Bedrock 字段", () => {
  assert.deepEqual(
    bannerLayers({ id: "Banner", Patterns: [{ Pattern: "cr", Color: 1 }] }, "blue"),
    bannerLayers({ patterns: [{ pattern: "minecraft:cross", color: "red" }] }, "blue"),
  );
  assert.deepEqual(
    potFaces({ sherds: ["minecraft:brick", "minecraft:angler_pottery_sherd"] }),
    potFaces({ sherds: { left: { id: "minecraft:angler_pottery_sherd" } } }),
  );
  const sides = signSides({ FrontText: { Text: "甲\n乙", IgnoreLighting: 1 }, BackText: { Text: "丙" } });
  assert.equal(sides[0].lines[1][0].text, "乙");
  assert.equal(sides[0].glow, true);
  assert.equal(sides[1].lines[0][0].text, "丙");
});

test("隐形展示框只生成内容的几何，物品旋转保留厚度和材质", async () => {
  const frame = { Pos: [0, 0, 0], Facing: 2, Invisible: 1, Item: { id: "minecraft:diamond_sword" } };
  const recipe = nbt => frameRenderer.factory({
    kind: "minecraft:item_frame", ...frameRenderer.appearance(nbt),
  }, defaultMinecraftAssets);
  const sword = await recipe(frame);
  const turned = await recipe({ ...frame, ItemRotation: 2 });
  const block = await recipe({ ...frame, Item: { id: "minecraft:sea_lantern" } });
  assert.equal(sword.mesh.triangles.length, 2);
  assert.equal(block.mesh.triangles.length, 12);
  assert.equal(new Set(sword.mesh.vertices.map(v => v.position[2])).size, 1);
  assert.equal(new Set(block.mesh.vertices.map(v => v.position[2])).size, 2);
  for (const [i, { position: [x, y, z], uv }] of sword.mesh.vertices.entries()) {
    const vertex = turned.mesh.vertices[i];
    assert.deepEqual(vertex.uv, uv);
    assert.ok(Math.abs(vertex.position[0] + y) < 1e-8 && Math.abs(vertex.position[1] - x) < 1e-8);
    assert.equal(vertex.position[2], z);
  }
  assert.equal(frameRenderer.appearance({ ...frame, Item: { id: "unknown:model" } }), undefined);
});
