/** 单帧预览可选的三档绘制器，从低到高：
 * voxel 每个格子画成纯色立方体；basic 完整方块形状与贴图，没有阴影、雾与水面效果；
 * shading 硬阴影、远景雾、水面波纹与反射、labPBR 材质。 */
export type PreviewTier = "voxel" | "basic" | "shading";
/** 四档绘制器；accumulation 在光影之上加软阴影与漫反射反弹，静止累积与拍照专用。 */
export type Tier = PreviewTier | "accumulation";
/** WebGPU 输出使用的 2× 超分模型。WebGL 始终按目标尺寸绘制。 */
export type SuperResolution = "off" | "cnn-xs" | "cnn-s";
export type AccumulationFilter = "off" | "light" | "medium" | "high";

/** 固定取周围一圈像素。档位越高，参与平均的色差范围和平均色的占比越大。 */
export const filterParameters = {
  light: { colorSigma: 4, blend: 0.65 },
  medium: { colorSigma: 8, blend: 0.82 },
  high: { colorSigma: 16, blend: 1 },
} as const;

/** 交互画面和照片共享输出档位。旧宿主使用布尔开关时仍可选中原来的轻度滤波。 */
export function createOutputSettings() {
  return {
    accumulationFilter: "off" as AccumulationFilter,
    get denoiseAccumulation(): boolean { return this.accumulationFilter !== "off"; },
    set denoiseAccumulation(enabled: boolean) { this.accumulationFilter = enabled ? "light" : "off"; },
  };
}

export interface RendererOptions {
  /** 默认使用 WebGPU；显式关闭以使用 WebGL 2。 */
  useWebGPU?: boolean;
  /** 资源目录的 URL，以 / 结尾。 */
  assets?: string;
  /** 按文件名提供模型与贴图。目录版离线播放器还用此回调提供着色器；独立 JS 自带着色器。 */
  readResource?: (name: string) => Promise<Response>;
  /** 启动时编译的预览档，默认 shading；其他档第一次需要时用 compile() 编译。 */
  tier?: PreviewTier;
  /** 每个启动阶段开始前调用；返回 Promise 时等它完成，宿主可先绘制状态提示。 */
  onProgress?: (step: { index: number; total: number; label: string }) => void | Promise<void>;
}

/** 光照、时间与可选效果；预览、累积与拍照共用。阴影、雾与海面效果只在 shading 与 accumulation 档出现。 */
export interface LightingOptions {
  /** 动画时钟（秒），驱动水波与活动对象。 */
  time?: number;
  /** 指向太阳的方向；太阳在地平线下时由月亮照明。 */
  sun?: number[];
  /** 太阳光的基础颜色，在线性 RGB 空间中指定。默认白色。 */
  sunColor?: number[];
  /** 按太阳高度为基础色加入日照色调。省略时沿用各档原有的自动配色。 */
  autoSunColor?: boolean;
  /** 日月直射和天空辐射分别乘以这两个线性 RGB 系数，默认都是白色单位强度。 */
  directLight?: number[];
  skyLight?: number[];
  /** 累积档在世界 Y≤0 处的薄雾消光系数，单位为每格；向上到 Y=256 线性降为零。零或省略时关闭。 */
  airExtinction?: number;
  /** 累积时把朝向太阳的气溶胶散射计入天空亮度与表面反弹。默认关闭。 */
  solarHaze?: boolean;
  /** 累积时让高空的固定云层遮挡照到薄雾和表面的日月直射光。默认关闭。 */
  cloudShadows?: boolean;
  /** 曝光补偿，以档为单位。关闭昼夜曝光适应后，零档固定为日间曝光。 */
  exposureEV?: number;
  autoExposure?: boolean;
  /** 远景雾接近不透明的距离，默认为观察窗口半径。 */
  fog?: number;
  /** 无限海面的世界高度；省略时只绘制场景里的体素水。 */
  ocean?: number;
  /** 为假时这次绘制隐藏特殊对象。 */
  objects?: boolean;
}

/** 合成画面时每增加一档曝光，进入色调映射的线性亮度加倍。 */
export function frameExposure(sunHeight: number, ev = 0, adapt = true): number {
  const night = adapt ? 1 - Math.max(0, Math.min(1, (sunHeight + 0.1) / 0.3)) : 0;
  return 0.9 * (1 + 2.3 * night) * 2 ** ev;
}

export interface DrawOptions extends LightingOptions {
  /** width、height 决定射线采样尺寸。WebGPU 可在显示前对最终画面做一次超分增强。 */
  superResolution?: SuperResolution;
  /** 超分增强作用的屏幕像素尺寸。省略时使用渲染宽高。 */
  displaySize?: { width: number; height: number };
  width: number;
  height: number;
  /** 预览用哪一档，默认 shading；必须已经编译好。 */
  tier?: PreviewTier;
  /** 相机、设置与场景都和上一帧相同：这一帧用累积档作为样本加到画面上。 */
  accumulate?: boolean;
  debug?: number;
  hierarchy?: boolean;
  fragments?: boolean;
  /** 绘制后读回一个像素，等待 GPU 完成。 */
  synchronize?: boolean;
}

export interface PhotoOptions extends LightingOptions {
  /** 创建照片时固定模型和输出尺寸，所有采样轮次按指定照片尺寸累积。 */
  superResolution?: SuperResolution;
  width: number;
  height: number;
  /** 启用 WebSR 时，PNG 保留原图两倍的宽高；默认保存为指定尺寸。 */
  saveSuperResolution2x?: boolean;
  /** 用哪一档绘制，默认 accumulation：每个像素不停累积随机样本，没有上限。
   * 预览档用于导出当前画面：每个像素按 supersample×supersample 的网格取样，取满后完成。 */
  tier?: Tier;
  /** 像素采样网格的边长。预览默认 1，采满网格即完成；累积默认 1，循环遍历网格并在格内随机取样。 */
  supersample?: number;
  /** 累积档光线最多反弹次数。 */
  bounces?: number;
}


/** 每轮采一个子格。偶数网格先交替访问四个象限，提前保存时样本不会集中在一排。 */
export function sampleCell(round: number, grid: number): [number, number, number] {
  let column = round % grid;
  let row = Math.floor(round / grid) % grid;
  if (grid % 2 === 0) {
    const half = grid / 2, quadrant = [0, 3, 1, 2][round % 4], cell = Math.floor(round / 4);
    column = cell % half + (quadrant % 2) * half;
    row = Math.floor(cell / half) % half + Math.floor(quadrant / 2) * half;
  }
  return [(column + 0.5) / grid - 0.5, (row + 0.5) / grid - 0.5, 1 / grid];
}
