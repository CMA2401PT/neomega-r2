import assert from "node:assert/strict";
import test from "node:test";
import { MinecraftMemoryWorld, minecraftMemorySource } from "neomega-r2-mc";
import { minecraftRenderSource } from "../../r2-mc/dist/world.js";
import { recordNearSNBT } from "../src/ui/player/world.ts";

test("部分区域进出近景、同格文字变化以及未知实体的查看彼此独立", async () => {
  const errors = [];
  const world = new MinecraftMemoryWorld(),
    records = recordNearSNBT(minecraftMemorySource(world)),
    source = minecraftRenderSource(records.source, (message) => errors.push(message));
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
  assert.equal(records.snbt({ position: [0, 0, 0] }), "{unknown:9223372036854775807L}");
  assert.equal(records.snbt({ position }), raw);
  const oldSign = visible.find((o) => o.kind === "sign");
  const waxed = '{front_text:{messages:["甲"]},is_waxed:1b}';
  world.setBlockEntity(position, waxed);
  world.commit();
  await Promise.resolve();
  assert.equal(visible.find((o) => o.kind === "sign").appearanceKey, oldSign.appearanceKey);
  assert.equal(records.snbt({ position }), waxed);
  world.setBlockEntity(position, "{front_text:");
  world.commit();
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.equal(records.snbt({ position }), "{front_text:");
  assert.deepEqual(visible.map((o) => o.kind), ["enchanting_book"]);
  world.setBlockEntity(position, '{Text1:"乙"}');
  world.commit();
  await Promise.resolve();
  const edited = visible.find((o) => o.kind === "sign");
  assert.equal(edited.key, oldSign.key);
  assert.notEqual(edited.appearanceKey, oldSign.appearanceKey);
  await move([6, 0, 0]);
  assert.equal(records.snbt({ position }), undefined);
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
  assert.equal(records.snbt({ position: [0, 0, 0] }), undefined);
});

test("同格实体按拾取标识查看原文，替换快照只撤下被删除的实体", async () => {
  const world = new MinecraftMemoryWorld();
  const records = recordNearSNBT(minecraftMemorySource(world));
  const block = "{CustomName:'格子'}";
  const frames = [1, 2].map(id => [String(id),
    `{id:"minecraft:item_frame",Pos:[0.5d,0.5d,0.5d],Facing:2b,CustomName:"框${id}",UUID:[I;0,0,0,1]}`
  ]);
  world.setBlockEntity([0, 0, 0], block);
  world.setEntities([0, 0, 0], frames);
  world.commit();
  const source = minecraftRenderSource(records.source);
  let visible;
  source.open({ region() {}, objects(x, z, entries) { visible = entries; } });
  source.want({
    center: [0, 0],
    regions: { add: [{ x: 0, z: 0 }], remove: [] },
    objects: { add: [{ x: 0, z: 0, center: [0, 0, 0], radius: 1 }], remove: [] },
  });
  await Promise.resolve();
  const [first, second] = visible;
  assert.notEqual(first.key, second.key);
  assert.equal(records.snbt({ position: [0, 0, 0] }), block);
  assert.equal(records.snbt({ position: [0, 0, 0], entityId: frames[0][0] }), frames[0][1]);
  world.setEntities([0, 0, 0], [frames[1]]);
  world.commit();
  await Promise.resolve();
  assert.deepEqual(visible.map(d => d.key), [second.key]);
  assert.equal(records.snbt({ position: [0, 0, 0], entityId: frames[0][0] }), undefined);
  assert.equal(records.snbt({ position: [0, 0, 0], entityId: frames[1][0] }), frames[1][1]);
  source.close();
});
