import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { blockHash, AIR } from "../src/source/hash.ts";
import { MemoryWorld, memorySource, encodeRegion } from "../src/source/memory.ts";
import { decodeRegion, unpack } from "../src/scene/prepare.ts";

// 与 Go 的 neomega-blocks BlockToHash 对照；属性顺序和省略的命名空间不影响结果。
test("blockHash 与 neomega-blocks 一致", async () => {
  const { vectors } = JSON.parse(await readFile(new URL("hash-vectors.json", import.meta.url), "utf8"));
  for (const { state, hash } of vectors) assert.equal(blockHash(state), hash, state);
  assert.equal(
    blockHash('oak_fence ["west"="true","north"="true","south"="true","east"="true"]'),
    blockHash('minecraft:oak_fence ["east"="true","north"="true","south"="true","west"="true"]'),
  );
  assert.equal(blockHash("minecraft:air []"), AIR);
  assert.throws(() => blockHash('minecraft:stone "a"="b"'));
});

/** 测试用状态表：哈希按升序排成 [hash, model] 对。 */
function statesOf(hashes) {
  const sorted = [...hashes].sort((a, b) => a - b);
  return new Uint32Array(sorted.flatMap((hash) => [hash, hash === AIR ? 0 : sorted.indexOf(hash) + 1]));
}

test("encodeRegion 能被 decodeRegion 还原，空气 section 省略", () => {
  const stone = blockHash("minecraft:stone"),
    glass = blockHash("minecraft:glass"),
    blocks = new Uint32Array(4096);
  blocks[(3 << 8) | (5 << 4) | 7] = stone;
  blocks[(15 << 8) | (15 << 4) | 15] = glass;
  const buffer = encodeRegion([
    { position: [1, -2, 3], blocks },
    { position: [1, 0, 3], blocks: new Uint32Array(4096) },
    { position: [2, 0, 3], blocks: new Uint32Array(4096).fill(stone) },
  ]);
  const states = statesOf([AIR, stone, glass]),
    region = decodeRegion(buffer, states);
  assert.equal(region.unknown, 0);
  assert.equal(region.sections.length, 2);
  const [mixed, uniform] = region.sections;
  assert.deepEqual(mixed.position, [1, -2, 3]);
  const cells = unpack(mixed);
  assert.equal(cells[(3 << 8) | (5 << 4) | 7], states[states.indexOf(stone) + 1]);
  assert.equal(cells[(15 << 8) | (15 << 4) | 15], states[states.indexOf(glass) + 1]);
  assert.equal(cells[0], 0);
  assert.equal(uniform.bits, 0);
});

test("MemoryWorld 按区域编码，负坐标落在正确的 section", () => {
  const world = new MemoryWorld();
  world.set(-1, -64, -1, "minecraft:stone");
  world.fill([0, 0, 0], [1, 1, 1], "minecraft:glass");
  assert.equal(world.get(-1, -64, -1), blockHash("minecraft:stone"));
  assert.equal(world.blockCount, 9);
  assert.equal(world.region(5, 5), null);
  const region = decodeRegion(world.region(-1, -1), statesOf([AIR, blockHash("minecraft:stone")]));
  assert.deepEqual(region.sections[0].position, [-1, -4, -1]);
  assert.equal(unpack(region.sections[0]).filter(Boolean).length, 1);
  world.set(-1, -64, -1, 0);
  assert.equal(world.region(-1, -1), null, "只剩空气的区域视为空");
});

test("memorySource 提交需要的区域与近景对象，commit 后重新提交变化", async () => {
  const world = new MemoryWorld();
  world.set(10, 2, 10, "minecraft:stone");
  world.addObject({ key: "near", kind: "test", position: [20, 2, 20] });
  world.addObject({ key: "far", kind: "test", position: [120, 2, 120] });
  world.commit();
  const received = [],
    source = memorySource(world);
  source.open({
    region: (x, z, data) => received.push(["region", x, z, data && new Uint32Array(data)[1]]),
    objects: (x, z, list) => received.push(["objects", x, z, list.map((o) => o.key)]),
    error: (x, z, error) => assert.fail(String(error)),
  });
  source.want({
    center: [0, 0],
    regions: { add: [{ x: 0, z: 0 }, { x: 1, z: 0 }], remove: [] },
    objects: { add: [{ x: 0, z: 0, center: [0, 0, 0], radius: 4 }], remove: [] },
  });
  assert.equal(received.length, 0, "在微任务里提交，不在 want 内重入会话");
  await Promise.resolve();
  assert.deepEqual(received, [
    ["region", 0, 0, 1],
    ["region", 1, 0, null],
    ["objects", 0, 0, ["near"]],
  ]);
  received.length = 0;
  world.set(130, 2, 10, "minecraft:stone");
  world.set(300, 2, 10, "minecraft:stone");
  world.commit();
  await Promise.resolve();
  assert.deepEqual(received, [["region", 1, 0, 1]], "只重新提交仍需要的区域");
  received.length = 0;
  source.want({ center: [0, 0], regions: { add: [], remove: [{ x: 1, z: 0 }] }, objects: { add: [], remove: [] } });
  world.removeObject("near");
  world.set(131, 2, 10, "minecraft:stone");
  world.commit();
  await Promise.resolve();
  assert.deepEqual(received, [["objects", 0, 0, []]]);
  source.close();
  world.set(10, 3, 10, "minecraft:stone");
  world.commit();
  await Promise.resolve();
  assert.equal(received.length, 1, "关闭后不再提交");
});
