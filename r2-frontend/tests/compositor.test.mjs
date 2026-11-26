import assert from "node:assert/strict";
import test from "node:test";
import { filterParameters } from "../src/compositor/denoise.ts";
import { SceneMarks } from "../src/compositor/scene-overlay.ts";

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.calls = [];
  }
  getContext() {
    const calls = this.calls;
    return {
      setTransform() {},
      beginPath() { calls.push("beginPath"); },
      moveTo() {},
      lineTo() {},
      closePath() {},
      translate() {},
      rotate() {},
      ellipse() {},
      drawImage() {},
      fill() { calls.push("fill"); },
      stroke() { calls.push("stroke"); },
    };
  }
}

test("SceneMarks 区分深度测试标记与置顶标记，并正确排序和投影深度平面", (t) => {
  const prev = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  t.after(() => { globalThis.OffscreenCanvas = prev; });

  const marks = new SceneMarks();
  assert.equal(marks.needsDepth, false);

  const top = marks.marker([0, 0, -5], { alwaysVisible: true, width: 10, height: 10 });
  assert.equal(marks.needsDepth, false);

  const face = marks.blockFace({ position: [0, 0, -5], normal: [0, 1, 0] });
  assert.equal(marks.needsDepth, true);

  const camera = { position: [0.5, 4, 0], yaw: 0, pitch: -Math.PI / 4 };
  const stamps = marks.stamps(camera, 800, 600, 1, false, 800 / 600);
  assert.equal(stamps.length, 2);
  // 带深度测试的标记先绘制，置顶标记排在后面覆盖。
  assert.equal(stamps[0].test, true);
  assert.equal(stamps[1].test, false);

  // overview 模式下只保留 alwaysVisible 标记。
  const overviewStamps = marks.stamps(camera, 800, 600, 1, true, 800 / 600);
  assert.equal(overviewStamps.length, 1);
  assert.equal(overviewStamps[0].test, false);

  face.remove();
  assert.equal(marks.needsDepth, false);
  top.remove();
  assert.equal(marks.size, 0);
});

test("降噪参数覆盖轻中高度三档", () => {
  assert.ok(filterParameters.light.colorSigma < filterParameters.medium.colorSigma);
  assert.ok(filterParameters.medium.colorSigma < filterParameters.high.colorSigma);
});
