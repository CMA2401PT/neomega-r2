// 构建脚本将指定提交的 brickmap 原始源码放在同目录 core 中，基准本身不改旧着色器。
import { BrickmapPool, BrickmapWindow } from "./core/gpu.ts";
import { BrickmapRenderer } from "./core/renderer.ts";
import { decodeVolume } from "./core/volume.ts";
const canvas = document.querySelector("canvas")!,
  gl = canvas.getContext("webgl2", {
    antialias: false,
    preserveDrawingBuffer: true,
  })!;
const pool = new BrickmapPool(gl),
  timer = gl.getExtension("EXT_disjoint_timer_query_webgl2")!;
let window: BrickmapWindow,
  renderer: BrickmapRenderer,
  eye = [1280, 271, 1280],
  target = [1120, 185, 1080],
  running = false,
  regions: any[] = [],
  queries: WebGLQuery[] = [],
  times: number[] = [],
  completed: number[] = [],
  frames: number[] = [],
  last = performance.now();
async function load(position: number[]) {
  running = false;
  for (const r of regions) pool.release(r);
  regions = [];
  window?.dispose();
  renderer?.dispose();
  const origin = [
    Math.floor(position[0] / 128 + 0.5) * 128 - 768,
    -64,
    Math.floor(position[2] / 128 + 0.5) * 128 - 768,
  ] as [number, number, number];
  window = new BrickmapWindow(gl, origin, [1536, 512, 1536]);
  renderer = new BrickmapRenderer(gl, pool, window);
  const jobs: number[][] = [];
  for (let x = 0; x < 12; x++)
    for (let z = 0; z < 12; z++)
      jobs.push([origin[0] / 128 + x, origin[2] / 128 + z]);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (jobs.length) {
        const [x, z] = jobs.shift()!;
        const response = await fetch(
          `/api/minimap/region?world=1&x=${x}&z=${z}`,
        );
        if (!response.ok) throw Error(await response.text());
        const volume = decodeVolume(await response.arrayBuffer());
        const region = pool.upload(volume);
        if (!region) throw Error("砖池不足");
        regions.push(region);
      }
    }),
  );
  window.rebuild(origin, regions);
  eye = [...position];
  running = true;
  reset();
}
function reset() {
  for (const q of queries) gl.deleteQuery(q);
  queries = [];
  times = [];
  frames = [];
  completed = [];
}
function render(now: number) {
  requestAnimationFrame(render);
  if (!running) return;
  const width = innerWidth,
    height = innerHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    reset();
  }
  frames.push(now - last);
  if (frames.length > 240) frames.shift();
  last = now;
  while (
    queries.length &&
    gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
  ) {
    const q = queries.shift()!;
    times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    if (times.length > 240) times.shift();
    gl.deleteQuery(q);
  }
  const d = target.map((v, i) => v - eye[i]),
    length = Math.hypot(...d),
    direction = d.map((v) => v / length),
    yaw = Math.atan2(d[0], -d[2]),
    pitch = Math.asin(d[1] / length);
  const start = performance.now(),
    q = gl.createQuery()!;
  gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
  renderer.drawPerspective(
    {
      position: eye as any,
      right: [Math.cos(yaw), 0, Math.sin(yaw)],
      up: [
        -Math.sin(yaw) * Math.sin(pitch),
        Math.cos(pitch),
        Math.cos(yaw) * Math.sin(pitch),
      ],
      direction: direction as any,
      verticalFov: 65,
      near: 0.01,
      far: 4096,
    },
    {
      fog: [1e8, 2e8],
      viewport: [0, 0, width, height],
      background: [0.68, 0.78, 0.88],
    },
  );
  gl.endQuery(timer.TIME_ELAPSED_EXT);
  queries.push(q);
  if ((globalThis as any).baseline.synchronize) {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    completed.push(performance.now() - start);
    if (completed.length > 240) completed.shift();
  }
}
(globalThis as any).baseline = {
  load,
  setCamera(e: number[], t: number[]) {
    eye = e;
    target = t;
    reset();
  },
  reset,
  get state() {
    return {
      times: [...times],
      completed: [...completed],
      frames: [...frames],
      bytes: renderer?.textureBytes,
      error: gl.getError(),
    };
  },
};
await load(eye);
requestAnimationFrame(render);
