import type { PickResult, DataSource, ObjectDescriptor, Vec3, WorldSink } from "neomega-r2-core";

/** 当前订阅范围的完整快照。空列表撤下旧记录，实体移动或跨区域时沿用同一实例 ID。 */
export interface NearSnapshot {
  blockEntities: readonly (readonly [position: Vec3, snbt: string])[];
  entities: readonly (readonly [entityId: string, snbt: string])[];
  /** 可随快照一起替换宿主的通用对象。省略时由独立的 objects 回调管理，空列表撤下全部。 */
  objects?: ObjectDescriptor[];
}

export interface MinecraftSink extends WorldSink {
  near(x: number, z: number, snapshot: NearSnapshot): void;
}
export type MinecraftSource = DataSource<MinecraftSink>;

/** 每种 URL 对应模型旁固定布局的素材。宿主可直接使用随包提供的本地 data URL。 */
export interface MinecraftAssets {
  book: string;
  pot: string;
  banner: string;
  glyphs: string;
  frame: string;
  items: string;
  shapes: string;
}

export interface MinecraftHit extends Pick<PickResult, "position" | "normal"> {
  /** 只有命中普通实体时才携带数据源提供的实例 ID。 */
  entityId?: string;
}
