import { regionKey } from "./prepare.js";

/** 把验证页的小型固定格子转换成来源区域，使验证场景与真实存档走同一条准备与绘制路径。
 * 格子按 x + size.x*(y + size.y*z) 排列，每格两项，只读取第一项的模型编号；
 * 跨格片段由准备器按共享模型重新登记。格子坐标即世界坐标，y 从 0 开始。
 * @param {number[]} size
 * @param {Uint32Array} cells
 * @returns {Map<string, import("../contracts.js").SourceRegion>}
 */
export function gridRegions(size, cells) {
  const regions = new Map();
  for (let sz = 0; sz * 16 < size[2]; sz++)
    for (let sy = 0; sy * 16 < size[1]; sy++)
      for (let sx = 0; sx * 16 < size[0]; sx++) {
        const ids = new Uint32Array(4096);
        for (let x = 0; x < 16; x++)
          for (let z = 0; z < 16; z++)
            for (let y = 0; y < 16; y++) {
              const gx = sx * 16 + x,
                gy = sy * 16 + y,
                gz = sz * 16 + z;
              if (gx < size[0] && gy < size[1] && gz < size[2])
                ids[(x << 8) | (z << 4) | y] =
                  cells[(gx + size[0] * (gy + size[1] * gz)) * 2];
            }
        const key = regionKey(sx >> 3, sz >> 3);
        if (!regions.has(key))
          regions.set(key, { sections: [], unknown: 0, bytes: 0 });
        regions.get(key).sections.push(packSection([sx, sy, sz], ids));
      }
  return regions;
}

/** @param {number[]} position @param {Uint32Array} ids */
function packSection(position, ids) {
  const palette = [...new Set(ids)],
    lookup = new Map(palette.map((id, i) => [id, i])),
    bits = palette.length === 1 ? 0 : Math.ceil(Math.log2(palette.length)),
    per = Math.floor(32 / bits),
    words = new Uint32Array(bits ? Math.ceil(4096 / per) : 0);
  if (bits)
    for (let i = 0; i < 4096; i++)
      words[Math.floor(i / per)] |= lookup.get(ids[i]) << ((i % per) * bits);
  return { position, bits, palette: new Uint32Array(palette), words };
}
