import { appearanceDefaults, bindAppearance, lighting } from "./appearance.js";
import { bindPresets } from "./presets.js";
import { FrameRate } from "./frame-rate.js";
import { createHUD, element } from "./hud.js";
import { FullscreenMap } from "./map.js";
import { FlightControls } from "./controls.js";
import { bindMovePad } from "./movepad.js";
import { drawAxes } from "./overlay.js";
export { startupStage } from "./startup.js";
import { finishStartup } from "./startup.js";

import type { DrawOptions, Renderer, WorldSession, Tier } from "/r2/index.js";
import type { ViewOptions } from "./types.js";
export type { ViewSettings, ViewStats } from "./types.js";
interface FrameOptions {
  continuous?: boolean;
  drawOptions?: Partial<Pick<DrawOptions, "time" | "debug" | "hierarchy" | "fragments">>;
}

type Photo = ReturnType<Renderer["photograph"]> & { kind: "photo" | "export"; name: string; supersample: number; finishing: boolean };
export const TIER_NAMES = { voxel: "体素渲染器", basic: "基础渲染器", shading: "光影渲染器", accumulation: "累积渲染器" };
const DEFAULT_EXPORT_PIXELS = 24e6;
export function createView({ renderer, camera, settings, scene, switchBackend, onSettings, onStats, report = () => {} }: ViewOptions) {
  const backend = element<HTMLAnchorElement>("render-backend");
  backend.textContent = renderer.backend === "webgpu" ? "[webGPU]" : "[webGL]";
  if (switchBackend) {
    const next = renderer.backend === "webgpu" ? "webgl" : "webgpu";
    if (next === "webgpu" && (!isSecureContext || !navigator.gpu)) {
      backend.title = isSecureContext ? "当前浏览器未提供 WebGPU" : "使用本机地址或 HTTPS 可启用 WebGPU";
    } else {
      const url = new URL(location.href);
      url.searchParams.set("backend", next);
      backend.href = url.href;
      backend.title = "切换到 " + (next === "webgpu" ? "WebGPU" : "WebGL") + " 并重新加载页面";
      backend.setAttribute("aria-label", backend.title);
    }
  }
  const jump = (position: number[]) => { camera.position = position; };
  const map = new FullscreenMap({ renderer, camera, jump });
  const controls = new FlightControls(element<HTMLCanvasElement>("view"), camera);
  bindMovePad(element("movepad"), controls);
  const hud = createHUD({ settings, jump, changed: refreshSettings });
  const appearance = settings.appearance = { ...appearanceDefaults, ...settings.appearance };
  const { refresh: refreshAppearance, syncAngles } = bindAppearance(appearance, camera, refreshSettings);
  const releasePresets = bindPresets(settings, appearance, camera, () => {
    refreshAppearance();
    syncAngles();
    hud.syncInputs();
    refreshSettings();
  }, hud.error);
  const rate = new FrameRate();
  let currentView: ReturnType<FullscreenMap["frame"]> | null = null;
  let shownTier = settings.tier, last = performance.now(), statusAt = 0;
  let drawn = "";
  let wasOverview = false;
  let photo: Photo | null = null, photoWaiting = false;
  /** 渲染尺寸跟随原生屏幕像素或用户选择的固定倍数。 */
  function renderScale() {
    if (settings.resolution.startsWith("native-")) return devicePixelRatio * Number(settings.resolution.slice(7));
    return settings.resolution === "native"
      ? devicePixelRatio
      : Number(settings.resolution);
  }
  function frameSize(scale: number, pixelLimit = Infinity) {
    const factor = Math.min(
      scale,
      renderer.maxTextureSize / Math.max(innerWidth, innerHeight),
      Math.sqrt(pixelLimit / (innerWidth * innerHeight)),
    );
    return { width: Math.max(1, Math.round(innerWidth * factor)), height: Math.max(1, Math.round(innerHeight * factor)) };
  }
  // 预览之外的各档启动时不编译；第一次需要时在后台编译，期间画面继续使用已有的档。
  const taskStatus = element<HTMLOutputElement>("task-status");
  /** 正在编译的档与开始时间。 */
  const compiling = new Map<Tier | "photo", { promise: Promise<void>; since: number }>();
  // 程序链接完成后，驱动仍可能在第一次实际绘制时耗时数秒。
  let firstStillFrameReady = false;
  /** 首次静止累积绘制之后插入的 GPU 栅栏。 */
  let firstStillFrameFence: ReturnType<Renderer["fence"]> | null = null;
  /** 编译一档渲染器；已在编译或已经可用时不重复。失败时提示，之后再次需要时重试。
   * 提示先写进页面：渲染器会等它显示出来再开始编译，Windows 上编译期间页面可能停止刷新。 */
  function compileTier(tier: Tier, purpose?:"photo") {
    const key=purpose??tier;
    if (renderer.ready(tier,purpose)) return Promise.resolve();
    const existing = compiling.get(key);
    if (existing) return existing.promise;
    const since = performance.now(),
      seconds = () => +((performance.now() - since) / 1000).toFixed(1);
    report("compile-start", { tier });
    const promise = renderer
      .compile(tier,purpose)
      .then(() => report("compile-ready", { tier, seconds: seconds() }))
      .catch((error) => {
        report("compile-failed", { tier, seconds: seconds(), message: String(error.stack || error) });
        if (tier === "accumulation") {
          photoWaiting = false;
          setPhotoButton();
        }
        hud.error(`${TIER_NAMES[tier]}准备失败：${error.message || error}`);
        throw error;
      })
      .finally(() => {
        compiling.delete(key);
        drawn = "";
        showTaskStatus(performance.now());
      });
    promise.catch(() => {});
    compiling.set(key, { promise, since });
    showTaskStatus(since);
    return promise;
  }
  /** 底部提示：渲染器编译进度，或拍照、导出时的操作说明。 */
  function showTaskStatus(now: number) {
    const preview = compiling.get(settings.tier),
      accumulation = (photoWaiting && compiling.get("photo")) || compiling.get("accumulation"),
      elapsed = (job: {since:number}) => `已用 ${Math.floor((now - job.since) / 1000)} 秒`;
    const text = photo
      ? photo.kind === "export"
        ? `正在导出 · ${photo.samples}/${photo.supersample ** 2} 轮超采样，完成后自动保存 · 再按导出按钮或 Esc 取消`
        : photo.samples === 0
          ? "正在绘制首个拍照样本 · 按 Esc 放弃"
          : `拍照中 · 已累积 ${photo.samples} 样本，画面会越来越干净 · 满意时再按相机按钮保存，按 Esc 放弃`
      : preview
        ? `正在编译${TIER_NAMES[settings.tier]}，期间画面可能停顿 · ${elapsed(preview)}${shownTier !== settings.tier ? ` · 完成前继续使用${TIER_NAMES[shownTier]}` : ""}`
        : accumulation && (settings.stillAccumulation || photoWaiting)
          ? `正在编译累积渲染器 · ${elapsed(accumulation)}${photoWaiting ? " · 准备好后自动开始拍照，再按相机按钮取消" : ""}`
          : settings.stillAccumulation && renderer.ready("accumulation") && !firstStillFrameReady && !map.isOverview
            ? "正在准备首个累积画面 · 视角静止时开始绘制"
            : "";
    if (taskStatus.textContent !== text) taskStatus.textContent = text;
    taskStatus.hidden = !text;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".tier"))
      button.setAttribute("aria-busy", String(compiling.has(button.dataset.tier as Tier)));
  }
  /** 拍照与导出两个按钮的状态：进行中的一项按下，另一项停用。 */
  function setPhotoButton() {
    const kind = photo?.kind ?? (photoWaiting ? "photo" : null);
    element<HTMLButtonElement>("photo").setAttribute("aria-pressed", String(kind === "photo"));
    element<HTMLButtonElement>("photo").title = element<HTMLButtonElement>("photo").ariaLabel =
      photo?.kind === "photo" ? "保存照片" : photoWaiting ? "取消拍照" : "拍照（累积渲染器）";
    element<HTMLButtonElement>("photo").disabled = kind === "export";
    element<HTMLButtonElement>("export").setAttribute("aria-pressed", String(kind === "export"));
    element<HTMLButtonElement>("export").title = element<HTMLButtonElement>("export").ariaLabel =
      kind === "export" ? "取消导出" : "导出当前画面";
    element<HTMLButtonElement>("export").disabled = kind === "photo";
    element<HTMLOutputElement>("photo-progress").hidden = !photo;
  }
  // 拍照使用独立缓冲，不把 HUD 或标记写入照片。按下后画面上实时显示照片逐渐收敛，再按一次保存。
  element<HTMLButtonElement>("photo").onclick = () => {
    if (photo) return finishPhoto(true);
    if (photoWaiting) {
      photoWaiting = false;
      return setPhotoButton();
    }
    if (renderer.ready("accumulation","photo")) return startPhoto("photo");
    photoWaiting = true;
    setPhotoButton();
    compileTier("accumulation","photo").then(() => {
      if (photoWaiting) startPhoto("photo");
    }, () => {});
  };
  // 导出用当前预览档按固定网格超采样重画当前画面，取满后自动保存；进行中再按一次取消。
  element<HTMLButtonElement>("export").onclick = () => {
    if (photo) return cancelPhoto();
    startPhoto("export");
  };
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (photo || photoWaiting)) cancelPhoto();
  });
  /** 拍照用累积渲染器，导出用当前预览档。两者都按屏幕实际像素和各自的尺寸倍数取图。
   * 两者都拍最近一帧的视图，地图打开时就是俯视画面。 */
  function startPhoto(kind: Photo["kind"]) {
    const world = scene();
    photoWaiting = false;
    if (!currentView) return;
    const scale = kind === "photo" ? settings.photoScale : settings.exportScale;
    const { width, height } = frameSize(
      devicePixelRatio * scale,
      kind === "export" && scale <= 2 ? DEFAULT_EXPORT_PIXELS : Infinity,
    );
    element<HTMLOutputElement>("resolution-value").textContent = `${width}×${height}`;
    rate.reset();
    const supersample = kind === "export" ? settings.exportSupersample : settings.photoSupersample;
    const film = renderer.photograph(currentView.camera, {
      width,
      height,
      supersample,
      ...(kind === "export" ? { tier: shownTier } : {}),
      time: performance.now() / 1000,
      ...lighting(appearance, settings.time),
      ...(world.ocean == null ? {} : { ocean: world.ocean }),
      fog: currentView.fog,
      objects: currentView.objects,
    });
    const name = `${world.name || "天空"}-${new Date().toTimeString().slice(0, 8).replaceAll(":", "")}${kind === "export" ? `-${shownTier}` : ""}.png`;
    photo = Object.assign(film, { name, kind, supersample, finishing: false });
    setPhotoButton();
    showTaskStatus(performance.now());
  }
  /** 放弃正在进行或正在等待的拍照。 */
  function cancelPhoto() {
    photoWaiting = false;
    if (photo) return finishPhoto(false);
    setPhotoButton();
  }
  /** 保存时下载，放弃时直接释放照片缓冲；编码期间继续冻结场景。 */
  async function finishPhoto(download: boolean) {
    const job = photo;
    if (!job || job.finishing) return;
    job.finishing = true;
    if (download) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await job.png());
      link.download = job.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    job.dispose();
    photo = null;
    drawn = "";
    setPhotoButton();
    showTaskStatus(performance.now());
  }

  /** 同一帧循环消费当前视图的相机；世界、光照和累积仍使用同一条绘制路径。 */
  function frame(now: number, session: WorldSession | null, { continuous = false, drawOptions = {} }: FrameOptions = {}) {
    const world = scene();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (firstStillFrameFence?.ready()) {
      firstStillFrameFence.dispose();
      firstStillFrameFence = null;
      firstStillFrameReady = true;
      report("accumulation-first-frame-ready");
    }
    if (now - statusAt > 100) showTaskStatus(now);
    if (photo) {
      if (photo.finishing) return;
      photo.step();
      photo.present();
      element<HTMLOutputElement>("photo-progress").textContent = photo.kind === "export"
        ? `${photo.samples}/${photo.supersample ** 2}`
        : `${photo.samples} 样本`;
      const kind = photo.kind;
      if (photo.complete) finishPhoto(true);
      if (now - statusAt > 100) {
        statusAt = now;
        element<HTMLOutputElement>("fps").textContent = kind === "export" ? "导出中" : "拍照中";
      }
      return;
    }
    const view = map.frame(settings);
    if (view.overview !== wasOverview) rate.reset();
    wasOverview = view.overview;
    currentView = view;
    if (renderer.ready(settings.tier)) shownTier = settings.tier;
    controls.enabled = view.objects;
    controls.update(dt, Number(settings.speed));
    if (settings.timeFlow) {
      settings.time = (settings.time + (dt * 24) / 240) % 24;
      hud.settings();
    }
    session?.focus(view.center, { ...settings, nearPosition: camera.position });
    session?.publish();
    map.refresh(session);
    const { width, height } = frameSize(renderScale());
    const light = lighting(appearance, settings.time),
      objects = view.objects;
    const state = JSON.stringify([
      view,
      width,
      height,
      shownTier,
      settings.fog,
      light,
      renderer.version,
      objects,
      drawOptions,
    ]);
    const changed =
      continuous ||
      state !== drawn ||
      (objects && renderer.animating(view.camera, { width, height }));
    let rendered = false;
    // 静止时一直累积，直到画面再次变化；没有样本上限。
    const accumulating = settings.stillAccumulation && renderer.ready("accumulation");
    if (!view.overview && (changed || (accumulating && !firstStillFrameFence))) {
      if (!changed && !firstStillFrameReady) report("accumulation-first-frame-start");
      rendered = renderer.draw(view.camera, {
        width,
        height,
        tier: shownTier,
        accumulate: !changed,
        time: now / 1000,
        ...light,
        ...(world.ocean == null ? {} : { ocean: world.ocean }),
        fog: view.fog,
        objects,
        ...drawOptions,
      });
      if (rendered && !changed && !firstStillFrameReady) {
        firstStillFrameFence = renderer.fence();
      }
      if (rendered && session && session.stats.loaded > 0) finishStartup();
    }
    if (changed && (rendered || view.overview)) {
      if (rendered && renderer.backend === "webgpu") rate.track(renderer.frameDone);
      else rate.complete(now);
      drawn = state;
    } else if (!changed) rate.idle();
    if (now - statusAt > 100) {
      syncAngles();
      hud.position(camera.position);
      drawAxes(element<HTMLCanvasElement>("axes"), camera);
      element<HTMLOutputElement>("resolution-value").textContent = `${width}×${height}`;
      const fps = rate.fps;
      element<HTMLOutputElement>("fps").textContent = !changed && !rate.waiting
        ? rendered
          ? `累积 ${renderer.accumulated}`
          : "静止"
        : `${fps === null ? "—" : fps < 10 ? fps.toFixed(1) : Math.round(fps)} FPS`;
      if (session) {
        const stats = session.stats,
          times = renderer.times.sort((a, b) => a - b),
          median = times[Math.floor(times.length / 2)];
        hud.loading(stats, world.connection);
        onStats?.({ stats, shownTier, median, width, height });
      }
      statusAt = now;
    }
  }

  function refreshSettings() {
    compileTier(settings.tier);
    if (settings.stillAccumulation) compileTier("accumulation");
    hud.settings();
    renderer.resetTiming();
    rate.reset();
    drawn = "";
    onSettings?.();
  }
  refreshSettings();
  return {
    hud, map, frame, refreshSettings, cancelPhoto, frames: rate.intervals,
    get fps() { return rate.fps; },
    setWorld(loaded: boolean, readChunks?: () => ArrayBuffer | Promise<ArrayBuffer>) {
      drawn = "";
      rate.reset();
      currentView = null;
      hud.world({ loaded });
      return map.setWorld(readChunks);
    },
    dispose() {
      releasePresets();
      rate.reset();
      firstStillFrameFence?.dispose();
      cancelPhoto();
    },
  };
}
