/** 单帧预览可选的三档绘制器，从低到高：
 * voxel 每个格子画成纯色立方体；basic 完整方块形状与贴图，没有阴影、雾与水面效果；
 * shading 硬阴影、远景雾、水面波纹与反射、labPBR 材质。 */
export type PreviewTier = "voxel" | "basic" | "shading";
/** 四档绘制器；accumulation 在光影之上加软阴影与漫反射反弹，静止累积与拍照专用。 */
export type Tier = PreviewTier | "accumulation";
export interface RendererOptions {
  /** 默认使用 WebGPU；显式关闭以使用 WebGL 2。 */
  useWebGPU?: boolean;
  /** 资源目录的 URL，以 / 结尾。 */
  assets?: string;
  /** 离线宿主按文件名提供着色器、模型与贴图。省略时从模块与 assets 目录读取。 */
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
  /** 日月直射和天空辐射分别乘以这两个线性 RGB 系数，默认都是白色单位强度。 */
  directLight?: number[];
  skyLight?: number[];
  /** 累积档的均匀薄雾消光系数，单位为每格。零或省略时关闭。 */
  airExtinction?: number;
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
  width: number;
  height: number;
  /** 用哪一档绘制，默认 accumulation：每个像素不停累积随机样本，没有上限。
   * 预览档用于导出当前画面：每个像素按 supersample×supersample 的网格取样，取满后完成。 */
  tier?: Tier;
  /** 像素采样网格的边长。预览默认 4，采满网格即完成；累积默认 1，循环遍历网格并在格内随机取样。 */
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
