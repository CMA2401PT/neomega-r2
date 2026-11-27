/** 公共数据契约；渲染核心与来源适配器通过这些数据交换场景。 */

/** 三维坐标或方向。 */
export type Vec3 = [number, number, number];

/** 相机：position 为世界坐标；yaw 为零时看向北方（−Z），pitch 为正时向上看，均为弧度。
 * 设置 ortho 时改用正交投影，数值表示画面高度覆盖多少方块。 */
export interface Camera {
  position: number[];
  yaw: number;
  pitch: number;
  ortho?: number;
  /** 透视镜头的垂直视场角，单位为度，默认 65°。 */
  fov?: number;
}

/** 渲染核心的离屏帧输出；color 与可选 depth 均采用左上角原点。 */
export interface FrameOutput {
  readonly color: GPUTexture;
  readonly depth: GPUTexture | null;
  readonly width: number;
  readonly height: number;
  /** 每次向 color 写入新帧内容时递增，供后处理与合成器判断是否需要重算。 */
  readonly revision: number;
}

/** 单像素射线拾取结果。 */
export interface PickResult {
  /** 命中活动对象时返回它的稳定标识。position 仍是对象原点所在格，方块命中则是方块坐标。 */
  objectKey?: string;
  position: number[];
  normal: number[];
}

/** 近景数据源提交的方块实体，位置是整格世界坐标。 */
export interface BlockEntity {
  position: Vec3;
  snbt: string;
}

/** 特殊对象描述；data 由同类型工厂解释。 */
export interface ObjectDescriptor {
  /** 场景内唯一，移动或更换外观时沿用。 */
  key: string;
  kind: string;
  position: Vec3;
  /** 局部外观参数。修改外观时提交新值，仅移动时沿用原值以复用几何与贴图。 */
  data?: unknown;
  /** 同类对象可用这个值比较局部外观。重复解析出相同参数时仍能复用现有部件。 */
  appearanceKey?: string;
  replace?: boolean;
}

/** 可共享的图片，或处理器生成的私有像素。 */
export type ObjectTexture =
  | { url: string; pixels?: undefined; width?: undefined; height?: undefined }
  | { url?: undefined; pixels: Uint8Array; width: number; height: number; cacheKey?: string }
  /** 图集里首次需要这个 cacheKey 时才调用。相同像素可用于不同朝向和位置。 */
  | { url?: undefined; pixels?: undefined; renderPixels: () => Promise<Uint8Array>; width: number; height: number; cacheKey: string };

/** 盒体局部范围及六面的像素 UV 矩形。面顺序为 -X、+X、-Y、+Y、-Z、+Z。 */
export interface ObjectPart {
  minimum: number[];
  maximum: number[];
  faces: number[][];
  /** 逐面自亮掩码，告示牌正背面可以分别使用发光墨囊。 */
  unlitFaces?: number;
}

/** 正交旋转轴、相对拥有者的位移和统一缩放。 */
export interface ObjectPose {
  axes: number[][];
  position: number[];
  scale?: number;
}

/** 对象工厂产物；bounds 必须覆盖整个动画，相对 descriptor.position。 */
export interface ObjectRecipe {
  /** 固定位姿设为 false，静止画面可以停绘和累积。默认随时间更新。 */
  animated?: boolean;
  texture: ObjectTexture;
  bounds: number[][];
  parts: ObjectPart[];
  pose: (time: number, partIndex: number) => ObjectPose;
}

/** 静态网格使用对象原点下的局部坐标。UV 以贴图左上角为原点，单位是像素。 */
export interface TriangleMesh {
  vertices: { position: Vec3; uv: [number, number] }[];
  /** 三个下标引用上面的顶点。三角面双面可见，透明纹素允许射线穿过。 */
  triangles: { indices: [number, number, number]; unlit?: boolean }[];
}

export interface MeshRecipe {
  texture: ObjectTexture;
  mesh: TriangleMesh;
}

export type RenderRecipe = ObjectRecipe | MeshRecipe;

/** 外观实现无需接触 GPU 或存档读取。 */
export type ObjectFactory = (
  descriptor: ObjectDescriptor,
) => RenderRecipe | Promise<RenderRecipe>;

/** 格子准备器使用的活动部件候选。 */
export interface ObjectReference {
  key: string;
  owner: number[];
  replace: boolean;
  bounds: number[][];
  ids: number[];
  /** 静态网格由准备线程按三角面登记；ids[0] 保存拾取和图集共用的实例句柄。 */
  mesh?: TriangleMesh;
}

/** 压缩子区块（subchunk，16×16×16 方块）；解码后 palette 保存静态模型编号（传输时是方块哈希），格子索引为 XZY。 */
export interface SourceSubchunk {
  position: number[];
  bits: number;
  palette: Uint32Array;
  words: Uint32Array;
}

/** 一个 r2region（横向 8×8 个 chunk）的输入数据。 */
export interface SourceR2Region {
  sections: SourceSubchunk[];
  unknown: number;
  bytes: number;
}

/** 已准备区域的统计。 */
export interface RegionStatistics {
  sections: number;
  fragmentReferences: number;
  unknown: number;
  prepareMS: number;
}

/** 可增量上传的区域。headers 每 7 项描述一个子区块：
 * [区内编号, 附加块地址, 压缩字地址, 位宽, 小块掩码低 32 位, 高 32 位, 均匀编号]，
 * 附加块地址为 0 表示整个子区块是同一完整方块或空气；relocations 指出 words 内需要加上显存基址的地址项。 */
export interface PreparedR2Region {
  key: string;
  x: number;
  z: number;
  words: Uint32Array;
  headers: Uint32Array;
  relocations: Uint32Array;
  stats: RegionStatistics;
}

/** 共享模型；fragments 指向伸进相邻格子的部分。 */
export interface Model {
  kind: number;
  offset: number;
  count: number;
  group: number;
  fragments?: Array<{ offset: number[]; model: number }>;
}

/** 与贴图配套的共享模型表；water 是静止水源的模型。状态映射在单独的 states.bin。 */
export interface Catalog {
  models: Model[];
  water: number;
  statistics: Record<string, number>;
  unsupported: string[];
}

/** 准备器需要知道片段最远伸出多少格，才能收集相邻来源。 */
export interface PreparationCatalog {
  models: Model[];
  fragmentReach: number;
}
