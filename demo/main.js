// 独立验证页只组装场景、相机和控件；应用的存档与流式调度位于 apps/neomega-viewer-r2。
import { createRenderer, ObjectRegistry, enchantingBook } from "/r2/index.js";
const canvas = document.querySelector("#view"),
  renderer = await createRenderer(canvas, { assets: "/assets/" }),
  params = new URLSearchParams(location.search),
  select = document.querySelector("#scene"),
  status = document.querySelector("#status");
const registry = new ObjectRegistry()
  .register("enchanting_book", () => enchantingBook("/assets/book.png"))
  .register("test_banner", () => {
    const pixels = new Uint8Array(32 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 32; x++) {
        const color =
          (x >= 13 && x < 19) || (y >= 27 && y < 35)
            ? [245, 198, 67, 255]
            : [23, 63, 152, 255];
        pixels.set(
          x >= 12 && x < 20 && y >= 49 && y < 57 ? [0, 0, 0, 0] : color,
          (x + y * 32) * 4,
        );
      }
    return {
      texture: { pixels, width: 32, height: 64 },
      bounds: [
        [0, 0, -0.005],
        [1, 2, 0.005],
      ],
      parts: [
        {
          minimum: [0, 0, -0.005],
          maximum: [1, 2, 0.005],
          faces: Array.from({ length: 6 }, () => [0, 0, 32, 64]),
        },
      ],
      pose: () => ({
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        position: [0, 0, 0],
        scale: 1,
      }),
    };
  });
let scene,
  camera = { position: [0, 0, 0], yaw: 0, pitch: 0 },
  running = false,
  frame = 0,
  frames = [],
  last = performance.now(),
  statusAt = 0;
function setCamera(eye, target) {
  camera.position = [...eye];
  const d = target.map((v, i) => v - eye[i]);
  camera.yaw = Math.atan2(d[0], -d[2]);
  camera.pitch = Math.asin(d[1] / Math.hypot(...d));
  renderer.resetTiming();
}
async function loadScene(name) {
  running = false;
  renderer.objects.clear();
  const start = performance.now();
  const [value, buffer] = await Promise.all([
    fetch("/api/scene?name=" + name).then((r) => r.json()),
    fetch("/api/cells?name=" + name).then((r) => r.arrayBuffer()),
  ]);
  scene = value;
  const cells = new Uint32Array(buffer);
  if (name === "special") {
    await renderer.objects.setRegion(
      "special",
      [
        { key: "book", kind: "enchanting_book", position: [32, 2, 26] },
        { key: "banner", kind: "test_banner", position: [35.2, 2.2, 26.5] },
      ],
      registry,
    );
  }
  renderer.setGrid(scene, cells);
  setCamera(scene.camera, scene.target);
  scene.uploadMS = performance.now() - start;
  running = true;
  frames = [];
}
select.value = params.get("scene") || "showcase";
select.onchange = () => loadScene(select.value);
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
canvas.onpointerdown = (e) => canvas.setPointerCapture(e.pointerId);
canvas.onpointermove = (e) => {
  if (canvas.hasPointerCapture(e.pointerId)) {
    camera.yaw += e.movementX * 0.004;
    camera.pitch = Math.max(
      -1.5,
      Math.min(1.5, camera.pitch - e.movementY * 0.004),
    );
    renderer.resetTiming();
  }
};
canvas.onpointerup = (e) => canvas.releasePointerCapture(e.pointerId);
function render(now) {
  requestAnimationFrame(render);
  if (!running) return;
  frames.push(now - last);
  if (frames.length > 240) frames.shift();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = dt * (keys.has("shift") ? 25 : 8),
    { yaw, pitch } = camera,
    forward = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ],
    right = [Math.cos(yaw), 0, Math.sin(yaw)];
  for (let i = 0; i < 3; i++)
    camera.position[i] +=
      speed *
      ((Number(keys.has("w")) - Number(keys.has("s"))) * forward[i] +
        (Number(keys.has("d")) - Number(keys.has("a"))) * right[i]);
  camera.position[1] += speed * (Number(keys.has("e")) - Number(keys.has("q")));
  const scale =
      document.querySelector("#resolution").value === "device"
        ? devicePixelRatio
        : Number(document.querySelector("#resolution").value),
    width = Math.round(innerWidth * scale),
    height = Math.round(innerHeight * scale);
  renderer.objects.enabled = globalThis.r2.specialEnabled !== false;
  renderer.draw(camera, {
    width,
    height,
    time: globalThis.r2.fixedTime ?? now / 1000,
    debug: Number(document.querySelector("#debug").value),
    hierarchy: document.querySelector("#hierarchy").checked,
    fragments: document.querySelector("#fragments").checked,
  });
  frame++;
  if (now - statusAt > 300) {
    const times = renderer.times.sort((a, b) => a - b),
      median = times[Math.floor(times.length / 2)];
    status.textContent = `${width}×${height} 实际像素 · GPU ${median?.toFixed(2) || "…"} ms\n${scene.nonAir} 个非空气格 · ${scene.fragmentReferences} 个跨格片段引用\nGPU 纹理 ${(renderer.textureBytes / 1024 ** 2).toFixed(1)} MiB\n位置 ${camera.position.map((v) => v.toFixed(1)).join(", ")}`;
    statusAt = now;
  }
}
globalThis.r2 = {
  gl: renderer.gl,
  loadScene,
  setCamera,
  resetTiming: () => {
    renderer.resetTiming();
    frames = [];
  },
  pixels: renderer.pixels,
  get state() {
    return {
      scene,
      statistics: renderer.catalog.statistics,
      allocated: renderer.textureBytes,
      frame,
      times: renderer.times,
      frameTimes: [...frames],
      position: [...camera.position],
      resolution: [canvas.width, canvas.height],
    };
  },
};
await loadScene(select.value);
requestAnimationFrame(render);
