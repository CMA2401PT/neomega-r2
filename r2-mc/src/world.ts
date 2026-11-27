import type { MinecraftAssets, MinecraftHit, MinecraftSource } from "./contracts.ts";
import { entityObject, registerEntities } from "./entities/entities.ts";
import {
  hashSections,
  regionKey,
  unpack,
  WorldSession,
  ObjectRegistry,
  type Camera,
  type DataSource,
  type WorldSink,
  type Renderer,
  type ObjectDescriptor,
  type ObjectWant,
  type SourceSubchunk,
  type Vec3,
  type SessionOptions,
} from "neomega-r2-core";
import { hasAppearance, appearance, registerBlocks } from "./special-blocks/blocks.ts";

interface Candidate {
  hash: number;
  position: Vec3;
  snbt?: string;
  object?: ObjectDescriptor;
}
interface Section {
  compressed: SourceSubchunk;
  candidates?: Candidate[];
}
interface Near {
  want: ObjectWant;
  snbt: Map<string, string>;
  entities: ObjectDescriptor[];
  custom: ObjectDescriptor[];
  received: boolean;
}

function inRange(section: number[], { center, radius }: ObjectWant): boolean {
  return (
    (section[0] - center[0]) ** 2 + (section[2] - center[2]) ** 2 <= radius ** 2 &&
    Math.abs(section[1] - center[1]) <= Math.min(radius + 1, 12)
  );
}

/** 包装任何区域数据源。按区域合并方块外观、普通实体与宿主对象。只有包含特殊状态的子区块需要在近景展开。 */
export function minecraftRenderSource(source: MinecraftSource, onError: (message: string) => void = console.error) {
  const sections = new Map<string, Section[] | null>(),
    near = new Map<string, Near>();
  let sink: WorldSink;
  // 只在接收宿主快照时限定名字空间，避免和实体 ID 或方块坐标同名。
  function customObjects(objects: ObjectDescriptor[]): ObjectDescriptor[] {
    return objects.map(object => ({ ...object, key: "custom/" + object.key }));
  }
  function publish(x: number, z: number, complete = true) {
    const key = regionKey(x, z),
      slice = near.get(key),
      blocks = sections.get(key);
    if (!slice || (complete && !slice.received) || !blocks) return;
    const objects = slice.custom.filter((object) =>
      inRange(
        object.position.map((v) => Math.floor(v / 16)),
        slice.want,
      ),
    );
    for (const object of slice.entities)
      if (inRange(object.position.map(v => Math.floor(v / 16)), slice.want)) objects.push(object);
    for (const section of blocks) {
      const origin = section.compressed.position;
      if (!inRange(origin, slice.want)) {
        section.candidates = undefined;
        continue;
      }
      if (!section.candidates) {
        section.candidates = [];
        const cells = unpack(section.compressed);
        for (let i = 0; i < cells.length; i++)
          if (hasAppearance(cells[i])) {
            const position: Vec3 = [
              origin[0] * 16 + (i >> 8),
              origin[1] * 16 + (i & 15),
              origin[2] * 16 + ((i >> 4) & 15),
            ];
            section.candidates.push({ hash: cells[i], position, object: appearance(cells[i], position) });
          }
      }
      for (const cell of section.candidates) {
        const snbt = slice.snbt.get(cell.position.join("/"));
        if (snbt !== cell.snbt) {
          try {
            cell.object = appearance(cell.hash, cell.position, snbt);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            // 单格的 SNBT 有误时撤下其外观，继续处理其余方块。
            cell.object = undefined;
            onError(`方块 (${cell.position.join(", ")}) 的 SNBT 无法解析：${error.message}`);
          }
          cell.snbt = snbt;
        }
        if (cell.object) objects.push(cell.object);
      }
    }
    sink.objects(x, z, objects, complete);
  }
  return {
    open(next: WorldSink) {
      sink = next;
      source.open({
        region(x, z, data) {
          const key = regionKey(x, z);
          if (!sections.has(key)) return;
          const blocks: Section[] = [];
          if (data)
            for (const section of hashSections(data))
              if (section.palette.some(hasAppearance)) {
                // sink.region 将原缓冲区转移给 Worker，只复制有特殊状态的压缩索引。
                blocks.push({
                  compressed: { ...section, palette: section.palette.slice(), words: section.words.slice() },
                });
              }
          sections.set(key, blocks);
          sink.region(x, z, data);
          publish(x, z);
        },
        objects(x, z, custom, complete = true) {
          const slice = near.get(regionKey(x, z));
          if (slice) {
            slice.custom = customObjects(custom);
            slice.received = complete;
            publish(x, z, complete);
          }
        },
        near(x, z, snapshot) {
          const slice = near.get(regionKey(x, z));
          if (!slice) return;
          slice.snbt = new Map(snapshot.blockEntities.map(([position, snbt]) => [position.join("/"), snbt]));
          slice.entities = [];
          if (snapshot.objects !== undefined) slice.custom = customObjects(snapshot.objects);
          for (const [entityId, snbt] of snapshot.entities) {
            try {
              const object = entityObject(entityId, snbt);
              if (object) slice.entities.push(object);
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              onError(`实体 ${entityId} 的数据有误：${error.message}`);
            }
          }
          slice.received = true;
          publish(x, z);
        },
        error: next.error,
      });
    },
    want(change: Parameters<DataSource["want"]>[0]) {
      for (const p of change.regions.remove) sections.delete(regionKey(p.x, p.z));
      for (const p of change.regions.add) {
        const key = regionKey(p.x, p.z);
        if (!sections.has(key)) sections.set(key, null);
      }
      for (const p of change.objects.remove) {
        const key = regionKey(p.x, p.z);
        near.delete(key);
        for (const section of sections.get(key) ?? []) section.candidates = undefined;
      }
      for (const want of change.objects.add) {
        const key = regionKey(want.x, want.z);
        const slice = near.get(key);
        if (slice) {
          slice.want = want;
          publish(want.x, want.z, false);
          slice.received = false;
        } else near.set(key, { want, snbt: new Map(), entities: [], custom: [], received: false });
      }
      source.want(change);
    },
    close() {
      sections.clear();
      near.clear();
      source.close();
    },
  } satisfies DataSource;
}

export type MinecraftWorldOptions = Omit<SessionOptions, "registry"> & {
  assets: MinecraftAssets;
  registry?: ObjectRegistry;
};

/** 用宿主提供的资源和数据创建世界。宿主自行驱动核心会话，按需拾取方块或实体。 */
export function createMinecraftWorld(renderer: Renderer, source: MinecraftSource, options: MinecraftWorldOptions) {
  const registry = new ObjectRegistry();
  registerBlocks(registry, options.assets);
  registerEntities(registry, options.assets);
  for (const [kind, factory] of options.registry?.factories ?? []) {
    // 工厂收到宿主提交的原始 key，内部的名字空间只用于场景归属与拾取。
    registry.register(kind, descriptor => factory(descriptor.key.startsWith("custom/")
      ? { ...descriptor, key: descriptor.key.slice("custom/".length) }
      : descriptor));
  }
  const session = new WorldSession(renderer, minecraftRenderSource(source, options.onError), { ...options, registry });
  return {
    session,
    /** 返回所属方块坐标；命中实体时附带数据源传入的实例 ID。 */
    async pick(camera: Camera, pixel: Parameters<Renderer["pick"]>[1]): Promise<MinecraftHit | null> {
      const hit = await renderer.pick(camera, { objects: true, ...pixel });
      if (!hit) return null;
      const { position, normal, objectKey } = hit;
      return objectKey?.startsWith("entity/")
        ? { position, normal, entityId: objectKey.slice("entity/".length) }
        : { position, normal };
    },
  };
}
