import type {
  ObjectReference,
  PreparationCatalog,
  PreparedRegion,
  SourceRegion,
  SourceSection,
} from "../contracts.ts";

const MIXED = 0xffffffff;
export const regionKey = (x: number, z: number): string => `${x}/${z}`;
const sectionKey = (p: number[]) => p.join("/"),
  cellIndex = (x: number, y: number, z: number) => (x << 8) | (z << 4) | y;
class Words {
  data = new Uint32Array(4096);
  length = 1;
  relocations: number[] = [];
  append(values: ArrayLike<number>): number {
    const at = this.length;
    this.length += values.length;
    if (this.length > this.data.length) {
      const next = new Uint32Array(Math.max(this.length, this.data.length * 2));
      next.set(this.data);
      this.data = next;
    }
    this.data.set(values, at);
    return at;
  }
}
/** 解码传输布局，压缩格子索引仍引用原始缓冲；不会展开整片世界。 */
export function decodeRegion(buffer: ArrayBuffer): SourceRegion {
  const data = new Uint32Array(buffer),
    sections: SourceSection[] = [];
  let p = 3;
  if (data[0] !== 0x33504c54) throw Error("无法识别区块数据格式");
  for (let n = 0; n < data[1]; n++) {
    const position = [data[p++] | 0, data[p++] | 0, data[p++] | 0],
      bits = data[p++],
      count = data[p++],
      length = data[p++],
      palette = data.subarray(p, p + count);
    p += count;
    const words = data.subarray(p, p + length);
    p += length;
    sections.push({ position, bits, palette, words });
  }
  return { sections, unknown: data[2], bytes: buffer.byteLength };
}
export function unpack(section: SourceSection): Uint32Array {
  const cells = new Uint32Array(4096),
    { bits, palette, words } = section,
    per = Math.floor(32 / bits),
    mask = (1 << bits) - 1;
  for (let i = 0; i < 4096; i++)
    cells[i] =
      palette[
        bits ? (words[Math.floor(i / per)] >>> ((i % per) * bits)) & mask : 0
      ];
  return cells;
}
function empty(position: number[]): SourceSection {
  return {
    position,
    bits: 0,
    palette: new Uint32Array([0]),
    words: new Uint32Array(),
  };
}
/** 只替换已准备好实例的本体；同 section 的其他方块保留原值。 */
function replaceCells(section: SourceSection, indices: number[]): SourceSection {
  const cells = unpack(section);
  for (const i of indices) cells[i] = 0;
  const palette: number[] = [],
    lookup = new Map<number, number>();
  for (const id of cells)
    if (!lookup.has(id)) {
      lookup.set(id, palette.length);
      palette.push(id);
    }
  const bits = palette.length === 1 ? 0 : Math.ceil(Math.log2(palette.length)),
    per = Math.floor(32 / bits),
    words = new Uint32Array(bits ? Math.ceil(4096 / per) : 0);
  if (bits)
    for (let i = 0; i < 4096; i++)
      words[Math.floor(i / per)] |= lookup.get(cells[i])! << ((i % per) * bits);
  return { ...section, palette: new Uint32Array(palette), words, bits };
}
/** 把 section 分成 64 个 4×4×4 小块，供着色器用位运算跳过空格。
 * 占用指非空气或带有附加片段；小块内全是同一完整立方体时记下其编号，射线可以整块穿过同一介质。
 * 小块和格子都按 XZY 顺序编号：小块 ((x>>2)*4+(z>>2))*4+(y>>2)，块内 ((x&3)*4+(z&3))*4+(y&3)。
 */
export function describeBricks(
  cells: Uint32Array,
  parts: Map<number, number[]> | undefined,
  catalog: Pick<PreparationCatalog, "models">,
) {
  const cellMasks = new Uint32Array(128),
    tags = new Uint32Array(64),
    brickMask = [0, 0];
  for (let b = 0; b < 64; b++) {
    const bx = (b >> 4) * 4,
      bz = ((b >> 2) & 3) * 4,
      by = (b & 3) * 4;
    let tag = -1;
    for (let c = 0; c < 64; c++) {
      const i = ((bx + (c >> 4)) << 8) | ((bz + ((c >> 2) & 3)) << 4) | (by + (c & 3)),
        id = cells[i],
        attached = parts?.has(i);
      if (id !== 0 || attached) cellMasks[b * 2 + (c >> 5)] |= 1 << (c & 31);
      const value = !attached && catalog.models[id].kind <= 1 ? id : MIXED;
      tag = tag === -1 || tag === value ? value : MIXED;
    }
    tags[b] = tag;
    if (tag !== 0) brickMask[b >> 5] |= 1 << (b & 31);
  }
  brickMask[0] >>>= 0;
  brickMask[1] >>>= 0;
  const uniform = tags.every((v) => v === tags[0]) ? tags[0] : MIXED;
  return { cellMasks, tags, brickMask, uniform };
}
/** 准备单个目标区域，同时收集相邻来源伸入的片段；片段归属跟随来源，输出归属目标格。 */
export function prepareRegion({
  x,
  z,
  regions,
  catalog,
  objects = [],
}: {
  x: number;
  z: number;
  regions: Map<string, SourceRegion>;
  catalog: PreparationCatalog;
  objects?: ObjectReference[];
}): PreparedRegion {
  const started = performance.now(),
    source = regions.get(regionKey(x, z));
  if (!source) throw Error("没有来源区域 " + regionKey(x, z));
  const sections = new Map<string, SourceSection>(),
    fragments = new Map<string, Map<number, number[]>>(),
    replacements = new Map<string, number[]>();
  for (const section of source.sections)
    sections.set(sectionKey(section.position), section);
  const ensure = (position: number[]) => {
    const key = sectionKey(position);
    if (!sections.has(key)) sections.set(key, empty(position));
    if (!fragments.has(key)) fragments.set(key, new Map());
    return fragments.get(key)!;
  };
  const inside = (p: number[]) =>
    Math.floor(p[0] / 128) === x &&
    Math.floor(p[2] / 128) === z &&
    p[1] >= -64 &&
    p[1] < 448;
  const add = (p: number[], ids: number[]) => {
    if (!inside(p)) return;
    const position = p.map((v) => Math.floor(v / 16)),
      list = ensure(position),
      [cx, cy, cz] = p.map((v) => ((v % 16) + 16) % 16),
      cell = cellIndex(cx, cy, cz);
    if (!list.has(cell)) list.set(cell, []);
    list.get(cell)!.push(...ids);
  };
  // 模型目录中的最大越界距离决定来源范围，接口不假定模型最多只跨一格。
  const halo = Math.ceil(catalog.fragmentReach / 128);
  for (let dz = -halo; dz <= halo; dz++)
    for (let dx = -halo; dx <= halo; dx++)
      for (const raw of regions.get(regionKey(x + dx, z + dz))?.sections ||
        []) {
        const section = raw;
        if (!section.palette.some((id) => catalog.models[id].fragments?.length))
          continue;
        const cells = unpack(section);
        for (let i = 0; i < 4096; i++)
          for (const part of catalog.models[cells[i]].fragments || []) {
            const owner = [
              raw.position[0] * 16 + (i >> 8),
              raw.position[1] * 16 + (i & 15),
              raw.position[2] * 16 + ((i >> 4) & 15),
            ];
            add(
              owner.map((v, a) => v + part.offset[a]),
              [part.model],
            );
          }
      }
  for (const object of objects) {
    const [low, high] = object.bounds;
    if (
      high[0] <= x * 128 ||
      low[0] >= (x + 1) * 128 ||
      high[2] <= z * 128 ||
      low[2] >= (z + 1) * 128
    )
      continue;
    for (let cz = Math.floor(low[2]); cz < Math.ceil(high[2]); cz++)
      for (let cy = Math.floor(low[1]); cy < Math.ceil(high[1]); cy++)
        for (let cx = Math.floor(low[0]); cx < Math.ceil(high[0]); cx++)
          add([cx, cy, cz], object.ids);
    if (object.replace && inside(object.owner)) {
      const position = object.owner.map((v) => Math.floor(v / 16)),
        key = sectionKey(position);
      if (!replacements.has(key)) replacements.set(key, []);
      replacements
        .get(key)!
        .push(
          cellIndex(
            ...(object.owner.map((v) => ((Math.floor(v) % 16) + 16) % 16) as [number, number, number]),
          ),
        );
    }
  }
  const pool = new Words(),
    headers: number[] = [],
    stats = {
      sections: 0,
      fragmentReferences: 0,
      unknown: source.unknown,
    };
  for (const [key, original] of sections) {
    const section = replacements.has(key)
        ? replaceCells(original, replacements.get(key)!)
        : original,
      parts = fragments.get(key);
    stats.sections++;
    const position = section.position,
      index =
        position[0] -
        x * 8 +
        8 * (position[1] + 4 + 32 * (position[2] - z * 8));
    const cells = unpack(section),
      bricks = describeBricks(cells, parts, catalog);
    if (bricks.uniform !== MIXED) {
      headers.push(index, 0, 0, 0, 0, 0, bricks.uniform);
      continue;
    }
    // 附加块按 [格子掩码 128 字, 小块标签 64 字, 片段表地址, 调色板] 排列，着色器由附加块地址推出调色板地址。
    const aux = pool.append(bricks.cellMasks);
    pool.append(bricks.tags);
    const partsAt = pool.append([0]);
    pool.append(section.palette);
    if (parts) {
      const offsets = new Uint32Array(4096);
      for (const [cell, ids] of parts) {
        offsets[cell] = pool.append([ids.length, ...ids]);
        stats.fragmentReferences += ids.length;
      }
      const at = pool.append(offsets);
      for (const cell of parts.keys()) pool.relocations.push(at + cell);
      pool.data[partsAt] = at;
      pool.relocations.push(partsAt);
    }
    headers.push(
      index,
      aux,
      pool.append(section.words),
      section.bits,
      bricks.brickMask[0],
      bricks.brickMask[1],
      MIXED,
    );
  }
  return {
    key: regionKey(x, z),
    x,
    z,
    words: pool.data.slice(0, pool.length),
    headers: new Uint32Array(headers),
    relocations: new Uint32Array(pool.relocations),
    stats: { ...stats, prepareMS: performance.now() - started },
  };
}
