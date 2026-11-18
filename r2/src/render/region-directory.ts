import { WordAllocator, type WordBlock } from "./allocator.ts";
import type { PreparedR2Region, RegionStatistics } from "../contracts.ts";

interface InstalledRegion {
  block: WordBlock;
  stats: RegionStatistics;
  x: number;
  z: number;
}
export const MIXED = 0xffffffff,
  // 目录覆盖 256×32×256 个 section，即 4096×512×4096 方块，可容纳半径 96 区块的窗口与对齐余量。
  SIZE = [256, 32, 256],
  mod = (v: number, n: number) => ((v % n) + n) % n;

/** 世界目录使用循环坐标，移动窗口只更新边界区域，不搬动已有格子数据。 */
export abstract class RegionDirectory {
  origin: number[];
  size: number[];
  regions: Map<string, InstalledRegion>;
  version: number;
  allocator: WordAllocator;
  sections: Uint32Array;
  levels: Array<{ size: number[]; data: Uint32Array }>;
  textureBytes: number;
  constructor({ capacityWords = 64 * 1024 * 1024 }: { capacityWords?: number } = {}) {
    this.origin = [0, -64, 0];
    this.size = [1536, 512, 1536];
    this.regions = new Map();
    // 每次目录或窗口变化加一，宿主据此判断静止画面是否需要重画。
    this.version = 0;
    this.allocator = new WordAllocator(capacityWords);
    this.sections = new Uint32Array(SIZE[0] * SIZE[1] * SIZE[2] * 4);
    this.levels = [];
    let size = [...SIZE];
    while (true) {
      this.levels.push({
        size,
        data: new Uint32Array(size[0] * size[1] * size[2]),
      });
      if (size.every((v) => v === 1)) break;
      size = size.map((v) => Math.max(1, v / 2));
    }
    this.textureBytes =
      capacityWords * 4 +
      this.sections.byteLength +
      this.levels.reduce((sum, l) => sum + l.data.byteLength, 0);
  }
  setWindow(origin: number[], size: number[]): void {
    this.origin = [...origin];
    this.size = [...size];
    this.version++;
  }
  protected abstract uploadWords(start: number, words: Uint32Array): void;
  protected abstract uploadDirectory(
    section: boolean,
    level: number,
    low: number[],
    size: number[],
    data: Uint32Array,
  ): void;
  /** 同一帧内先上传新地址，再发布目录，最后释放旧地址，避免看到一半的新区域。 */
  install(region: PreparedR2Region): void {
    const key = region.key,
      old = this.regions.get(key),
      block = this.allocator.allocate(region.words.length),
      words = region.words;
    for (const index of region.relocations) words[index] += block.start;
    this.uploadWords(block.start, words);
    this.writeRegion(region, block.start);
    this.regions.set(key, {
      block,
      stats: region.stats,
      x: region.x,
      z: region.z,
    });
    if (old) this.allocator.release(old.block);
    this.version++;
  }
  remove(key: string): void {
    const region = this.regions.get(key);
    if (!region) return;
    this.writeRegion(
      {
        x: region.x,
        z: region.z,
        headers: new Uint32Array(),
      },
      0,
    );
    this.regions.delete(key);
    this.allocator.release(region.block);
    this.version++;
  }
  writeRegion(region: { x: number; z: number; headers: Uint32Array }, base: number): void {
    const x = mod(region.x * 8, SIZE[0]),
      z = mod(region.z * 8, SIZE[2]),
      info = new Uint32Array(8 * 32 * 8 * 4),
      tags = new Uint32Array(8 * 32 * 8);
    // 目录项为 [附加块地址, 压缩字地址 | 位宽 << 27, 小块掩码低位, 高位]；均匀 section 为 [0, 编号, 0, 0]。
    // 射线进入 section 时只读这一项，就能判断空小块并找到调色板。
    for (let i = 0; i < region.headers.length; i += 7) {
      const h = region.headers,
        index = h[i];
      info.set(
        h[i + 1]
          ? [h[i + 1] + base, ((h[i + 2] + base) | (h[i + 3] << 27)) >>> 0, h[i + 4], h[i + 5]]
          : [0, h[i + 6], 0, 0],
        index * 4,
      );
      tags[index] = h[i + 6];
    }
    for (let dz = 0; dz < 8; dz++)
      for (let y = 0; y < 32; y++)
        for (let dx = 0; dx < 8; dx++) {
          const source = dx + 8 * (y + 32 * dz),
            target = x + dx + SIZE[0] * (y + SIZE[1] * (z + dz));
          this.sections.set(info.subarray(source * 4, source * 4 + 4), target * 4);
          this.levels[0].data[target] = tags[source];
        }
    this.uploadDirectory(true, 0, [x, 0, z], [8, 32, 8], info);
    this.uploadDirectory(false, 0, [x, 0, z], [8, 32, 8], tags);
    let low = [x, 0, z],
      high = [x + 8, 32, z + 8];
    for (let l = 1; l < this.levels.length; l++) {
      low = low.map((v) => Math.floor(v / 2));
      high = high.map((v) => Math.ceil(v / 2));
      const prev = this.levels[l - 1],
        next = this.levels[l],
        extent = high.map((v, i) => v - low[i]),
        data = new Uint32Array(extent[0] * extent[1] * extent[2]);
      for (let z = low[2]; z < high[2]; z++)
        for (let y = low[1]; y < high[1]; y++)
          for (let x = low[0]; x < high[0]; x++) {
            let value = prev.data[x * 2 + prev.size[0] * (y * 2 + prev.size[1] * z * 2)];
            for (let dz = 0; dz < Math.min(2, prev.size[2]); dz++)
              for (let dy = 0; dy < Math.min(2, prev.size[1]); dy++)
                for (let dx = 0; dx < Math.min(2, prev.size[0]); dx++)
                  if (
                    prev.data[x * 2 + dx + prev.size[0] * (y * 2 + dy + prev.size[1] * (z * 2 + dz))] !==
                    value
                  )
                    value = MIXED;
            next.data[x + next.size[0] * (y + next.size[1] * z)] = value;
            data[x - low[0] + extent[0] * (y - low[1] + extent[1] * (z - low[2]))] = value;
          }
      this.uploadDirectory(false, l, low, extent, data);
    }
  }
  abstract dispose(): void;
}
