// 区块的压缩数据留在后台线程；只在建立跳跃层次时解包，不生成表面或区域网格。
const MIXED = 0xffffffff;
class Words {
  data = new Uint32Array(1024 * 1024);
  length = 1;
  /** @param {ArrayLike<number>} values @returns {number} */
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
/** @param {number} x @param {number} y @param {number} z */
function sectionIndex(x, y, z) {
  return x + 128 * (y + 32 * z);
}
/** @param {number} x @param {number} y @param {number} z */
function cellIndex(x, y, z) {
  return (x << 8) | (z << 4) | y;
}
/** @param {{bits:number,words:Uint32Array,palette:Uint32Array}} section */
function unpack(section) {
  const cells = new Uint32Array(4096),
    { bits, words, palette } = section;
  const per = Math.floor(32 / bits),
    mask = (1 << bits) - 1;
  for (let i = 0; i < 4096; i++)
    cells[i] =
      palette[
        bits ? (words[Math.floor(i / per)] >>> ((i % per) * bits)) & mask : 0
      ];
  return cells;
}
// 高于 section 的层次与格内层次分开保存，空的世界范围不分配逐格数组。
/** @param {Uint32Array} first */
function coarseHierarchy(first) {
  const levels = [{ size: [128, 32, 128], data: first }];
  while (levels.at(-1).size.some((v) => v > 1)) {
    const prev = levels.at(-1),
      size = prev.size.map((v) => Math.max(1, v / 2)),
      data = new Uint32Array(size[0] * size[1] * size[2]);
    for (let z = 0; z < size[2]; z++)
      for (let y = 0; y < size[1]; y++)
        for (let x = 0; x < size[0]; x++) {
          let value =
            prev.data[x * 2 + prev.size[0] * (y * 2 + prev.size[1] * z * 2)];
          for (let dz = 0; dz < Math.min(2, prev.size[2]); dz++)
            for (let dy = 0; dy < Math.min(2, prev.size[1]); dy++)
              for (let dx = 0; dx < Math.min(2, prev.size[0]); dx++)
                if (
                  prev.data[
                    x * 2 +
                      dx +
                      prev.size[0] * (y * 2 + dy + prev.size[1] * (z * 2 + dz))
                  ] !== value
                )
                  value = MIXED;
          data[x + size[0] * (y + size[1] * z)] = value;
        }
    levels.push({ size, data });
  }
  return levels;
}
self.onmessage = async ({ data: request }) => {
  try {
    const started = performance.now(),
      catalog = await (await fetch("/assets/catalog.json")).json();
    const center = request.center,
      origin = [
        Math.floor(center[0] / 128 + 0.5) * 128 - 768,
        -64,
        Math.floor(center[2] / 128 + 0.5) * 128 - 768,
      ];
    const cx = Math.floor(center[0] / 16),
      cy = Math.floor(center[1] / 16),
      cz = Math.floor(center[2] / 16);
    const sections = new Map(),
      jobs = [];
    for (let x = 0; x < 12; x++)
      for (let z = 0; z < 12; z++)
        jobs.push([origin[0] / 128 + x, origin[2] / 128 + z]);
    jobs.sort(
      (a, b) =>
        Math.hypot(a[0] * 128 + 64 - center[0], a[1] * 128 + 64 - center[2]) -
        Math.hypot(b[0] * 128 + 64 - center[0], b[1] * 128 + 64 - center[2]),
    );
    const stats = {
      regions: 0,
      bytes: 0,
      serverMS: 0,
      nearSections: 0,
      farSections: 0,
      unknown: 0,
      fragmentReferences: 0,
    };
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (jobs.length) {
          const [x, z] = jobs.shift(),
            response = await fetch(`/api/world/region?x=${x}&z=${z}`);
          if (!response.ok) throw Error(await response.text());
          stats.serverMS += Number(
            response.headers.get("Server-Timing")?.split("=")[1] || 0,
          );
          const buffer = await response.arrayBuffer(),
            data = new Uint32Array(buffer);
          stats.bytes += buffer.byteLength;
          stats.unknown += data[2];
          let p = 3;
          for (let n = 0; n < data[1]; n++) {
            const sx = data[p++] | 0,
              sy = data[p++] | 0,
              sz = data[p++] | 0,
              bits = data[p++],
              count = data[p++],
              length = data[p++];
            const near =
              !request.farOnly &&
              (sx - cx) ** 2 + (sz - cz) ** 2 <= 64 &&
              Math.abs(sy - cy) <= 9;
            const palette = new Uint32Array(count);
            for (let i = 0; i < count; i++)
              palette[i] = data[p + i * 2 + (near ? 0 : 1)];
            p += count * 2;
            const words = data.slice(p, p + length);
            p += length;
            const local = [sx - origin[0] / 16, sy + 4, sz - origin[2] / 16];
            sections.set(sectionIndex(...local), {
              local,
              bits,
              palette,
              words,
              near,
            });
            stats[near ? "nearSections" : "farSections"]++;
          }
          stats.regions++;
          postMessage({ progress: { ...stats } });
        }
      }),
    );
    stats.downloadMS = performance.now() - started;
    const prepared = performance.now(),
      fragments = new Map();
    for (const section of [...sections.values()])
      if (section.near) {
        const cells = unpack(section);
        for (let i = 0; i < 4096; i++)
          for (const part of catalog.models[cells[i]].fragments || []) {
            const p = [
              section.local[0] * 16 + (i >> 8),
              section.local[1] * 16 + (i & 15),
              section.local[2] * 16 + ((i >> 4) & 15),
            ].map((v, a) => v + part.offset[a]);
            if (p.some((v, a) => v < 0 || v >= [1536, 512, 1536][a])) continue;
            const local = p.map((v) => v >> 4),
              key = sectionIndex(...local),
              cell = cellIndex(...p.map((v) => v & 15));
            if (!sections.has(key))
              sections.set(key, {
                local,
                bits: 0,
                palette: new Uint32Array([0]),
                words: new Uint32Array(),
                near: true,
              });
            if (!fragments.has(key)) fragments.set(key, new Map());
            const list = fragments.get(key);
            if (!list.has(cell)) list.set(cell, []);
            list.get(cell).push(part.model);
            stats.fragmentReferences++;
          }
      }
    const pool = new Words(),
      info = new Uint32Array(128 * 32 * 128 * 4),
      coarse = new Uint32Array(128 * 32 * 128);
    for (const [key, section] of sections) {
      const parts = fragments.get(key),
        uniform = section.palette[0];
      if (
        !parts &&
        catalog.models[uniform].kind <= 1 &&
        section.palette.every((id) => id === uniform)
      ) {
        info.set(
          [
            pool.append(section.words),
            pool.append(section.palette),
            section.bits,
            0,
          ],
          key * 4,
        );
        coarse[key] = uniform;
        continue;
      }
      const cells = unpack(section),
        tags = new Uint32Array(4096);
      for (let i = 0; i < 4096; i++)
        tags[i] =
          catalog.models[cells[i]].kind <= 1 && !parts?.has(i)
            ? cells[i]
            : MIXED;
      const hierarchy = new Uint32Array(586);
      let prev = tags,
        side = 16,
        offset = 0;
      while (side > 1) {
        const nextSide = side / 2,
          next = new Uint32Array(nextSide ** 3);
        for (let x = 0; x < nextSide; x++)
          for (let z = 0; z < nextSide; z++)
            for (let y = 0; y < nextSide; y++) {
              let value = prev[(x * 2 * side + z * 2) * side + y * 2];
              for (let dx = 0; dx < 2; dx++)
                for (let dz = 0; dz < 2; dz++)
                  for (let dy = 0; dy < 2; dy++)
                    if (
                      prev[
                        ((x * 2 + dx) * side + z * 2 + dz) * side + y * 2 + dy
                      ] !== value
                    )
                      value = MIXED;
              next[(x * nextSide + z) * nextSide + y] = value;
            }
        hierarchy.set(next, offset);
        offset += next.length;
        prev = next;
        side = nextSide;
      }
      if (parts) {
        const offsets = new Uint32Array(4096);
        for (const [cell, ids] of parts)
          offsets[cell] = pool.append([ids.length, ...ids]);
        hierarchy[585] = pool.append(offsets);
      }
      info.set(
        [
          pool.append(section.words),
          pool.append(section.palette),
          section.bits,
          hierarchy[584] !== MIXED && !parts ? 0 : pool.append(hierarchy),
        ],
        key * 4,
      );
      coarse[key] = hierarchy[584];
    }
    const levels = coarseHierarchy(coarse),
      words = pool.data.slice(0, pool.length);
    stats.prepareMS = performance.now() - prepared;
    stats.totalMS = performance.now() - started;
    postMessage({ ready: true, origin, center, info, levels, words, stats }, [
      info.buffer,
      words.buffer,
      ...levels.map((v) => v.data.buffer),
    ]);
  } catch (error) {
    postMessage({ error: String(error.stack || error) });
  }
};
