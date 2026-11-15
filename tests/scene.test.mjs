import test from "node:test";
import assert from "node:assert/strict";
import { prepareRegion, unpack } from "../web/scene/prepare.js";
import { WordAllocator } from "../web/render/allocator.js";
import { ObjectStore } from "../web/objects/store.js";
import { ObjectRegistry } from "../web/objects/registry.js";
import { WorldGPU } from "../web/render/world-gpu.js";
const catalog = {
  fragmentReach: 1,
  models: [
    { kind: 0 },
    { kind: 1 },
    { kind: 2, fragments: [{ offset: [1, 0, 0], model: 3 }] },
    { kind: 2 },
  ],
};
const raw = (position, indices) => {
  const words = new Uint32Array(128);
  for (const index of indices) words[index >> 5] |= 1 << (index & 31);
  return { position, bits: 1, palette: new Uint32Array([0, 0, 2, 1]), words };
};
function cell(region, sectionIndex, index) {
  const h = region.headers,
    at = Array.from(h).findIndex((v, i) => i % 5 === 0 && v === sectionIndex);
  assert.notEqual(at, -1);
  const bits = h[at + 3],
    per = Math.floor(32 / bits),
    pi = bits
      ? (region.words[h[at + 1] + Math.floor(index / per)] >>>
          ((index % per) * bits)) &
        ((1 << bits) - 1)
      : 0;
  const model = region.words[h[at + 2] + pi],
    tree = h[at + 4],
    parts = tree ? region.words[tree + 585] : 0,
    start = parts ? region.words[parts + index] : 0;
  return {
    model,
    parts: start
      ? Array.from(
          region.words.slice(start + 1, start + 1 + region.words[start]),
        )
      : [],
  };
}
test("预裁片进入相邻区域，与目标格本体共存，来源卸载后不残留", () => {
  const owner = {
    sections: [raw([7, 0, 0], [(15 << 8) | (3 << 4) | 2])],
    unknown: 0,
  };
  const target = {
    sections: [
      {
        position: [8, 0, 0],
        bits: 0,
        palette: new Uint32Array([1, 1]),
        words: new Uint32Array(),
      },
    ],
    unknown: 0,
  };
  const regions = new Map([
      ["0/0", owner],
      ["1/0", target],
    ]),
    options = { x: 1, z: 0, regions, catalog, center: [8, 0, 0], radius: 8 };
  const near = prepareRegion(options),
    actual = cell(near, 8 * 4, (3 << 4) | 2);
  assert.equal(actual.model, 1);
  assert.deepEqual(actual.parts, [3]);
  const far = prepareRegion({ ...options, center: [40, 0, 0], radius: 1 });
  assert.deepEqual(cell(far, 8 * 4, (3 << 4) | 2).parts, []);
  regions.delete("0/0");
  assert.deepEqual(cell(prepareRegion(options), 8 * 4, (3 << 4) | 2).parts, []);
});
test("实例跨负坐标边界，替换只影响准备好的本体格", () => {
  const regions = new Map([
    [
      "-1/0",
      {
        sections: [
          {
            position: [-1, 0, 0],
            bits: 0,
            palette: new Uint32Array([1, 1]),
            words: new Uint32Array(),
          },
        ],
        unknown: 0,
      },
    ],
  ]);
  const result = prepareRegion({
    x: -1,
    z: 0,
    regions,
    catalog,
    center: [0, 0, 0],
    radius: 8,
    objects: [
      {
        owner: [-1, 2, 0],
        replace: true,
        bounds: [
          [-1.2, 2, 0],
          [-0.2, 3, 1],
        ],
        ids: [0x80001000],
      },
    ],
  });
  assert.equal(cell(result, 7 + 8 * 4, (15 << 8) | 2).model, 0);
  assert.equal(cell(result, 7 + 8 * 4, (15 << 8) | 3).model, 1);
  assert.deepEqual(cell(result, 7 + 8 * 4, (15 << 8) | 2).parts, [0x80001000]);
  const relocated = result.words.slice(),
    base = 4096;
  for (const i of result.relocations) relocated[i] += base;
  for (const i of result.relocations)
    assert.equal(relocated[i], result.words[i] + base);
});
test("区域地址反复回收后恢复完整容量", () => {
  const allocator = new WordAllocator(8193);
  for (let n = 0; n < 100; n++) {
    const a = allocator.allocate(511),
      b = allocator.allocate(1000),
      c = allocator.allocate(129);
    allocator.release(b);
    allocator.release(a);
    allocator.release(c);
    assert.equal(allocator.used, 0);
    assert.deepEqual(allocator.free, [{ start: 1, length: 8192 }]);
  }
});
function fakeGL() {
  let next = 0;
  return new Proxy(
    { createTexture: () => ++next },
    {
      get: (target, key) =>
        key in target
          ? target[key]
          : typeof key === "string" && key.toUpperCase() === key
            ? key
            : () => {},
    },
  );
}
test("循环目录移动不重新分配区域，释放后父层也清空", () => {
  const gpu = new WorldGPU(
    fakeGL(),
    { get: (n) => n },
    { capacityWords: 4096 },
  );
  const prepared = prepareRegion({
    x: -1,
    z: 0,
    regions: new Map([
      [
        "-1/0",
        {
          sections: [
            {
              position: [-1, 0, 0],
              bits: 0,
              palette: new Uint32Array([1, 1]),
              words: new Uint32Array(),
            },
          ],
          unknown: 0,
        },
      ],
    ]),
    catalog,
    center: [0, 0, 0],
    radius: 8,
  });
  gpu.install(prepared);
  const used = gpu.allocator.used;
  gpu.setWindow([-128, -64, 0], [512, 512, 512]);
  assert.equal(gpu.allocator.used, used);
  assert.equal(gpu.levels[0].data[127 + 128 * 4], 1);
  gpu.remove("-1/0");
  assert.equal(gpu.allocator.used, 0);
  assert(gpu.levels.every((l) => l.data.every((v) => v === 0)));
});
test("不同类型共用实例层，旧候选句柄不指向回收后新部件", async () => {
  const gl = fakeGL(),
    store = new ObjectStore(gl, { get: (n) => n }),
    registry = new ObjectRegistry().register("actor", () => ({
      texture: {
        width: 1,
        height: 1,
        pixels: new Uint8Array([255, 0, 0, 255]),
      },
      bounds: [
        [0, 0, 0],
        [1, 1, 1],
      ],
      parts: [
        {
          minimum: [0, 0, 0],
          maximum: [1, 1, 1],
          faces: Array.from({ length: 6 }, () => [0, 0, 1, 1]),
        },
      ],
      pose: () => ({
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        position: [0, 0, 0],
      }),
    }));
  await store.setRegion(
    "a",
    [{ key: "old", kind: "actor", position: [0, 0, 0] }],
    registry,
  );
  const old = store.references()[0].ids[0];
  store.removeRegion("a");
  await store.setRegion(
    "b",
    [{ key: "new", kind: "actor", position: [1, 0, 0] }],
    registry,
  );
  const next = store.references()[0].ids[0];
  assert.equal(old & 4095, next & 4095);
  assert.notEqual(old, next);
  store.clear();
  assert.equal(store.images.size, 0);
  assert(store.tiles.every((v) => v === 0));
});
