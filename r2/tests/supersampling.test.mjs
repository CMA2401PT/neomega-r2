import assert from "node:assert/strict";
import test from "node:test";
import { sampleCell } from "../src/render/options.ts";

test("完整采样轮覆盖所有子格并重复，偶数网格的前四轮覆盖四个象限", () => {
  for (const grid of [1, 2, 3, 4]) {
    const samples = Array.from({ length: grid ** 2 }, (_, round) => sampleCell(round, grid));
    const expected = new Set();
    for (let row = 0; row < grid; row++) for (let column = 0; column < grid; column++) {
      expected.add(JSON.stringify([(column + 0.5) / grid - 0.5, (row + 0.5) / grid - 0.5, 1 / grid]));
    }
    assert.deepEqual(new Set(samples.map(sample => JSON.stringify(sample))), expected);
    assert.deepEqual(samples.map((_, round) => sampleCell(round + samples.length, grid)), samples);
    if (grid % 2 === 0) {
      assert.equal(new Set(samples.slice(0, 4).map(([dx, dy]) => `${dx > 0},${dy > 0}`)).size, 4);
    }
  }
});
