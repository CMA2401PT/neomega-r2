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
}

/** 特殊对象描述；data 由同类型工厂解释。 */
export interface ObjectDescriptor {
  key: string;
  kind: string;
  position: Vec3;
  data?: unknown;
  replace?: boolean;
}

/** 可共享的图片，或处理器生成的私有像素。 */
export type ObjectTexture =
  | { url: string; pixels?: undefined; width?: undefined; height?: undefined }
  | { url?: undefined; pixels: Uint8Array; width: number; height: number };

/** 盒体局部范围及六面的像素 UV 矩形。面顺序为 -X、+X、-Y、+Y、-Z、+Z。 */
export interface ObjectPart {
  minimum: number[];
  maximum: number[];
  faces: number[][];
}

/** 正交旋转轴、相对拥有者的位移和统一缩放。 */
export interface ObjectPose {
  axes: number[][];
  position: number[];
  scale?: number;
}

/** 对象工厂产物；bounds 必须覆盖整个动画，相对 descriptor.position。 */
export interface ObjectRecipe {
  texture: ObjectTexture;
  bounds: number[][];
  parts: ObjectPart[];
  pose: (time: number, partIndex: number) => ObjectPose;
}

/** 外观实现无需接触 WebGL 或存档读取。 */
export type ObjectFactory = (
  descriptor: ObjectDescriptor,
) => ObjectRecipe | Promise<ObjectRecipe>;

/** 格子准备器使用的活动部件候选。 */
export interface ObjectReference {
  key: string;
  owner: number[];
  replace: boolean;
  bounds: number[][];
  ids: number[];
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

// 兼容已有宿主使用的类型名。
export type SourceSection = SourceSubchunk;
export type SourceRegion = SourceR2Region;
export type PreparedRegion = PreparedR2Region;

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
