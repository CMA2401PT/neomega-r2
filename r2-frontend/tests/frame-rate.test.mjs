import assert from "node:assert/strict";
import test from "node:test";
import { FrameRate } from "../src/ui/viewport/frame-rate.ts";

test("慢帧完整计入最近两秒，静止时间不计入下一次移动", () => {
  const rate = new FrameRate();
  for (let t = 0; t <= 100; t += 10) rate.complete(t);
  assert.equal(rate.fps, 100);
  for (const t of [600, 1100, 1600, 2100]) rate.complete(t);
  assert.equal(rate.fps, 2);
  rate.idle();
  rate.complete(16000);
  assert.equal(rate.fps, null);
  rate.complete(17000);
  assert.equal(rate.fps, 1);
});

test("只统计完成的 WebGPU 帧，切换场景时丢弃旧回调", async () => {
  const rate = new FrameRate();
  const frame = Promise.withResolvers();
  rate.track(frame.promise);
  rate.idle();
  assert.equal(rate.waiting, true);
  assert.equal(rate.fps, null);
  rate.reset();
  frame.resolve();
  await frame.promise;
  rate.complete(1);
  assert.deepEqual(rate.intervals, []);
  const next = Promise.resolve();
  rate.track(next);
  await next;
  assert.equal(rate.waiting, false);
  assert.equal(rate.intervals.length, 1);
});
