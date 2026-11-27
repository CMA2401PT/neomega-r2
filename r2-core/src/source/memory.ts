import { AIR, blockHash } from "./hash.ts";
import type { DataSource, WantChange, WorldSink } from "../session/session.ts";
import type { BlockEntity, ObjectDescriptor, Vec3 } from "../contracts.ts";

/** 一个子区块（subchunk）的方块哈希：4096 项，第 i 项是格子 x = i >> 8, z = (i >> 4) & 15, y = i & 15。0 表示空气。 */
export interface SectionBlocks {
  /** section 坐标，即方块坐标除以 16 向下取整。 */
  position: number[];
  blocks: Uint32Array;
}

/** 把同一 r2region 内的子区块编码成会话接受的数据（格式见 README 的「区域编码」）。全是空气的子区块省略。 */
export function encodeRegion(sections: Iterable<SectionBlocks>): ArrayBuffer {
  const words: number[] = [0x34504c54, 0];
  for (const { position, blocks } of sections) {
    const palette = [...new Set(blocks)];
    if (palette.length === 1 && palette[0] === 0) continue;
    const lookup = new Map(palette.map((hash, i) => [hash, i])),
      bits = palette.length === 1 ? 0 : Math.max(1, Math.ceil(Math.log2(palette.length))),
      per = bits ? Math.floor(32 / bits) : 0,
      packed = new Uint32Array(bits ? Math.ceil(4096 / per) : 0);
    if (bits)
      for (let i = 0; i < 4096; i++)
        packed[Math.floor(i / per)] |= lookup.get(blocks[i])! << ((i % per) * bits);
    words.push(position[0], position[1], position[2], bits, palette.length, packed.length);
    for (const hash of palette) words.push(hash || AIR);
    for (const word of packed) words.push(word);
    words[1]++;
  }
  return new Uint32Array(words).buffer;
}

/** commit 交给订阅者的改动：方块变化与对象变化所在的区域键。 */
export interface Changes {
  blocks: Set<string>;
  objects: Set<string>;
}

const sectionKey = (x: number, y: number, z: number) => `${x}/${y}/${z}`;
const regionOf = (x: number, z: number) => `${Math.floor(x / 128)}/${Math.floor(z / 128)}`;

/** 内存里的方块世界：按方块坐标写入状态，按区域编码。验证场景、测试和小型工具用它代替存档。
 * 改动在 commit() 时通知由 memorySource 打开的数据源，正在显示的区域会重新提交。
 */
export class MemoryWorld {
  private sections = new Map<string, Uint32Array>();
  private regions = new Map<string, Set<string>>();
  private entities = new Map<string, BlockEntity>();
  private descriptors = new Map<string, ObjectDescriptor>();
  private hashes = new Map<string, number>();
  private changed: Changes = { blocks: new Set(), objects: new Set() };
  private listeners = new Set<(changes: Changes) => void>();

  /** 状态写法同 blockHash；也可以直接给哈希，0 表示空气。 */
  set(x: number, y: number, z: number, state: string | number): void {
    const hash = typeof state === "number" ? state : this.hash(state),
      sx = Math.floor(x / 16),
      sy = Math.floor(y / 16),
      sz = Math.floor(z / 16),
      key = sectionKey(sx, sy, sz);
    let section = this.sections.get(key);
    if (!section) {
      if (!hash) return;
      section = new Uint32Array(4096);
      this.sections.set(key, section);
      const region = regionOf(x, z);
      if (!this.regions.has(region)) this.regions.set(region, new Set());
      this.regions.get(region)!.add(key);
    }
    section[((x & 15) << 8) | ((z & 15) << 4) | (y & 15)] = hash;
    this.changed.blocks.add(regionOf(x, z));
  }

  /** 填充 [from, to] 闭区间内的长方体。 */
  fill(from: number[], to: number[], state: string | number): void {
    const hash = typeof state === "number" ? state : this.hash(state);
    for (let z = Math.min(from[2], to[2]); z <= Math.max(from[2], to[2]); z++)
      for (let y = Math.min(from[1], to[1]); y <= Math.max(from[1], to[1]); y++)
        for (let x = Math.min(from[0], to[0]); x <= Math.max(from[0], to[0]); x++) this.set(x, y, z, hash);
  }

  /** 方块哈希，0 表示空气。 */
  get(x: number, y: number, z: number): number {
    const section = this.sections.get(sectionKey(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16)));
    return section ? section[((x & 15) << 8) | ((z & 15) << 4) | (y & 15)] : 0;
  }

  /** 设置该格的完整 SNBT；传 null 删除方块实体。改动通过 commit 通知近景订阅。 */
  setBlockEntity(position: Vec3, snbt: string | null): void {
    const key = position.join("/");
    if (snbt === null) this.entities.delete(key);
    else this.entities.set(key,{ position:[...position], snbt });
    this.changed.objects.add(regionOf(position[0],position[2]));
  }

  /** 加入或替换特殊对象（同一 key 替换）；对象按位置所在的区块交给近景。 */
  addObject(descriptor: ObjectDescriptor): void {
    const old = this.descriptors.get(descriptor.key);
    this.descriptors.set(descriptor.key, { ...descriptor, position: [...descriptor.position] });
    this.changed.objects.add(regionOf(descriptor.position[0], descriptor.position[2]));
    if (old) this.changed.objects.add(regionOf(old.position[0], old.position[2]));
  }

  removeObject(key: string): void {
    const old = this.descriptors.get(key);
    if (!old) return;
    this.descriptors.delete(key);
    this.changed.objects.add(regionOf(old.position[0], old.position[2]));
  }

  /** 清空方块与对象。 */
  clear(): void {
    for (const region of this.regions.keys()) this.changed.blocks.add(region);
    for (const descriptor of this.descriptors.values())
      this.changed.objects.add(regionOf(descriptor.position[0], descriptor.position[2]));
    this.sections.clear();
    this.regions.clear();
    for (const {position} of this.entities.values()) this.changed.objects.add(regionOf(position[0],position[2]));
    this.entities.clear();
    this.descriptors.clear();
  }

  /** 内存场景中有方块的区块占用表，供地图概览使用。布局与 R2Link ChunkIndex 一致。 */
  chunkIndex(): ArrayBuffer {
    const tiles = new Map<string, { x: number; z: number; bits: Uint8Array }>();
    for (const [key, cells] of this.sections) {
      if (!cells.some((hash) => hash !== 0 && hash !== AIR)) continue;
      const [x, , z] = key.split("/").map(Number);
      const tx = Math.floor(x / 32), tz = Math.floor(z / 32);
      const tileKey = `${tx}/${tz}`;
      let tile = tiles.get(tileKey);
      if (!tile) {
        tile = { x: tx, z: tz, bits: new Uint8Array(128) };
        tiles.set(tileKey, tile);
      }
      const bit = (z & 31) * 32 + (x & 31);
      tile.bits[bit >> 3] |= 1 << (bit & 7);
    }
    const buffer = new ArrayBuffer(tiles.size * 136), header = new DataView(buffer);
    let offset = 0;
    for (const tile of tiles.values()) {
      header.setInt32(offset, tile.x, true);
      header.setInt32(offset + 4, tile.z, true);
      new Uint8Array(buffer, offset + 8, 128).set(tile.bits);
      offset += 136;
    }
    return buffer;
  }

  /** 非空气方块数。 */
  get blockCount(): number {
    let count = 0;
    for (const section of this.sections.values()) for (const hash of section) if (hash) count++;
    return count;
  }

  /** r2region (x, z) 的编码；没有方块时为 null。 */
  region(x: number, z: number): ArrayBuffer | null {
    const keys = this.regions.get(`${x}/${z}`);
    if (!keys) return null;
    const data = encodeRegion(
      [...keys].map((key) => ({ position: key.split("/").map(Number), blocks: this.sections.get(key)! })),
    );
    return new Uint32Array(data)[1] ? data : null;
  }

  /** 区域 (x, z) 内、以区块坐标 center 为圆心 radius 区块以内的对象；竖直方向最多取 radius + 1 个 section。 */
  objects(x: number, z: number, center: number[], radius: number): ObjectDescriptor[] {
    return this.inRange(this.descriptors.values(),x,z,center,radius);
  }
  /** 查询范围与自定义活动对象相同，可同时提交二者。 */
  blockEntities(x: number, z: number, center: number[], radius: number): BlockEntity[] {
    return this.inRange(this.entities.values(),x,z,center,radius);
  }
  private inRange<T extends {position: Vec3}>(entries: Iterable<T>, x: number, z: number, center: number[], radius: number): T[] {
    const vertical = Math.min(radius + 1, 12);
    return [...entries].filter(({ position }) => {
      const [cx, cy, cz] = position.map((v) => Math.floor(v / 16));
      return (
        Math.floor(cx / 8) === x &&
        Math.floor(cz / 8) === z &&
        (cx - center[0]) ** 2 + (cz - center[2]) ** 2 <= radius * radius &&
        Math.abs(cy - center[1]) <= vertical
      );
    });
  }

  /** 把 set、fill、对象和 clear 的改动交给已打开的数据源。 */
  commit(): void {
    const changed = this.changed;
    if (!changed.blocks.size && !changed.objects.size) return;
    this.changed = { blocks: new Set(), objects: new Set() };
    for (const listener of this.listeners) listener(changed);
  }

  /** 供 memorySource 订阅改动。 */
  subscribe(listener: (changes: Changes) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private hash(state: string): number {
    let hash = this.hashes.get(state);
    if (hash === undefined) this.hashes.set(state, (hash = blockHash(state)));
    return hash;
  }
}

/** 把内存世界作为会话的数据源：需要的区域与近景对象在下一个微任务提交，world.commit() 后重新提交变化的部分。 */
export function memorySource(world: MemoryWorld): DataSource {
  let sink: WorldSink | null = null,
    scheduled = false,
    unsubscribe = () => {};
  const regions = new Set<string>(),
    objects = new Map<string, { center: number[]; radius: number }>(),
    pending = new Set<string>(),
    pendingObjects = new Set<string>();
  const flush = () => {
    scheduled = false;
    if (!sink) return;
    for (const key of pending) {
      const [x, z] = key.split("/").map(Number);
      if (regions.has(key)) sink.region(x, z, world.region(x, z));
    }
    for (const key of pendingObjects) {
      const [x, z] = key.split("/").map(Number),
        want = objects.get(key);
      if (want) {
        sink.objects(x, z, world.objects(x, z, want.center, want.radius));
        sink.blockEntities?.(x, z, world.blockEntities(x, z, want.center, want.radius));
      }
    }
    pending.clear();
    pendingObjects.clear();
  };
  const schedule = () => {
    if (!scheduled) (scheduled = true), queueMicrotask(flush);
  };
  return {
    open(next) {
      sink = next;
      unsubscribe = world.subscribe((changes) => {
        for (const key of changes.blocks) if (regions.has(key)) pending.add(key), schedule();
        for (const key of changes.objects) if (objects.has(key)) pendingObjects.add(key), schedule();
      });
    },
    want(change: WantChange) {
      for (const { x, z } of change.regions.remove) regions.delete(`${x}/${z}`);
      for (const { x, z } of change.objects.remove) objects.delete(`${x}/${z}`);
      for (const { x, z } of change.regions.add) {
        regions.add(`${x}/${z}`);
        pending.add(`${x}/${z}`), schedule();
      }
      for (const { x, z, center, radius } of change.objects.add) {
        objects.set(`${x}/${z}`, { center, radius });
        pendingObjects.add(`${x}/${z}`), schedule();
      }
    },
    close() {
      unsubscribe();
      sink = null;
    },
  };
}
