import type { AccumulationFilter, SuperResolution } from "../../compositor/denoise.ts";
import type { PreviewTier } from "neomega-r2-core";
import type { Appearance } from "./appearance.ts";

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

/** 可随参数组保存的显示与操作控件，以同一份映射读写界面和文件。 */
export const settingInputs = [
  ["near-radius", "nearRadius"],
  ["far-radius", "farRadius"],
  ["resolution", "resolution"],
  ["speed", "speed"],
  ["fog", "fog"],
  ["super-resolution", "superResolution"],
  ["accumulation-filter", "accumulationFilter"],
  ["save-sr-2x", "saveSuperResolution2x"],
  ["photo-scale", "photoScale"],
  ["photo-supersample", "photoSupersample"],
  ["export-scale", "exportScale"],
  ["export-supersample", "exportSupersample"],
  ["time", "time"],
] as const;
