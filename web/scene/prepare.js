const MIXED = 0xffffffff;
export const regionKey = (x, z) => `${x}/${z}`;
const sectionKey = (p) => p.join("/"),
  cellIndex = (x, y, z) => (x << 8) | (z << 4) | y;
class Words {
  data = new Uint32Array(4096);
  length = 1;
  relocations = [];
  append(values) {
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
/** 解码传输布局，压缩格子索引仍引用原始缓冲；不会展开整片世界。
 * @param {ArrayBuffer} buffer
 * @returns {import("../contracts.js").SourceRegion}
 */
export function decodeRegion(buffer) {
  const data = new Uint32Array(buffer),
    sections = [];
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
export function unpack(section) {
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
function empty(position) {
  return {
    position,
    bits: 0,
    palette: new Uint32Array([0]),
    words: new Uint32Array(),
  };
}
/** 只替换已准备好实例的本体；同 section 的其他方块保留原值。 */
function replaceCells(section, indices) {
  const cells = unpack(section);
  for (const i of indices) cells[i] = 0;
  const palette = [],
    lookup = new Map();
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
      words[Math.floor(i / per)] |= lookup.get(cells[i]) << ((i % per) * bits);
  return { ...section, palette: new Uint32Array(palette), words, bits };
}
/** 准备单个目标区域，同时收集相邻来源的预裁片；片段归属跟随来源，输出归属目标格。 */
export function prepareRegion({ x, z, regions, catalog, objects = [] }) {
  const started = performance.now(),
    source = regions.get(regionKey(x, z)),
    sections = new Map(),
    fragments = new Map(),
    replacements = new Map();
  for (const section of source.sections)
    sections.set(sectionKey(section.position), section);
  const ensure = (position) => {
    const key = sectionKey(position);
    if (!sections.has(key)) sections.set(key, empty(position));
    if (!fragments.has(key)) fragments.set(key, new Map());
    return fragments.get(key);
  };
  const inside = (p) =>
    Math.floor(p[0] / 128) === x &&
    Math.floor(p[2] / 128) === z &&
    p[1] >= -64 &&
    p[1] < 448;
  const add = (p, ids) => {
    if (!inside(p)) return;
    const position = p.map((v) => Math.floor(v / 16)),
      list = ensure(position),
      cell = cellIndex(...p.map((v) => ((v % 16) + 16) % 16));
    if (!list.has(cell)) list.set(cell, []);
    list.get(cell).push(...ids);
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
        .get(key)
        .push(
          cellIndex(
            ...object.owner.map((v) => ((Math.floor(v) % 16) + 16) % 16),
          ),
        );
    }
  }
  const pool = new Words(),
    headers = [],
    coarse = [],
    stats = {
      sections: 0,
      fragmentReferences: 0,
      unknown: source.unknown,
    };
  for (const [key, original] of sections) {
    const section = replacements.has(key)
        ? replaceCells(original, replacements.get(key))
        : original,
      parts = fragments.get(key),
      uniform = section.palette[0];
    stats.sections++;
    const position = section.position,
      index =
        position[0] -
        x * 8 +
        8 * (position[1] + 4 + 32 * (position[2] - z * 8));
    if (
      !parts &&
      catalog.models[uniform].kind <= 1 &&
      section.palette.every((id) => id === uniform)
    ) {
      headers.push(
        index,
        pool.append(section.words),
        pool.append(section.palette),
        section.bits,
        0,
      );
      coarse.push(uniform);
      continue;
    }
    const cells = unpack(section),
      tags = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++)
      tags[i] =
        catalog.models[cells[i]].kind <= 1 && !parts?.has(i) ? cells[i] : MIXED;
    const hierarchy = new Uint32Array(586);
    let previous = tags,
      side = 16,
      offset = 0;
    while (side > 1) {
      const nextSide = side / 2,
        next = new Uint32Array(nextSide ** 3);
      for (let x = 0; x < nextSide; x++)
        for (let z = 0; z < nextSide; z++)
          for (let y = 0; y < nextSide; y++) {
            let value = previous[(x * 2 * side + z * 2) * side + y * 2];
            for (let dx = 0; dx < 2; dx++)
              for (let dz = 0; dz < 2; dz++)
                for (let dy = 0; dy < 2; dy++)
                  if (
                    previous[
                      ((x * 2 + dx) * side + z * 2 + dz) * side + y * 2 + dy
                    ] !== value
                  )
                    value = MIXED;
            next[(x * nextSide + z) * nextSide + y] = value;
          }
      hierarchy.set(next, offset);
      offset += next.length;
      previous = next;
      side = nextSide;
    }
    if (parts) {
      const offsets = new Uint32Array(4096);
      for (const [cell, ids] of parts) {
        offsets[cell] = pool.append([ids.length, ...ids]);
        stats.fragmentReferences += ids.length;
      }
      const at = pool.append(offsets);
      for (const cell of parts.keys()) pool.relocations.push(at + cell);
      hierarchy[585] = at;
    }
    const tree =
      hierarchy[584] !== MIXED && !parts ? 0 : pool.append(hierarchy);
    if (parts) pool.relocations.push(tree + 585);
    headers.push(
      index,
      pool.append(section.words),
      pool.append(section.palette),
      section.bits,
      tree,
    );
    coarse.push(hierarchy[584]);
  }
  return {
    key: regionKey(x, z),
    x,
    z,
    words: pool.data.slice(0, pool.length),
    headers: new Uint32Array(headers),
    coarse: new Uint32Array(coarse),
    relocations: new Uint32Array(pool.relocations),
    stats: { ...stats, prepareMS: performance.now() - started },
  };
}
