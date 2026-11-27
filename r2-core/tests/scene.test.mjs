import test from "node:test";
import assert from "node:assert/strict";
import { prepareRegion, unpack, decodeRegion, modelOf } from "../src/scene/prepare.ts";
import { WordAllocator } from "../src/render/allocator.ts";
import { ObjectStore } from "../src/objects/store.ts";
import { ObjectRegistry } from "../src/objects/registry.ts";
import { RegionDirectory } from "../src/render/region-directory.ts";
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
  return { position, bits: 1, palette: new Uint32Array([0, 2]), words };
};
// 按着色器的读取顺序解出一个格子：均匀 section 直接给出编号，否则经附加块找调色板和片段表。
function cell(region, sectionIndex, index) {
  const h = region.headers,
    at = Array.from(h).findIndex((v, i) => i % 7 === 0 && v === sectionIndex);
  assert.notEqual(at, -1);
  const aux = h[at + 1];
  if (!aux) return { model: h[at + 6], parts: [] };
  const bits = h[at + 3],
    per = Math.floor(32 / bits),
    pi = bits
      ? (region.words[h[at + 2] + Math.floor(index / per)] >>>
          ((index % per) * bits)) &
        ((1 << bits) - 1)
      : 0;
  const model = region.words[aux + 193 + pi],
    parts = region.words[aux + 192],
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
test("静态预裁片不受近景范围影响，跨区域共存，来源卸载后不残留", () => {
  const owner = {
    sections: [raw([7, 0, 0], [(15 << 8) | (3 << 4) | 2])],
    unknown: 0,
  };
  const target = {
    sections: [
      {
        position: [8, 0, 0],
        bits: 0,
        palette: new Uint32Array([1]),
        words: new Uint32Array(),
      },
    ],
    unknown: 0,
  };
  const regions = new Map([
      ["0/0", owner],
      ["1/0", target],
    ]),
    options = { x: 1, z: 0, regions, catalog };
  const near = prepareRegion(options),
    actual = cell(near, 8 * 4, (3 << 4) | 2);
  assert.equal(actual.model, 1);
  assert.deepEqual(actual.parts, [3]);
  const far = prepareRegion({ ...options, center: [40, 0, 0], radius: 1 });
  assert.deepEqual(far.words, near.words);
  assert.deepEqual(far.headers, near.headers);
  assert.deepEqual(cell(far, 8 * 4, (3 << 4) | 2).parts, [3]);
  regions.delete("0/0");
  assert.deepEqual(cell(prepareRegion(options), 8 * 4, (3 << 4) | 2).parts, []);
});
test("斜三角面只登记到实际覆盖的格，区域内复用面记录，整格平面归较大一侧", () => {
  const handle = 0x80001000;
  const positions = [[0,0,0], [3.5,0,0], [0,0,3.5]];
  const mesh = {
    vertices: positions.map(position => ({ position, uv: [0,0] })),
    triangles: [{ indices: [0,1,2] }],
  };
  const region = prepareRegion({
    x: -1, z: 0, catalog, regions: new Map([["-1/0", { sections: [], unknown: 0 }]]),
    objects: [{ owner: [-4,2,0], bounds: [[-4,2,0],[0,3,4]], ids: [handle], mesh }],
  });
  const at = (x,y,z) => cell(region, 7 + 8*4, ((x&15)<<8) | (z<<4) | y).parts;
  const [address] = at(-4,2,0);
  assert.equal(address >>> 30, 1);
  assert.equal(region.words[address & 0x3fffffff], handle & 0x7fffffff);
  assert.deepEqual(at(-1,2,0), [address]);
  assert.deepEqual(at(-4,2,3), [address]);
  assert.deepEqual(at(-1,2,3), []);
  assert.deepEqual(at(-4,1,0), []);
  const aliases = Array.from(region.relocations).filter(i => region.words[i] === address);
  assert.equal(aliases.length, 10, "十个相交格均持有可重定位的同一面地址");
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
            palette: new Uint32Array([1]),
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

test("循环目录移动不重新分配区域，释放后父层也清空", () => {
  class Directory extends RegionDirectory {
    uploadWords() {}
    uploadDirectory() {}
  }
  const gpu = new Directory({ capacityWords: 4096 });
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
              palette: new Uint32Array([1]),
              words: new Uint32Array(),
            },
          ],
          unknown: 0,
        },
      ],
    ]),
    catalog,
  });
  gpu.install(prepared);
  const used = gpu.allocator.used;
  gpu.setWindow([-128, -64, 0], [512, 512, 512]);
  assert.equal(gpu.allocator.used, used);
  assert.equal(gpu.levels[0].data[255 + 256 * 4], 1);
  gpu.remove("-1/0");
  assert.equal(gpu.allocator.used, 0);
  assert(gpu.levels.every((l) => l.data.every((v) => v === 0)));
});
test("不同类型共用实例层，旧候选句柄不指向回收后新部件", async () => {
  const store = new ObjectStore({ image() {}, rows() {}, dispose() {} }),
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
  // 新区域先收到同一个对象时应接管它。随后撤回旧区域，不能回收新位置的部件。
  const changed = [];
  const move = (region, x) => store.setRegion(region, [
    { key: "new", kind: "actor", position: [x, 0, 0] },
  ], registry, ref => changed.push(ref.bounds));
  await move("c", 128.25);
  assert.deepEqual(changed, [
    [[1, 0, 0], [2, 1, 1]],
    [[128.25, 0, 0], [129.25, 1, 1]],
  ]);
  store.removeRegion("b");
  assert.deepEqual(store.references()[0].ids, [next]);
  changed.length = 0;
  const version = store.version;
  await move("c", 128.75);
  assert.ok(store.version > version);
  assert.deepEqual(store.references()[0].owner, [128.75, 0, 0]);
  assert.deepEqual(changed, [], "位姿已移动，但格子覆盖没有改变");
  store.removeRegion("c", ref => changed.push(ref.bounds));
  assert.deepEqual(changed, [[[128.75, 0, 0], [129.75, 1, 1]]]);
  assert.deepEqual(store.references(), []);
  store.clear();
  assert.equal(store.images.size, 0);
  assert(store.tiles.every((v) => v === 0));
});

// 传输调色板是方块哈希，解码时按状态表换成模型；表外哈希画成空气并计数。压缩索引不展开。
test("调色板哈希按状态表解码为模型编号", () => {
  const states = new Uint32Array([5, 0, 900, 2, 70000, 3]);
  const buffer = new Uint32Array([0x34504c54, 1, 7, 0, 0, 0, 1, 0, 900])
    .buffer;
  const region = decodeRegion(buffer, states);
  assert.deepEqual([...region.sections[0].palette], [2]);
  assert.equal(region.unknown, 0);
  const unknown = decodeRegion(new Uint32Array([0x34504c54, 1, 0, 0, 0, 1, 2, 0, 5, 41]).buffer, states);
  assert.deepEqual([...unknown.sections[0].palette], [0, 0]);
  assert.equal(unknown.unknown, 1);
  for (const [hash, model] of [[5, 0], [900, 2], [70000, 3], [6, undefined], [0xffffffff, undefined]])
    assert.equal(modelOf(states, hash), model);
  const prepared = prepareRegion({
    x: 0,
    z: 0,
    regions: new Map([["0/0", region]]),
    catalog,
  });
  assert.equal(cell(prepared, 7 + 8 * 4, 0).model, 2);
});
