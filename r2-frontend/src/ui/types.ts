import type { Camera, PreviewTier, Renderer, SessionStats } from "neomega-r2-core";
import type { AccumulationFilter, SuperResolution } from "../compositor/denoise.ts";
import type { Appearance } from "./appearance.ts";
import type { Startup } from "./startup.ts";

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
  superResolution?: SuperResolution;
  saveSuperResolution2x?: boolean;
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
  startup?: Startup;
  scene(): { name?: string; ocean?: number; connection?: { state: string } };
  onSettings?(): void;
  onStats?(value: ViewStats): void;
  report?(event: string, detail?: Record<string, unknown>): void;
}
