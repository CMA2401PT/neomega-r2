import { createViewerWorld, type ViewerWorld } from "./world.ts";
import {
  createRenderer,
  type Camera,
} from "neomega-r2-core";
import { element, mountLayout } from "../layout/dom.ts";
import type { Frontend, MountOptions, Scene } from "./types.ts";
import { materialControls } from "../settings/material-controls.ts";
import { createStartup } from "../layout/startup.ts";
import type { ViewSettings } from "../settings/settings.ts";
import { createView } from "../viewport/view.ts";


/** 在隔离文档中挂载标准查看界面；换场景只替换会话与地图数据。 */
export async function start(options: MountOptions): Promise<Frontend> {
  mountLayout({
    leadingActions: "",
    actions: "",
    settingsExtra: '<div id="material-controls"></div>',
    helpExtra: options.helpHTML ?? "",
  });
  const startup = createStartup();
  const {readResource} = options;
  const renderer = await createRenderer({
    readResource,
    onProgress: ({ label }) => startup.stage(label),
  });
  const settings: ViewSettings = {
    nearRadius: 4,
    farRadius: 8,
    resolution: "1",
    speed: 32,
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
  const camera: Camera = { position: [8, 8, 20], yaw: 0, pitch: -0.35 };
  let scene: Scene = options;
  element<HTMLInputElement>("far-radius").min = "8";
  const view = createView({ renderer, camera, settings, startup, scene: () => scene });
  let world: ViewerWorld | undefined,
    frame = 0,
    closed = false;
  let changes = Promise.resolve();
  // 会话在安装透明分类时仍会用到旧区域。按调用次序完成安装和换场景。
  function changeSceneState(job: () => void | Promise<void>) {
    const result = changes.then(() => {
      if (closed) throw Error("查看界面已关闭");
      return job();
    });
    changes = result.catch(() => {});
    return result;
  }
  const materials = materialControls(element("material-controls"), (set) =>
    changeSceneState(async () => {
      if (world) await world.session.setTextures(set);
      else renderer.setTextures(set);
    }),
    { loadRecipe: options.loadRecipe },
  );
  function moveCamera(next: NonNullable<Scene["camera"]>) {
    Object.assign(camera, next, { position: [...next.position] });
    renderer.resetTiming();
  }
  function setScene(next: Scene) {
    return changeSceneState(async () => {
      await view.cancelPhoto();
      if (!world || next.source !== scene.source) {
        world?.session.dispose();
        world = createViewerWorld(renderer, next.source, {
          registry:options.registry,
          onError: (message) => view.hud.error(message),
        });
      }
      scene = next;
      if (next.camera) moveCamera(next.camera);
      void view.setWorld(true, next.chunks).catch((error) => {
        if (!closed && scene === next) view.hud.error(String(error));
      });
    });
  }
  function draw(now: number) {
    view.frame(now, world ?? null);
    frame = requestAnimationFrame(draw);
  }
  function dispose() {
    closed = true;
    cancelAnimationFrame(frame);
    materials.dispose();
    view.dispose();
    world?.session.dispose();
    renderer.dispose();
  }
  try {
    if (options.actions) element("host-actions").append(options.actions);
    await setScene(options);
    frame = requestAnimationFrame(draw);
    return { overlay: view.overlay, moveCamera, setScene, setMaterialPack: materials.apply, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
