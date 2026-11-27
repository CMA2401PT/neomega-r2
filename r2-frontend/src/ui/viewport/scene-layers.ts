import type { Camera } from "neomega-r2-core";
import type { SceneLayer } from "../../compositor/scene-layer.ts";
import { createBlockOutlineLayer } from "../../layers/block-outline-layer.ts";
import { createMarkLayer } from "../../layers/mark-layer.ts";
import type { OverlayStyle, SceneOverlay } from "../../layers/overlay-types.ts";
import { SceneMarks, type Stamp } from "../../layers/scene-overlay.ts";

/** 将宿主标记分给对应图层。置顶标记在普通标记之后绘制，二维概览只接收置顶内容。 */
export function createViewerLayers(device: GPUDevice, format: GPUTextureFormat) {
  const marks = new SceneMarks(), top = new SceneMarks(), overviewOutlines = new SceneMarks();
  // 普通世界没有标记时，连图层管线和缓冲都不必创建。
  let marksLayer: ReturnType<typeof createMarkLayer> | undefined;
  let topLayer: ReturnType<typeof createMarkLayer> | undefined;
  let outlines: ReturnType<typeof createBlockOutlineLayer> | undefined;
  const group = (style?: OverlayStyle) => style?.alwaysVisible ? top : marks;
  const overlay: SceneOverlay = {
    marker: (point, style) => group(style).marker(point, style),
    line: (points, style) => group(style).line(points, style),
    polygon: (points, style) => group(style).polygon(points, style),
    blockFace: (hit, style) => group(style).blockFace(hit, style),
    blockOutline(position, style) {
      outlines ??= createBlockOutlineLayer(device, format);
      const outline = outlines.blockOutline(position, style);
      if (!style?.alwaysVisible) return outline;
      const mapOutline = overviewOutlines.blockOutline(position, style);
      return { remove() { outline.remove(); mapOutline.remove(); } };
    },
  };
  let mapKey = "", mapStamps: Stamp[] = [];
  return {
    overlay,
    active(): SceneLayer[] {
      const layers: SceneLayer[] = [];
      if (marks.size) layers.push(marksLayer ??= createMarkLayer(device, format, marks));
      if (outlines?.size) layers.push(outlines);
      if (top.size) layers.push(topLayer ??= createMarkLayer(device, format, top));
      return layers;
    },
    overview(camera: Camera, width: number, height: number): Stamp[] {
      const ratio = Math.min(devicePixelRatio, device.limits.maxTextureDimension2D / Math.max(width, height));
      const key = JSON.stringify([camera, width, height, ratio, top.version, overviewOutlines.version]);
      if (key !== mapKey) {
        mapStamps = [overviewOutlines, top].flatMap(store =>
          store.stamps(camera, width, height, ratio, true, width / height));
        mapKey = key;
      }
      return mapStamps;
    },
    clear() {
      for (const store of [marks, top, overviewOutlines]) store.clear();
      outlines?.clear();
      mapStamps = [];
    },
    dispose() {
      marksLayer?.dispose();
      topLayer?.dispose();
      outlines?.dispose();
    },
  };
}
