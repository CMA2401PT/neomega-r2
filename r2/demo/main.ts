// 独立验证页：场景放进内存世界，经 memorySource 与 WorldSession 走和存档相同的准备与绘制路径。
// 场景选择与调试选项由此页提供；相机、地图与工具栏来自 common_ui。
import {
  createRenderer,
  enchantingBook,
  memorySource,
  MemoryWorld,
  ObjectRegistry,
  WorldSession,
} from "neomega-r2";
import { createView, startupStage, type ViewSettings } from "/r2/common_ui/view.js";
import { mountRenderDebug } from "/r2/common_ui/render-debug.js";
import { scenes } from "./scenes.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#view")!,
  select = document.querySelector<HTMLSelectElement>("#scene")!,
  input = (id: string) => document.querySelector<HTMLInputElement>("#" + id)!,
  params = new URLSearchParams(location.search);
const settings: ViewSettings = {
  nearRadius: 4, farRadius: 8, speed: 32, resolution: "native", tier: "shading",
  time: 10, timeFlow: false, fog: true, stillAccumulation: false, photoScale: 2,
};
input("far-radius").min = "8";
const { status, drawOptions } = mountRenderDebug(document.getElementById("render-debug")!);
const renderer = await createRenderer(canvas, {
  assets: "/assets/", tier: settings.tier, useWebGPU: params.get("backend") !== "webgl",
  onProgress: ({ label }) => startupStage(label),
});

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
  frame = 0,
  frames: number[] = [],
  last = performance.now();
const camera = { position: [0, 0, 0], yaw: 0, pitch: 0 };

const view = createView({
  renderer, camera, settings,
  scene: () => ({ name: scenes[sceneName]?.label }),
  onStats: ({ stats, median }) => {
    if (!status.checkVisibility()) return;
    status.textContent = [
      `${world.blockCount} 个方块，${fragmentReferences()} 个跨格片段引用`,
      `${stats.loaded}/${stats.wanted} 个 r2region`,
      `GPU ${median?.toFixed(2) ?? "…"} ms，纹理 ${(renderer.textureBytes / 1024 ** 2).toFixed(1)} MiB`,
    ].join(" · ");
  },
});

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
  void view.cancelPhoto();
  void view.setWorld(true, () => world.chunkIndex()).catch((error) => view.hud.error(String(error)));
  frames = [];
  return new Promise((resolve) => (loaded = resolve));
}
select.onchange = () => loadScene(select.value);

function render(now: number) {
  requestAnimationFrame(render);
  if (!session) return;
  frames.push(now - last);
  if (frames.length > 240) frames.shift();
  last = now;
  renderer.objects.enabled = r2.specialEnabled;
  view.frame(now, session, {
    continuous: !settings.stillAccumulation,
    drawOptions: {
      ...drawOptions(),
      ...(r2.fixedTime == null ? {} : { time: r2.fixedTime }),
    },
  });
  const stats = session.stats;
  if (loaded && stats.loaded === stats.wanted && !stats.pending && !stats.nearPending) {
    loaded();
    loaded = null;
    renderer.resetTiming();
  }
  frame++;
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
window.addEventListener("pagehide", () => {
  view.dispose();
  session?.dispose();
  renderer.dispose();
});
Object.assign(globalThis, { r2 });
loadScene(params.get("scene") && scenes[params.get("scene")!] ? params.get("scene")! : "showcase");
requestAnimationFrame(render);
