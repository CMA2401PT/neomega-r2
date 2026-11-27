import type { Camera } from "neomega-r2-core";

/** 宿主提供显示相机和 CSS 视口，合成器补上实际输出像素与只读场景深度。 */
export interface LayerCamera {
  readonly camera: Camera;
  readonly aspect: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
}
export interface LayerView extends LayerCamera {
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** 左上角为原点，深度以相机前向的方块距离计，负值表示没有命中。 */
  readonly sceneDepth: GPUTextureView | null;
}

/** 合成器按列表顺序调用 draw。图层自行持有资源并设置绘制管线，通道由合成器结束。 */
export interface SceneLayer {
  /** 内容改变时递增，让静止的世界也能重新合成。 */
  readonly revision: number;
  /** 用于在绘制世界前决定是否请求深度。缺深度时图层只画允许穿透的内容。 */
  readonly needsSceneDepth: boolean;
  draw(pass: GPURenderPassEncoder, view: LayerView): void;
}
