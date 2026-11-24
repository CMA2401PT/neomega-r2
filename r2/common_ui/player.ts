import {
  createRenderer,
  openMaterialPack,
  ObjectRegistry,
  enchantingBook,
  WorldSession,
  type Camera,
} from "/r2/r2-core.js";
import type { Frontend, MountOptions, Scene } from "/r2/frontend-types.js";
import { createView, type ViewSettings } from "./view.js";
import { element } from "./hud.js";
import { startupStage } from "./startup.js";
import { materialControls } from "./material-controls.js";

declare const R2_DEFAULT_MATERIALS: string;

/** 一个页面实例拥有一个渲染器，换场景只替换会话与地图数据。 */
export async function start(options: MountOptions): Promise<Frontend> {
  const readResource = openMaterialPack(Uint8Array.from(atob(R2_DEFAULT_MATERIALS), (c) => c.charCodeAt(0)));
  const renderer = await createRenderer(element<HTMLCanvasElement>("view"), {
    readResource,
    useWebGPU: options.useWebGPU ?? (isSecureContext && !!navigator.gpu),
    onProgress: ({ label }) => startupStage(label),
  });
  const bookURL = URL.createObjectURL(await (await readResource("book.png")).blob());
  const registry =
    options.registry ?? new ObjectRegistry().register("enchanting_book", () => enchantingBook(bookURL));
  const settings: ViewSettings = {
    nearRadius: 4,
    farRadius: 8,
    resolution: "native",
    speed: 32,
    tier: "shading",
    time: 10,
    timeFlow: false,
    fog: true,
    stillAccumulation: false,
    photoScale: 2,
    photoSupersample: 1,
    exportScale: 2,
    exportSupersample: 1,
  };
  const camera: Camera = { position: [8, 8, 20], yaw: 0, pitch: -0.35 };
  let scene: Scene = options;
  element<HTMLInputElement>("far-radius").min = "8";
  const view = createView({ renderer, camera, settings, scene: () => scene });
  let session: WorldSession | undefined,
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
      if (session) await session.setTextures(set);
      else renderer.setTextures(set);
    }),
  );
  function moveCamera(next: NonNullable<Scene["camera"]>) {
    Object.assign(camera, next, { position: [...next.position] });
    renderer.resetTiming();
  }
  function setScene(next: Scene) {
    return changeSceneState(async () => {
      await view.cancelPhoto();
      if (!session || next.source !== scene.source) {
        session?.dispose();
        session = new WorldSession(renderer, next.source, {
          registry,
          onError: (message) => view.hud.error(message),
        });
      }
      scene = next;
      if (next.camera) moveCamera(next.camera);
      // 占用表只供地图使用，大地图的扫描可以和首帧并行。
      void view.setWorld(true, next.chunks).catch((error) => {
        if (!closed && scene === next) view.hud.error(String(error));
      });
    });
  }
  function draw(now: number) {
    view.frame(now, session ?? null);
    frame = requestAnimationFrame(draw);
  }
  function dispose() {
    closed = true;
    cancelAnimationFrame(frame);
    materials.dispose();
    view.dispose();
    session?.dispose();
    renderer.dispose();
    URL.revokeObjectURL(bookURL);
  }
  try {
    const help = document.createElement("template");
    help.innerHTML = options.helpHTML ?? "";
    document.querySelector('slot[name="help-extra"]')!.replaceWith(help.content);
    if (options.actions) element("host-actions").append(options.actions);
    await setScene(options);
    frame = requestAnimationFrame(draw);
    return { moveCamera, setScene, setMaterialPack: materials.apply, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
