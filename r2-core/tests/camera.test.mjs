import test from "node:test";
import assert from "node:assert/strict";
import { cameraBasis, cameraRay } from "../src/render/camera.ts";

const near = (actual, expected) =>
  actual.forEach((v, i) => assert(Math.abs(v - expected[i]) < 1e-10));

test("透视中心沿 forward，边缘射线从同一相机发散", () => {
  const camera = { position: [10000, 80, -300], yaw: 0.8, pitch: -0.6 };
  const center = cameraRay(camera, { width: 101, height: 101, x: 50, y: 50 });
  near(center.direction, cameraBasis(camera).forward);
  const edge = cameraRay(camera, { width: 101, height: 101, x: 0, y: 0 });
  assert.deepEqual(edge.origin, camera.position);
  assert.notDeepEqual(edge.direction, center.direction);
  assert(Math.abs(Math.hypot(...edge.direction) - 1) < 1e-10);
});

test("拾取射线跟随垂直视场角，正交地图沿用自己的跨度", () => {
  const wide = { position: [0, 0, 0], yaw: 0, pitch: 0, fov: 90 };
  const pixel = { width: 3, height: 3, x: 1, y: 0 };
  const ray = cameraRay(wide, pixel);
  assert(Math.abs(ray.direction[1] / -ray.direction[2] - 2 / 3) < 1e-10);
  const map = { ...wide, ortho: 30 };
  assert.deepEqual(cameraRay(map, pixel), cameraRay({ ...map, fov: 30 }, pixel));
});

test("正交射线方向相同，像平面宽高与像素中心一致", () => {
  const camera = {
    position: [0, 1000, 0],
    yaw: 0,
    pitch: -Math.PI / 2,
    ortho: 100,
  };
  const left = cameraRay(camera, { width: 200, height: 100, x: 0, y: 0 });
  const right = cameraRay(camera, { width: 200, height: 100, x: 199, y: 99 });
  near(left.direction, right.direction);
  near(left.origin, [-99.5, 1000, -49.5]);
  near(right.origin, [99.5, 1000, 49.5]);
});

test("斜俯视的正交起点位移垂直于射线，足迹不随高度改变", () => {
  const camera = {
    position: [1280, 4096, 1280],
    yaw: 0.7,
    pitch: -1.2,
    ortho: 320,
  };
  const options = { width: 1280, height: 720, x: 100, y: 300 };
  const a = cameraRay(camera, options),
    b = cameraRay(camera, { ...options, x: 101 });
  const delta = b.origin.map((v, i) => v - a.origin[i]);
  assert(
    Math.abs(delta.reduce((v, d, i) => v + d * a.direction[i], 0)) < 1e-10,
  );
  assert(Math.abs(Math.hypot(...delta) - 320 / 720) < 1e-10);
  const high = cameraRay({ ...camera, position: [1280, 8192, 1280] }, options);
  near(a.direction, high.direction);
});
