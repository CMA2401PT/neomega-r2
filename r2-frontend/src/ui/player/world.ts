import { regionKey, type Renderer, type ObjectWant } from "neomega-r2-core";
import { createMinecraftWorld, defaultMinecraftAssets, type MinecraftWorldOptions, type MinecraftHit, type MinecraftSource, type NearSnapshot } from "neomega-r2-mc";

/** 查看器保留当前近景的原文。数据源只打开一次，同一份快照同时交给绘制和点击面板。 */
export function recordNearSNBT(source: MinecraftSource) {
  const regions = new Map<string, {
    want: ObjectWant;
    snapshot?: NearSnapshot;
  }>();
  const recorded: MinecraftSource = {
    open(sink) {
      source.open({
        ...sink,
        near(x, z, snapshot) {
          const region = regions.get(regionKey(x, z));
          if (!region) return;
          region.snapshot = snapshot;
          sink.near(x, z, snapshot);
        },
      });
    },
    want(change) {
      for (const { x, z } of change.objects.remove) regions.delete(regionKey(x, z));
      for (const want of change.objects.add) {
        const key = regionKey(want.x, want.z);
        const previous = regions.get(key);
        if (previous) previous.want = want;
        else regions.set(key, { want });
      }
      source.want(change);
    },
    close() {
      regions.clear();
      source.close();
    },
  };
  return {
    source: recorded,
    snbt(hit: MinecraftHit): string | undefined {
      const [x, y, z] = hit.position.map(v => Math.floor(v / 16));
      const region = regions.get(regionKey(Math.floor(x / 8), Math.floor(z / 8)));
      if (!region?.snapshot) return;
      const { center, radius } = region.want;
      if ((x - center[0]) ** 2 + (z - center[2]) ** 2 > radius ** 2 ||
          Math.abs(y - center[1]) > Math.min(radius + 1, 12)) return;
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
  return { ...world, snbt: records.snbt };
}
export type ViewerWorld = ReturnType<typeof createViewerWorld>;
