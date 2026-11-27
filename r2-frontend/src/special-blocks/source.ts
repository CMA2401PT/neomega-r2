import { entityObject, registerEntities } from "../entities/entities.ts";
import {
  hashSections,
  regionKey,
  unpack,
  WorldSession,
  ObjectRegistry,
  type DataSource,
  type WorldSink,
  type Renderer,
  type ObjectDescriptor,
  type ObjectWant,
  type SourceSubchunk,
  type Vec3,
  type SessionOptions,
} from "neomega-r2-core";
import { hasAppearance, appearance, registerBlocks } from "./blocks.ts";

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
  entities: Map<string, { object: ObjectDescriptor; snbt: string }>;
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
export function specialBlockSource(source: DataSource, onError: (message: string) => void = console.error) {
  const sections = new Map<string, Section[] | null>(),
    near = new Map<string, Near>();
  let sink: WorldSink;
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
    for (const { object } of slice.entities.values())
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
            // 单格数据损坏时保留原文供点击查看，其他方块继续处理。
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
    snbtAt(position: number[], objectKey?: string) {
      const section = position.map((v) => Math.floor(v / 16));
      const slice = near.get(regionKey(Math.floor(section[0] / 8), Math.floor(section[2] / 8)));
      if (!slice || !inRange(section, slice.want)) return;
      return objectKey?.startsWith("entity/") ? slice.entities.get(objectKey)?.snbt : slice.snbt.get(position.join("/"));
    },
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
        objects(x, z, custom) {
          const slice = near.get(regionKey(x, z));
          if (slice) {
            slice.custom = custom;
            slice.received = true;
            publish(x, z);
          }
        },
        entities(x, z, entries) {
          const key = regionKey(x, z), slice = near.get(key);
          if (!slice) return;
          slice.received = true;
          slice.entities.clear();
          for (const [index, snbt] of entries.entries()) {
            try {
              const object = entityObject(snbt, key + "/entry/" + index);
              if (object) slice.entities.set(object.key, { object, snbt });
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
              onError(`区域 ${key} 中第 ${index + 1} 个实体的数据有误：${error.message}`);
            }
          }
          publish(x, z);
        },
        blockEntities(x, z, entries) {
          const slice = near.get(regionKey(x, z));
          if (!slice) return;
          slice.snbt = new Map(entries.map((e) => [e.position.join("/"), e.snbt]));
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
        } else near.set(key, { want, snbt: new Map(), entities: new Map(), custom: [], received: false });
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

/** 标准查看器共享此入口；只使用渲染核心的宿主仍能直接提交自定义对象。 */
export function blockWorldSession(
  renderer: Renderer,
  source: DataSource,
  options: Omit<SessionOptions, "registry"> & Partial<Pick<SessionOptions, "registry">> = {},
) {
  const registry = new ObjectRegistry();
  registerBlocks(registry);
  registerEntities(registry);
  for (const [kind, factory] of options.registry?.factories ?? []) registry.register(kind, factory);
  return new WorldSession(renderer, specialBlockSource(source, options.onError), { ...options, registry });
}
