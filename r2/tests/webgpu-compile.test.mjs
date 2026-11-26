import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import converter from "../shaders/convert.cjs";

// Check the code sent to the browser. A second reachable traversal call can
// duplicate thousands of instructions when the graphics driver inlines it.
test("各 WebGPU 射线路径共用一个格子遍历调用点", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "r2-compile-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let fastSlots;
  for (const name of ["shading", "shading-retry", "accumulation", "accumulation-retry", "photo", "photo-retry", "basic-pick", "voxel-pick"]) {
    converter.convert(name, dir);
    const wgsl = readFileSync(join(dir, name + ".wgsl"), "utf8");
    if (!name.endsWith("-pick")) {
      assert.match(wgsl, /@compute\s+@workgroup_size\(8, 4, 1\)/);
      assert.match(wgsl, /textureStore\(/);
      assert.equal(wgsl.includes("atomicOr("), !name.endsWith("-retry"));
      // 只有补画阶段按掩码的置位数重新分派像素，首遍仍按原屏幕坐标绘制。
      assert.equal(wgsl.includes("countOneBits("), name.endsWith("-retry"));
      assert.equal(/fn intersectObject/.test(wgsl), name.endsWith("-retry"));
    } else {
      assert.match(wgsl, /@fragment/);
    }
    // Naga mangles argument types into function names. Count definition + calls.
    assert.equal(wgsl.match(/\bmarch\w*\(/g)?.length, 2, name);
    assert.equal(wgsl.match(/\bsunVisibility\w*\(/g)?.length ?? 0, name.endsWith("-pick") ? 0 : 2, name);
    // 硬光影和拾取档不承担雾中采样的开销。
    assert.equal(/fn airSampleDistance/.test(wgsl), /^(photo|accumulation)/.test(name), name);
    assert.equal(/fn cloudTransmission/.test(wgsl), /^(photo|accumulation)/.test(name), name);
    // 太阳周围的散射只在累积和拍照时计算，硬光影不承担这项开销。
    assert.equal(/fn aerosolDepth/.test(wgsl), /^(photo|accumulation)/.test(name), name);
    const slots = wgsl.match(/^\/\/ Uniform slots: (.*)$/m)[1].split(",");
    // Both compute passes reuse the same frame uniform buffer and per-tile retry mask.
    if (!name.endsWith("-retry")) fastSlots = slots;
    if (name.endsWith("-retry")) assert.deepEqual(slots, fastSlots);
    if (name.startsWith("photo") || name.startsWith("accumulation"))
      assert.equal(slots.includes("uBounces"), name.startsWith("photo"));
    // 从第二轮开始，输出必须包含之前累积的样本。
    if (/^(accumulation|photo)/.test(name)) assert.match(wgsl, /textureLoad\(history,/);
  }
});
