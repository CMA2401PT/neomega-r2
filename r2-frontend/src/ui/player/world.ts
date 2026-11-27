import { regionKey, type Renderer, type Vec3, type ObjectWant } from "neomega-r2-core";
import { createMinecraftWorld, defaultMinecraftAssets, type MinecraftWorldOptions, type MinecraftHit, type MinecraftSource, type NearSnapshot } from "neomega-r2-mc";

interface NearRegion {
  want: ObjectWant;
  snapshot?: NearSnapshot;
}

type BlockPositionsListener = (region: string, positions: readonly Vec3[]) => void;

/** 同一区域的订阅范围可能在新快照到达前缩小，点击和框线都按当前范围取格子。 */
function inRange(position: readonly number[], { center, radius }: ObjectWant): boolean {
  const [x, y, z] = position.map(v => Math.floor(v / 16));
  return (x - center[0]) ** 2 + (z - center[2]) ** 2 <= radius ** 2 &&
    Math.abs(y - center[1]) <= Math.min(radius + 1, 12);
}

/** 查看器保留当前近景的原文。数据源只打开一次，同一份快照同时交给绘制和点击面板。 */
export function recordNearSNBT(source: MinecraftSource) {
  const regions = new Map<string, NearRegion>();
  const listeners = new Set<BlockPositionsListener>();

  function blockPositions(region: NearRegion): Vec3[] {
    return region.snapshot?.blockEntities.flatMap(([position]) => inRange(position, region.want) ? [position] : []) ?? [];
  }

  function notify(key: string, region?: NearRegion): void {
    if (!listeners.size) return;
    const positions = region ? blockPositions(region) : [];
    for (const listener of listeners) listener(key, positions);
  }

  const recorded: MinecraftSource = {
    open(sink) {
      source.open({
        ...sink,
        near(x, z, snapshot) {
          const key = regionKey(x, z);
          const region = regions.get(key);
          if (!region) return;
          region.snapshot = snapshot;
          sink.near(x, z, snapshot);
          notify(key, region);
        },
      });
    },
    want(change) {
      for (const { x, z } of change.objects.remove) {
        const key = regionKey(x, z);
        regions.delete(key);
        notify(key);
      }
      for (const want of change.objects.add) {
        const key = regionKey(want.x, want.z);
        const previous = regions.get(key);
        if (previous) {
          previous.want = want;
          notify(key, previous);
        } else regions.set(key, { want });
      }
      source.want(change);
    },
    close() {
      for (const key of regions.keys()) notify(key);
      regions.clear();
      source.close();
    },
  };
  return {
    source: recorded,
    /** 先交付已在近景中的格子，此后只交付变化的区域。空列表撤下该区域的标记。 */
    watchBlockPositions(listener: BlockPositionsListener): () => void {
      listeners.add(listener);
      for (const [key, region] of regions) listener(key, blockPositions(region));
      return () => { listeners.delete(listener); };
    },
    snbt(hit: MinecraftHit): string | undefined {
      const [x, , z] = hit.position;
      const region = regions.get(regionKey(Math.floor(x / 128), Math.floor(z / 128)));
      if (!region?.snapshot || !inRange(hit.position, region.want)) return;
      // 点击时只查所属区域，接收快照和移动相机时无需为面板再建一份索引。
      if (hit.entityId !== undefined)
        return region.snapshot.entities.find(([id]) => id === hit.entityId)?.[1];
      return region.snapshot.blockEntities.find(([pos]) => pos.every((v, i) => v === hit.position[i]))?.[1];
    },
  };
}

/** 标准查看器在创建 Minecraft 世界时保留原文，供 HTML 面板按命中身份读取。 */
export function createViewerWorld(renderer: Renderer, source: MinecraftSource, options: Partial<MinecraftWorldOptions> = {}) {
  const records = recordNearSNBT(source);
  const world = createMinecraftWorld(renderer, records.source, { assets: defaultMinecraftAssets, ...options });
  return { ...world, snbt: records.snbt, watchBlockPositions: records.watchBlockPositions };
}
export type ViewerWorld = ReturnType<typeof createViewerWorld>;
