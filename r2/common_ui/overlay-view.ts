// 把持久标记与已经显示的预览相机配对。地图概览是二维底图，可以直接合成同一批置顶标记。
import type { Camera, Renderer } from "/r2/index.js";
import { gpuOverlay } from "./overlay-gpu.js";
import { SceneMarks, type Stamp } from "./scene-overlay.js";

export class OverlayView {
  readonly marks = new SceneMarks();
  private readonly renderer: Renderer;
  private readonly map: HTMLCanvasElement;
  private gpuCanvas?: HTMLCanvasElement;
  private gpu?: ReturnType<typeof gpuOverlay>;
  private displayed?: Camera;
  private displayedAspect = 1;
  private key = "";
  private stamps: Stamp[] = [];
  private visible = false;

  constructor(renderer: Renderer, map: HTMLCanvasElement) {
    this.renderer = renderer;
    this.map = map;
  }

  /** 仅在核心接受了新预览时保存相机；鼠标、地图拖动或被跳过的绘制不会提前改变投影。 */
  present(camera: Camera, preview: boolean, previewAspect: number, overview: boolean) {
    if (preview) {
      this.displayed = { ...camera, position: [...camera.position] };
      this.displayedAspect = previewAspect;
    }
    const view = overview ? camera : this.displayed;
    const width = innerWidth,
      height = innerHeight;
    const r = this.renderer;
    if (!view || !this.marks.size || (!overview && !r.depth && this.marks.needsDepth)) {
      if (this.visible) {
        this.hide();
        this.release();
      }
      return;
    }
    const ratio = Math.min(devicePixelRatio, r.maxTextureSize / Math.max(width, height));
    const aspect = overview ? width / height : this.displayedAspect;
    const key = JSON.stringify([view, this.marks.version, width, height, ratio, aspect, overview]);
    const changed = this.key !== key;
    if (changed) {
      this.stamps = this.marks.stamps(view, width, height, ratio, overview, aspect);
      this.key = key;
    }
    if (overview) {
      if (this.gpuCanvas) this.gpuCanvas.hidden = true;
      const ctx = this.map.getContext("2d")!;
      for (const {
        image,
        rect: [x, y, w, h],
      } of this.stamps)
        ctx.drawImage(image, x, y, w, h);
    } else {
      if (!changed && !preview) return;
      if (!this.gpuCanvas) {
        this.gpuCanvas = document.createElement("canvas");
        this.gpuCanvas.className = "scene-overlay";
        this.gpuCanvas.setAttribute("aria-hidden", "true");
        this.map.after(this.gpuCanvas);
        this.gpu = gpuOverlay(r.device, this.gpuCanvas);
      }
      this.gpuCanvas.hidden = false;
      const w = Math.round(width * ratio),
        h = Math.round(height * ratio);
      if (this.gpuCanvas.width !== w || this.gpuCanvas.height !== h) {
        this.gpuCanvas.width = w;
        this.gpuCanvas.height = h;
      }
      this.gpu!.draw(this.stamps, r.depth?.texture, width, height, view.ortho === undefined);
    }
    this.visible = true;
  }
  hide() {
    if (this.gpuCanvas) this.gpuCanvas.hidden = true;
    this.visible = false;
    this.key = "";
  }
  private release() {
    this.gpu?.dispose();
    this.gpu = undefined;
    this.gpuCanvas?.remove();
    this.gpuCanvas = undefined;
    this.stamps = [];
  }
  reset() {
    this.hide();
    this.release();
    this.displayed = undefined;
    this.marks.clear();
  }
}
