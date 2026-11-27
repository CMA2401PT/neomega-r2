// 演示页：使用 MemoryWorld 与共享 UI 演示方块、光影、地图与活动部件。
import {
  createRenderer,
} from "neomega-r2-core";
import { MinecraftMemoryWorld as MemoryWorld, minecraftMemorySource } from "neomega-r2-mc";
import { createViewerWorld, type ViewerWorld, createStartup, createView, element, mountLayout, type ViewSettings } from "neomega-r2-frontend/ui";
import { scenes } from "./scenes.ts";

mountLayout();
const startup = createStartup();

const select = element<HTMLSelectElement>("scene");
const params = new URLSearchParams(location.search);
const settings: ViewSettings = {
  nearRadius: 4,
  farRadius: 8,
  speed: 32,
  resolution: "1",
  tier: "shading",
  time: 10,
  timeFlow: false,
  fog: true,
  stillAccumulation: false,
  photoScale: 1,
  photoSupersample: 1,
  exportScale: 1,
  exportSupersample: 1,
};
element<HTMLInputElement>("far-radius").min = "8";

try {
  const renderer = await createRenderer({
    assets: "/assets/",
    tier: settings.tier,
    onProgress: ({ label }) => startup.stage(label),
  });
  for (const [name, scene] of Object.entries(scenes)) select.add(new Option(scene.label, name));

  let world = new MemoryWorld();
  let displayed: ViewerWorld | null = null;
  let sceneName = "";
  const camera = { position: [0, 0, 0], yaw: 0, pitch: 0 };

  const view = createView({
    renderer,
    camera,
    settings,
    startup,
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
  const status = view.debugStatus;

  function fragmentReferences(): number {
    let count = 0;
    for (const region of displayed?.session.gpu.regions.values() ?? []) count += region.stats.fragmentReferences;
    return count;
  }

  function setCamera(eye: number[], target: number[]) {
    camera.position = [...eye];
    const d = target.map((v, i) => v - eye[i]);
    camera.yaw = Math.atan2(d[0], -d[2]);
    camera.pitch = Math.asin(d[1] / Math.hypot(...d));
    renderer.resetTiming();
  }

  function loadScene(name: string) {
    const scene = scenes[name];
    if (!scene) throw Error("未知场景 " + name);
    displayed?.session.dispose();
    sceneName = name;
    select.value = name;
    world = new MemoryWorld();
    scene.build(world);
    displayed = createViewerWorld(renderer, minecraftMemorySource(world), {
      onError: (message) => (status.textContent = message),
    });
    setCamera(scene.camera, scene.target);
    void view.cancelPhoto();
    void view.setWorld(true, () => world.chunkIndex()).catch((error) => view.hud.error(String(error)));
  }

  select.onchange = () => loadScene(select.value);
  loadScene(params.get("scene") && scenes[params.get("scene")!] ? params.get("scene")! : "showcase");

  function render(now: number) {
    requestAnimationFrame(render);
    if (displayed) view.frame(now, displayed);
  }
  window.addEventListener("pagehide", () => {
    view.dispose();
    displayed?.session.dispose();
    renderer.dispose();
  });
  requestAnimationFrame(render);
} catch (error) {
  startup.fail(error);
  console.error(error);
}
