import type { Camera, RenderOptions, Renderer, Tier, WorldSession } from "neomega-r2-core";
import type { CaptureSession } from "neomega-r2-core";
import { createCompositor } from "../compositor/compositor.ts";
import { SceneMarks, type Stamp } from "../compositor/scene-overlay.ts";
import { appearanceDefaults, bindAppearance, lighting } from "./appearance.ts";
import { drawAxes } from "./axes.ts";
import { FlightControls } from "./controls.ts";
import { element } from "./dom.ts";
import { FrameRate } from "./frame-rate.ts";
import { createHUD } from "./hud.ts";
import { FullscreenMap } from "./map.ts";
import { bindMovePad } from "./movepad.ts";
import { bindPresets, windowResolution } from "./presets.ts";
import { mountRenderDebug } from "./render-debug.ts";
import { createStartup } from "./startup.ts";
import type { ViewOptions } from "./types.ts";

export type { ViewOptions, ViewSettings, ViewStats } from "./types.ts";

interface FrameOptions {
  continuous?: boolean;
  drawOptions?: Partial<Pick<RenderOptions, "time" | "debug" | "hierarchy" | "fragments">>;
}

interface PhotoJob {
  capture: CaptureSession;
  kind: "photo" | "export";
  tier: Tier;
  name: string;
  supersample: number;
  finishing: boolean;
}

export const TIER_NAMES = { voxel: "体素渲染器", basic: "基础渲染器", shading: "光影渲染器", accumulation: "累积渲染器" };
const DEFAULT_EXPORT_PIXELS = 24e6;

export function createView({ renderer, camera, settings, startup: externalStartup, scene, onSettings, onStats, report = () => {} }: ViewOptions) {
  const startup = externalStartup ?? createStartup();
  const viewCanvas = element<HTMLCanvasElement>("view");
  const mapCanvas = element<HTMLCanvasElement>("map-overlay");
  const compositor = createCompositor(renderer.device, viewCanvas);
  const marks = new SceneMarks();
  const jump = (position: number[]) => { camera.position = position; };
  const map = new FullscreenMap({ renderer, camera, jump, overlay: marks });
  let activeSession: WorldSession | null = null;
  let pickRequest = 0;
  const entityDialog = element<HTMLDialogElement>("block-entity");
  const controls = new FlightControls(viewCanvas, camera, event => {
    const source = activeSession?.source;
    if (!source?.snbtAt || map.open) return;
    const request = ++pickRequest;
    const rect = viewCanvas.getBoundingClientRect();
    const pixel = {
      width: rect.width,
      height: rect.height,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      objects: true,
      voxel: shownTier === "voxel",
    };
    void renderer.pick(structuredClone(displayedCamera ?? camera), pixel).then(hit => {
      if (!hit || request !== pickRequest || activeSession?.source !== source || map.open) return;
      const snbt = source.snbtAt?.(hit.position, hit.objectKey);
      if (snbt === undefined) return;
      element("block-entity-title").textContent = (hit.objectKey?.startsWith("entity/") ? "实体 SNBT · " : "方块 SNBT · ") + hit.position.join(", ");
      element("block-entity-text").textContent = snbt;
      entityDialog.showModal();
    }).catch(error => hud.error(String(error)));
  });
  const events = new AbortController();
  bindMovePad(element("movepad"), controls, events.signal);
  settings.resolution = windowResolution(settings.resolution);
  if (settings.superResolution !== "cnn-xs" && settings.superResolution !== "cnn-s") settings.superResolution = "off";
  settings.saveSuperResolution2x ??= false;
  settings.accumulationFilter ??= "light";
  const debugPanel = mountRenderDebug(element("render-debug"), renderer.resetTiming);
  const renderInfo = element("render-info");
  const hud = createHUD({ settings, jump, changed: refreshSettings });
  const appearance = settings.appearance = {
    ...appearanceDefaults,
    autoSunColor: settings.appearance ? (settings.appearance.autoSunColor ?? true) : appearanceDefaults.autoSunColor,
    ...settings.appearance,
  };
  const { refresh: refreshAppearance, syncAngles } = bindAppearance(appearance, camera, refreshSettings);
  const releasePresets = bindPresets(settings, appearance, camera, () => {
    refreshAppearance();
    syncAngles();
    hud.syncInputs();
    refreshSettings();
  }, hud.error);
  const rate = new FrameRate();
  let currentView: ReturnType<FullscreenMap["frame"]> | null = null;
  let shownTier = settings.tier, last: number | undefined, statusAt = 0;
  let drawn = "";
  let wasOverview = false;
  let photo: PhotoJob | null = null, photoWaiting = false;
  let displayedCamera: Camera | undefined;
  let displayedAspect = 1;
  let overlayKey = "";
  let overlayStamps: Stamp[] = [];

  function frameSize(scale: number, pixelLimit = Infinity) {
    const factor = Math.min(
      scale,
      renderer.maxTextureSize / Math.max(innerWidth, innerHeight),
      Math.sqrt(pixelLimit / (innerWidth * innerHeight)),
    );
    return { width: Math.max(1, Math.round(innerWidth * factor)), height: Math.max(1, Math.round(innerHeight * factor)) };
  }
  const sizeReadout = element<HTMLOutputElement>("resolution-value");
  let sampleWidth = 0, sampleHeight = 0;
  /** 显示当前画面的采样宽高，开启超分时仍沿用射线采样尺寸。 */
  function showSampleSize(width: number, height: number) {
    if (width === sampleWidth && height === sampleHeight) return;
    sampleWidth = width;
    sampleHeight = height;
    sizeReadout.textContent = `${width}×${height}`;
  }
  // 预览之外的各档启动时不编译；第一次需要时在后台编译，期间画面继续使用已有的档。
  const taskStatus = element<HTMLOutputElement>("task-status");
  let stopped = false;
  function stopRendering(reason: string) {
    if (stopped) return;
    stopped = true;
    renderer.cancelAccumulation();
    taskStatus.hidden = true;
    element("photo-progress").hidden = true;
    element("fps").textContent = "绘制已停止";
    for (const id of ["photo", "export"]) element<HTMLButtonElement>(id).disabled = true;
    startup.fail(reason + " 请刷新页面重试。如果仍无法连接显卡，请重启浏览器或桌面查看器。", "绘制已停止");
  }
  void renderer.failure.then(stopRendering);
  /** 正在编译的档与开始时间。 */
  const compiling = new Map<Tier | "photo", { promise: Promise<void>; since: number }>();
  let firstStillFrameReady = false;
  let showingDepth = false;

  function compileTier(tier: Tier, purpose?: "photo") {
    const key = purpose ?? tier;
    if (renderer.ready(tier, purpose)) return Promise.resolve();
    const existing = compiling.get(key);
    if (existing) return existing.promise;
    const since = performance.now(),
      seconds = () => +((performance.now() - since) / 1000).toFixed(1);
    report("compile-start", { tier });
    const promise = renderer
      .compile(tier, purpose)
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

  function showTaskStatus(now: number) {
    if (stopped) return;
    const preview = compiling.get(settings.tier),
      accumulation = (photoWaiting && compiling.get("photo")) || compiling.get("accumulation"),
      elapsed = (job: { since: number }) => `已用 ${Math.floor((now - job.since) / 1000)} 秒`;
    let text = photo
      ? photo.kind === "export"
        ? `正在导出 · ${photo.capture.samples}/${photo.supersample ** 2} 轮超采样，完成后自动保存 · 再按导出按钮或 Esc 取消`
        : photo.capture.samples === 0
          ? "正在绘制首个拍照样本 · 按 Esc 放弃"
          : `拍照中 · 已累积 ${photo.capture.samples} 样本，画面会越来越干净 · 满意时再按相机按钮保存，按 Esc 放弃`
      : preview
        ? `正在编译${TIER_NAMES[settings.tier]}，期间画面可能停顿 · ${elapsed(preview)}${shownTier !== settings.tier ? ` · 完成前继续使用${TIER_NAMES[shownTier]}` : ""}`
        : accumulation && (settings.stillAccumulation || photoWaiting)
          ? `正在编译累积渲染器 · ${elapsed(accumulation)}${photoWaiting ? " · 准备好后自动开始拍照，再按相机按钮取消" : ""}`
          : !showingDepth && settings.stillAccumulation && renderer.ready("accumulation") && !firstStillFrameReady && !map.isOverview
            ? "正在准备首个累积画面 · 视角静止时开始绘制"
            : "";
    const since = renderer.waitingSince;
    if (since !== null && now - since >= 10000)
      text = `正在等待显卡完成当前绘制，已等 ${Math.floor((now - since) / 1000)} 秒。如果持续没有进展，请刷新页面后降低绘制分辨率。`;
    if (taskStatus.textContent !== text) taskStatus.textContent = text;
    taskStatus.hidden = !text;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".tier"))
      button.setAttribute("aria-busy", String(compiling.has(button.dataset.tier as Tier)));
  }

  function setPhotoButton() {
    if (stopped) return;
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

  element<HTMLButtonElement>("photo").onclick = () => {
    if (photo) return finishPhoto(true);
    if (photoWaiting) {
      photoWaiting = false;
      return setPhotoButton();
    }
    if (renderer.ready("accumulation", "photo")) return startPhoto("photo");
    photoWaiting = true;
    setPhotoButton();
    compileTier("accumulation", "photo").then(() => {
      if (photoWaiting) startPhoto("photo");
    }, () => {});
  };
  element<HTMLButtonElement>("export").onclick = () => {
    if (photo) return cancelPhoto();
    startPhoto("export");
  };
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (photo || photoWaiting)) cancelPhoto();
  }, { signal: events.signal });

  function startPhoto(kind: PhotoJob["kind"]) {
    if (stopped) return;
    const world = scene();
    photoWaiting = false;
    if (!currentView) return;
    const scale = kind === "photo" ? settings.photoScale : settings.exportScale;
    const { width, height } = frameSize(
      scale,
      kind === "export" && scale <= 2 ? DEFAULT_EXPORT_PIXELS : Infinity,
    );
    const saveSuperResolution2x = settings.superResolution !== "off" && settings.saveSuperResolution2x;
    if (saveSuperResolution2x && 2 * Math.max(width, height) > renderer.maxTextureSize) {
      hud.error("2× PNG 超过设备最大边长，请降低输出尺寸或关闭「保存 2× 超分原图」。");
      setPhotoButton();
      return;
    }
    renderer.cancelAccumulation();
    rate.reset();
    const supersample = kind === "export" ? settings.exportSupersample : settings.photoSupersample;
    const tier: Tier = kind === "export" ? shownTier : "accumulation";
    const capture = renderer.createCapture(currentView.camera, {
      width,
      height,
      supersample,
      tier,
      time: performance.now() / 1000,
      ...lighting(appearance, settings.time),
      ...(world.ocean == null ? {} : { ocean: world.ocean }),
      fog: currentView.fog,
      objects: currentView.objects,
    });
    const name = `${world.name || "天空"}-${new Date().toTimeString().slice(0, 8).replaceAll(":", "")}${kind === "export" ? `-${shownTier}` : ""}${saveSuperResolution2x ? "-2x" : ""}.png`;
    showSampleSize(width, height);
    overlayStamps = [];
    overlayKey = "";
    photo = { capture, name, kind, tier, supersample, finishing: false };
    setPhotoButton();
    showTaskStatus(performance.now());
  }

  function cancelPhoto() {
    photoWaiting = false;
    if (photo) return finishPhoto(false);
    setPhotoButton();
  }

  async function finishPhoto(download: boolean) {
    const job = photo;
    if (!job || job.finishing) return;
    job.finishing = true;
    try {
      if (download && job.capture.frame) {
        const superResolution = settings.superResolution ?? "off";
        const blob = await compositor.renderToPNG(job.capture.frame, {
          denoise: job.tier === "accumulation" ? (settings.accumulationFilter ?? "light") : "off",
          superResolution,
          saveSuperResolution2x: superResolution !== "off" && !!settings.saveSuperResolution2x,
        });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = job.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
    } catch (error) {
      hud.error("保存 PNG 失败：" + error);
    } finally {
      job.capture.dispose();
      photo = null;
      drawn = "";
      setPhotoButton();
      showTaskStatus(performance.now());
    }
  }

  function updateStamps(camera: Camera, overview: boolean, aspect: number): Stamp[] {
    const width = innerWidth,
      height = innerHeight;
    if (!marks.size || (!overview && !renderer.frame?.depth && marks.needsDepth)) {
      overlayKey = "";
      overlayStamps = [];
      return overlayStamps;
    }
    const ratio = Math.min(devicePixelRatio, renderer.maxTextureSize / Math.max(width, height));
    const key = JSON.stringify([camera, marks.version, width, height, ratio, aspect, overview]);
    if (key !== overlayKey) {
      overlayStamps = marks.stamps(camera, width, height, ratio, overview, aspect);
      overlayKey = key;
    }
    return overlayStamps;
  }

  function frame(now: number, session: WorldSession | null, options?: FrameOptions) {
    activeSession = session;
    if (stopped) return;
    try {
      drawFrame(now, session, options);
    } catch (error) {
      stopRendering(String(error));
    }
  }

  function drawFrame(now: number, session: WorldSession | null, { continuous = false, drawOptions: overrides }: FrameOptions = {}) {
    const world = scene();
    const elapsedSeconds = (now - (last ?? now)) / 1000;
    last = now;
    if (!firstStillFrameReady && renderer.accumulated > 0) {
      firstStillFrameReady = true;
      report("accumulation-first-frame-ready");
    }
    if (now - statusAt > 100) showTaskStatus(now);
    if (photo) {
      if (photo.finishing) return;
      photo.capture.step();
      if (photo.capture.frame) {
        const superResolution = settings.superResolution ?? "off";
        compositor.present(photo.capture.frame, {
          denoise: photo.tier === "accumulation" ? (settings.accumulationFilter ?? "light") : "off",
          superResolution,
          displaySize: superResolution !== "off" ? frameSize(devicePixelRatio) : undefined,
        });
      }
      element<HTMLOutputElement>("photo-progress").textContent = photo.kind === "export"
        ? `${photo.capture.samples}/${photo.supersample ** 2}`
        : `${photo.capture.samples} 样本`;
      const kind = photo.kind;
      if (photo.capture.complete) finishPhoto(true);
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
    controls.update(Math.min(0.05, elapsedSeconds), Number(settings.speed));
    if (settings.timeFlow) {
      settings.time = (settings.time + (elapsedSeconds * 24) / 240) % 24;
      hud.settings();
    }
    session?.focus(view.center, { ...settings, nearPosition: camera.position });
    session?.publish();
    map.refresh(session);
    const { width, height } = frameSize(Number(settings.resolution));
    const screenSize = frameSize(devicePixelRatio);
    const light = lighting(appearance, settings.time),
      objects = view.objects;
    const drawOptions = { ...debugPanel.drawOptions(), ...overrides };
    showingDepth = drawOptions.debug === 3;
    const superResolution = showingDepth ? "off" : (settings.superResolution ?? "off");
    const overlayDepth = !view.overview && marks.needsDepth;
    const state = JSON.stringify([
      overlayDepth,
      view,
      width,
      height,
      screenSize,
      shownTier,
      settings.fog,
      light,
      renderer.version,
      objects,
      drawOptions,
    ]);
    const changed =
      continuous ||
      settings.timeFlow ||
      state !== drawn ||
      (objects && renderer.animating(view.camera, { width, height }));
    let rendered = false;
    const accumulating = !showingDepth && settings.stillAccumulation && renderer.ready("accumulation");
    if (view.overview && changed) renderer.cancelAccumulation();
    if (!view.overview && (changed || accumulating)) {
      rendered = renderer.render(view.camera, {
        width,
        height,
        tier: shownTier,
        depthOutput: overlayDepth || undefined,
        accumulate: !changed,
        time: now / 1000,
        ...light,
        ...(world.ocean == null ? {} : { ocean: world.ocean }),
        fog: view.fog,
        objects,
        ...drawOptions,
      });
      if (rendered) {
        showSampleSize(width, height);
        if (changed) {
          displayedCamera = { ...view.camera, position: [...view.camera.position] };
          displayedAspect = width / height;
        }
      }
      if (rendered && !changed && !firstStillFrameReady) {
        report("accumulation-first-frame-start");
      }
      if (rendered && session && session.stats.loaded > 0) startup.finish();
    }
    if (view.overview) {
      const stamps = updateStamps(view.camera, true, innerWidth / innerHeight);
      const ctx = mapCanvas.getContext("2d")!;
      for (const { image, rect: [x, y, w, h] } of stamps) {
        ctx.drawImage(image, x, y, w, h);
      }
    } else if (renderer.frame && displayedCamera) {
      const stamps = updateStamps(displayedCamera, false, displayedAspect);
      const denoise = renderer.accumulated > 0 && !showingDepth ? (settings.accumulationFilter ?? "light") : "off";
      const displaySize = superResolution !== "off"
        ? screenSize
        : stamps.length
          ? { width: Math.max(width, screenSize.width), height: Math.max(height, screenSize.height) }
          : undefined;
      compositor.present(renderer.frame, {
        denoise,
        superResolution,
        displaySize,
        overlay: stamps.length
          ? { stamps, cssWidth: innerWidth, cssHeight: innerHeight, perspective: displayedCamera.ortho === undefined }
          : null,
      });
    }
    if (changed && (rendered || view.overview)) {
      if (rendered) rate.track(renderer.frameDone);
      else rate.complete(now);
      drawn = state;
    } else if (!changed) rate.idle();
    if (now - statusAt > 100) {
      syncAngles();
      hud.position(camera.position);
      drawAxes(element<HTMLCanvasElement>("axes"), camera);
      const fps = rate.fps;
      const tiles = renderer.tileProgress;
      element<HTMLOutputElement>("fps").textContent = !changed && !rate.waiting
        ? accumulating && !view.overview
          ? `静止（累积 ${renderer.accumulated} 样本${tiles ? ` · 当前 ${tiles.done}/${tiles.total} 块` : ""}）`
          : "静止"
        : `${fps === null ? "—" : fps < 10 ? fps.toFixed(1) : Math.round(fps)} FPS`;
      if (session) {
        const stats = session.stats,
          times = renderer.times.sort((a, b) => a - b),
          median = times[Math.floor(times.length / 2)];
        if (stats.failed > 0) startup.finish();
        hud.loading(stats, world.connection);
        if (renderInfo.matches(":popover-open")) {
          const [x, y, z] = session.gpu.size;
          element("render-info-tier").textContent = TIER_NAMES[shownTier];
          element("render-info-near").textContent = `${settings.nearRadius} 区块`;
          element("render-info-far").textContent = `${settings.farRadius} 区块`;
          element("render-info-window").textContent = `${x}×${z}×${y} 方块`;
          element("render-info-sections").textContent = String(stats.sections);
          element("render-info-regions").textContent = `${stats.loaded} / ${stats.wanted}`;
          element("render-info-pending").textContent = `${stats.pending} / ${stats.failed}`;
          element("render-info-objects").textContent = String(stats.objects);
          element("render-info-unknown").textContent = String(stats.unknownBlocks);
          element("render-info-bytes").textContent = `${(stats.bytes / 1024 ** 2).toFixed(1)} MiB`;
          element("render-info-pool").textContent = `${(stats.usedBytes / 1024 ** 2).toFixed(1)} MiB`;
          element("render-info-memory").textContent = `${((renderer.textureBytes + compositor.bytes) / 1024 ** 2).toFixed(1)} MiB`;
          element("render-info-time").textContent = median === undefined ? "—" : `${median.toFixed(2)} ms`;
          const outWidth = superResolution !== "off" ? screenSize.width : width;
          const outHeight = superResolution !== "off" ? screenSize.height : height;
          element("render-info-pixels").textContent = outWidth !== width || outHeight !== height
            ? `${width}×${height} → ${outWidth}×${outHeight}`
            : `${width}×${height}`;
        }
        onStats?.({ stats, shownTier, median, width, height });
      }
      statusAt = now;
    }
  }

  function refreshSettings(key?: keyof typeof settings) {
    if (settings.timeFlow && appearance.manualSun) {
      if (key === "timeFlow") {
        appearance.manualSun = false;
        refreshAppearance();
      } else {
        settings.timeFlow = false;
      }
    }
    element<HTMLInputElement>("save-sr-2x").disabled = settings.superResolution === "off";
    if (key === "saveSuperResolution2x") { onSettings?.(); return; }
    // 降噪和超分只影响合成输出。静止累积的下一帧直接用新设置显示，已有样本可继续使用。
    if (key === "accumulationFilter") {
      onSettings?.();
      return;
    }
    if (key === "superResolution" && settings.stillAccumulation && renderer.ready("accumulation")) {
      renderer.resetTiming();
      onSettings?.();
      return;
    }
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
    overlay: marks,
    debugStatus: debugPanel.status,
    hud, map, frame, refreshSettings, cancelPhoto, frames: rate.intervals,
    get fps() { return rate.fps; },
    setWorld(loaded: boolean, readChunks?: () => ArrayBuffer | Promise<ArrayBuffer>) {
      pickRequest++;
      entityDialog.close();
      activeSession = null;
      drawn = "";
      rate.reset();
      currentView = null;
      displayedCamera = undefined;
      overlayKey = "";
      overlayStamps = [];
      marks.clear();
      hud.world({ loaded });
      return map.setWorld(readChunks);
    },
    dispose() {
      activeSession = null;
      pickRequest++;
      entityDialog.close();
      stopped = true;
      startup.finish();
      renderer.cancelAccumulation();
      marks.clear();
      releasePresets();
      rate.reset();
      cancelPhoto();
      map.dispose();
      controls.dispose();
      events.abort();
      compositor.dispose();
    },
  };
}
