import { MemoryWorld, memorySource, type ObjectWant, type Vec3 } from "neomega-r2-core";
import type { MinecraftSource, MinecraftSink, NearSnapshot } from "./contracts.ts";

/** 内存中的 Java 世界。普通方块与核心共用存储，近景快照在 commit 后与对应区域一起更新。 */
export class MinecraftMemoryWorld extends MemoryWorld {
  private blockEntitiesByPosition = new Map<string, { position: Vec3; snbt: string }>();
  private entitySections = new Map<string, { position: Vec3; entries: NearSnapshot["entities"] }>();

  /** 设置该格的完整 SNBT；传 null 删除方块实体。改动通过 commit 通知近景订阅。 */
  setBlockEntity(position: Vec3, snbt: string | null): void {
    const key = position.join("/");
    if (snbt === null) this.blockEntitiesByPosition.delete(key);
    else this.blockEntitiesByPosition.set(key, { position: [...position], snbt });
    this.markObjectsChanged(position);
  }

  /** 替换整个子区块的普通实体快照，空列表表示全部撤下。坐标单位为 16 格。 */
  setEntities(section: Vec3, entries: NearSnapshot["entities"]): void {
    const position = section.map(v => v * 16) as Vec3;
    if (entries.length) this.entitySections.set(section.join("/"), { position, entries: [...entries] });
    else this.entitySections.delete(section.join("/"));
    this.markObjectsChanged(position);
  }

  override clear(): void {
    super.clear();
    for (const { position } of this.blockEntitiesByPosition.values()) this.markObjectsChanged(position);
    this.blockEntitiesByPosition.clear();
    for (const { position } of this.entitySections.values()) this.markObjectsChanged(position);
    this.entitySections.clear();
  }

  near({ x, z, center, radius }: ObjectWant): NearSnapshot {
    return {
      blockEntities: this.inRange(this.blockEntitiesByPosition.values(), x, z, center, radius)
        .map(({ position, snbt }) => [position, snbt]),
      entities: this.inRange(this.entitySections.values(), x, z, center, radius).flatMap(section => section.entries),
      objects: this.objects(x, z, center, radius),
    };
  }
}

/** 沿用核心的按需订阅和改动合并，每个区域一次交齐当前近景。 */
export function minecraftMemorySource(world: MinecraftMemoryWorld): MinecraftSource {
  return memorySource<MinecraftSink>(world, (sink, want) => sink.near(want.x, want.z, world.near(want)));
}
