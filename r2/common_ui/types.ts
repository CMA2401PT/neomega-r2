import type { AccumulationFilter, Camera, Renderer, PreviewTier, SessionStats } from "/r2/index.js";

import type { Appearance } from "./appearance.js";

export interface ViewSettings {
  /** 旧设置首次打开面板时沿用默认镜头与昼夜光照。 */
  appearance?: Appearance;
  nearRadius: number;
  farRadius: number;
  resolution: string;
  speed: number;
  tier: PreviewTier;
  time: number;
  timeFlow: boolean;
  fog: boolean;
  stillAccumulation: boolean;
  /** 静止累积和照片的最终画面共用此档位。 */
  accumulationFilter?: AccumulationFilter;
  photoScale: number;
  photoSupersample: number;
  exportScale: number;
  exportSupersample: number;
}

export interface ViewStats {
  stats: SessionStats;
  shownTier: PreviewTier;
  median?: number;
  width: number;
  height: number;
}

export interface ViewOptions {
  renderer: Renderer;
  camera: Camera;
  settings: ViewSettings;
  scene(): { name?: string; ocean?: number; connection?: { state: string } };
  /** 宿主支持通过 ?backend=webgl 或 webgpu 重载页面。 */
  switchBackend?: boolean;
  onSettings?(): void;
  onStats?(value: ViewStats): void;
  report?(event: string, detail?: Record<string, unknown>): void;
}
