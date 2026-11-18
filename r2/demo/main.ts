// 独立验证页：场景放进内存世界，经 memorySource 与 WorldSession 走和存档相同的准备与绘制路径。
// 不需要后端，任何静态文件服务都能运行；应用的存档读取与界面位于 apps/neomega-viewer-r2。
import {
  createRenderer,
  enchantingBook,
  memorySource,
  MemoryWorld,
  ObjectRegistry,
  WorldSession,
  type PreviewTier,
} from "neomega-r2";
import { scenes } from "./scenes.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#view")!,
  select = document.querySelector<HTMLSelectElement>("#scene")!,
  status = document.querySelector<HTMLElement>("#status")!,
  input = (id: string) => document.querySelector<HTMLInputElement>("#" + id)!,
  params = new URLSearchParams(location.search);
const renderer = await createRenderer(canvas, { assets: "/assets/" });

/** 测试用旗面：私有像素贴图，中间留一个透明孔。 */
function testBanner() {
  const pixels = new Uint8Array(32 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 32; x++) {
      const color = (x >= 13 && x < 19) || (y >= 27 && y < 35) ? [245, 198, 67, 255] : [23, 63, 152, 255];
      pixels.set(x >= 12 && x < 20 && y >= 49 && y < 57 ? [0, 0, 0, 0] : color, (x + y * 32) * 4);
    }
  return {
    texture: { pixels, width: 32, height: 64 },
    bounds: [
      [0, 0, -0.005],
      [1, 2, 0.005],
    ],
    parts: [{ minimum: [0, 0, -0.005], maximum: [1, 2, 0.005], faces: Array.from({ length: 6 }, () => [0, 0, 32, 64]) }],
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
}
const registry = new ObjectRegistry()
  .register("enchanting_book", () => enchantingBook("/assets/book.png"))
  .register("test_banner", testBanner);

for (const [name, scene] of Object.entries(scenes)) select.add(new Option(scene.label, name));

let world = new MemoryWorld(),
  session: WorldSession | null = null,
  sceneName = "",
  loaded: (() => void) | null = null,
  shownTier: PreviewTier = "shading",
  frame = 0,
  frames: number[] = [],
  last = performance.now(),
  statusAt = 0;
const camera = { position: [0, 0, 0], yaw: 0, pitch: 0 };

function setCamera(eye: number[], target: number[]) {
  camera.position = [...eye];
  const d = target.map((v, i) => v - eye[i]);
  camera.yaw = Math.atan2(d[0], -d[2]);
  camera.pitch = Math.asin(d[1] / Math.hypot(...d));
  renderer.resetTiming();
}

/** 换场景：新建内存世界与会话，所有区域和近景对象显示完成后兑现。 */
function loadScene(name: string): Promise<void> {
  const scene = scenes[name];
  if (!scene) throw Error("未知场景 " + name);
  session?.dispose();
  sceneName = name;
  select.value = name;
  world = new MemoryWorld();
  scene.build(world);
  session = new WorldSession(renderer, memorySource(world), {
    registry,
    onError: (message) => (status.textContent = message),
  });
  setCamera(scene.camera, scene.target);
  frames = [];
  return new Promise((resolve) => (loaded = resolve));
}
select.onchange = () => loadScene(select.value);

const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());
canvas.onpointerdown = (e) => canvas.setPointerCapture(e.pointerId);
canvas.onpointermove = (e) => {
  if (!canvas.hasPointerCapture(e.pointerId)) return;
  camera.yaw += e.movementX * 0.004;
  camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch - e.movementY * 0.004));
  renderer.resetTiming();
};
canvas.onpointerup = (e) => canvas.releasePointerCapture(e.pointerId);

function render(now: number) {
  requestAnimationFrame(render);
  if (!session) return;
  frames.push(now - last);
  if (frames.length > 240) frames.shift();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = dt * (keys.has("shift") ? 25 : 8),
    { yaw, pitch } = camera,
    forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)],
    right = [Math.cos(yaw), 0, Math.sin(yaw)],
    key = (k: string) => Number(keys.has(k));
  for (let i = 0; i < 3; i++)
    camera.position[i] += speed * ((key("w") - key("s")) * forward[i] + (key("d") - key("a")) * right[i]);
  camera.position[1] += speed * (key("e") - key("q"));

  session.focus(camera.position, { nearRadius: 4, farRadius: 8 });
  session.publish();
  const stats = session.stats;
  if (loaded && stats.loaded === stats.wanted && !stats.pending && !stats.nearPending) {
    loaded();
    loaded = null;
    renderer.resetTiming();
  }
  const resolution = document.querySelector<HTMLSelectElement>("#resolution")!.value,
    scale = resolution === "device" ? devicePixelRatio : Number(resolution),
    width = Math.round(innerWidth * scale),
    height = Math.round(innerHeight * scale);
  renderer.objects.enabled = r2.specialEnabled;
  // 选中的档第一次使用时编译，编译完成前沿用已有的档。
  const tier = document.querySelector<HTMLSelectElement>("#tier")!.value as PreviewTier;
  if (renderer.ready(tier)) shownTier = tier;
  else if (!renderer.compiling(tier)) renderer.compile(tier).catch((error) => (status.textContent = String(error)));
  renderer.draw(camera, {
    width,
    height,
    tier: shownTier,
    time: r2.fixedTime ?? now / 1000,
    debug: Number(document.querySelector<HTMLSelectElement>("#debug")!.value),
    hierarchy: input("hierarchy").checked,
    fragments: input("fragments").checked,
  });
  frame++;
  if (now - statusAt > 300) {
    const times = [...renderer.times].sort((a, b) => a - b),
      median = times[Math.floor(times.length / 2)];
    status.textContent =
      `${width}×${height} 实际像素 · GPU ${median?.toFixed(2) || "…"} ms\n` +
      `${world.blockCount} 个方块 · ${fragmentReferences()} 个跨格片段引用 · r2region ${stats.loaded}/${stats.wanted}\n` +
      `GPU 纹理 ${(renderer.textureBytes / 1024 ** 2).toFixed(1)} MiB\n` +
      `位置 ${camera.position.map((v) => v.toFixed(1)).join(", ")}`;
    statusAt = now;
  }
}

function fragmentReferences(): number {
  let count = 0;
  for (const region of session?.gpu.regions.values() ?? []) count += region.stats.fragmentReferences;
  return count;
}

// 验收脚本的入口：读取状态、换场景、固定相机和读回像素；specialEnabled 关闭特殊对象，fixedTime 固定水面时刻。
const r2 = {
  specialEnabled: true,
  fixedTime: null as number | null,
  gl: renderer.gl,
  renderer,
  loadScene,
  setCamera,
  resetTiming() {
    renderer.resetTiming();
    frames = [];
  },
  pixels: renderer.pixels,
  get world() {
    return world;
  },
  get session() {
    return session;
  },
  get state() {
    return {
      scene: sceneName,
      /** 当前场景的区域与近景对象都已显示；之后的 GPU 计时才属于完整画面。 */
      ready: loaded === null,
      blocks: world.blockCount,
      fragmentReferences: fragmentReferences(),
      session: session?.stats,
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
Object.assign(globalThis, { r2 });
loadScene(params.get("scene") && scenes[params.get("scene")!] ? params.get("scene")! : "showcase");
requestAnimationFrame(render);
