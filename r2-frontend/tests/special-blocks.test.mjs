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
    export { MemoryWorld, memorySource } from "neomega-r2-core";
    export { specialBlockSource } from "./r2-frontend/src/special-blocks/source.ts";
    export { bannerLayers } from "./r2-frontend/src/special-blocks/banner/banner.ts";
    export { potFaces } from "./r2-frontend/src/special-blocks/pot/pot.ts";`,
  },
  alias: { "neomega-r2-core": root + "r2-core/src/index.ts" },
  loader: { ".png": "dataurl", ".gz": "dataurl" },
  bundle: true,
  format: "esm",
  write: false,
});
const { MemoryWorld, memorySource, specialBlockSource, bannerLayers, potFaces } = await import(
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

test("部分区域进出近景、同格文字变化以及未知实体的查看彼此独立", async () => {
  const errors = [];
  const world = new MemoryWorld(),
    source = specialBlockSource(memorySource(world), (message) => errors.push(message));
  const position = [4, 0, 0],
    raw = '{front_text:{messages:["甲"]}}';
  world.set(...position, 'oak_sign ["rotation"="0"]');
  world.setBlockEntity(position, raw);
  world.set(1, 0, 0, "enchanting_table");
  world.set(0, 0, 0, "stone");
  world.setBlockEntity([0, 0, 0], "{unknown:9223372036854775807L}");
  let visible = [];
  source.open({
    region(_x, _z, data) {
      if (data) structuredClone(data, { transfer: [data] });
    },
    objects(_x, _z, objects) {
      visible = objects;
    },
    error(_x, _z, error) {
      throw error;
    },
  });
  async function move(center, first = false) {
    source.want({
      center: [0, 0],
      regions: { add: first ? [{ x: 0, z: 0 }] : [], remove: [] },
      objects: { add: [{ x: 0, z: 0, center, radius: 1 }], remove: [] },
    });
    await Promise.resolve();
  }
  await move([0, 0, 0], true);
  assert.deepEqual(visible.map((o) => o.kind).sort(), ["enchanting_book", "sign"]);
  assert.equal(source.snbtAt([0, 0, 0]), "{unknown:9223372036854775807L}");
  assert.equal(source.snbtAt(position), raw);
  const oldSign = visible.find((o) => o.kind === "sign");
  const waxed = '{front_text:{messages:["甲"]},is_waxed:1b}';
  world.setBlockEntity(position, waxed);
  world.commit();
  await Promise.resolve();
  assert.equal(visible.find((o) => o.kind === "sign").appearanceKey, oldSign.appearanceKey);
  assert.equal(source.snbtAt(position), waxed);
  world.setBlockEntity(position, "{front_text:");
  world.commit();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.equal(source.snbtAt(position), "{front_text:");
  assert.deepEqual(visible.map((o) => o.kind), ["enchanting_book"]);
  world.setBlockEntity(position, '{Text1:"乙"}');
  world.commit();
  await Promise.resolve();
  const edited = visible.find((o) => o.kind === "sign");
  assert.equal(edited.key, oldSign.key);
  assert.notEqual(edited.appearanceKey, oldSign.appearanceKey);
  await move([6, 0, 0]);
  assert.equal(source.snbtAt(position), undefined);
  assert.deepEqual(visible, []);
  await move([0, 0, 0]);
  assert.equal(visible.length, 2);
  world.setBlockEntity(position, null);
  world.commit();
  await Promise.resolve();
  assert.deepEqual(
    visible.map((o) => o.kind),
    ["enchanting_book"],
  );
  source.close();
  assert.equal(source.snbtAt([0, 0, 0]), undefined);
});
