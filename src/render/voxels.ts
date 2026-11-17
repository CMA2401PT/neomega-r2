import type { Catalog } from "../contracts.ts";
import type { TextureInfo } from "./textures.ts";

/** 计算体素档要用的输入：模型表、完整方块面表、四边形引用与记录、面贴图与图集。 */
export interface VoxelSources {
  catalog: Catalog;
  info: TextureInfo;
  fast: ArrayBuffer;
  references: ArrayBuffer;
  records: ArrayBuffer;
  surfaces: ArrayBuffer;
  surfaceSpecular: ArrayBuffer;
  atlas: ArrayBuffer;
  atlasSpecular: ArrayBuffer;
}

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
/** labPBR 高光贴图的 A 通道：0–254 是自发光强度，255 表示不发光。 */
const glow = (alpha: number) => (alpha < 255 ? alpha / 254 : 0);
// 每张贴图最多取这么多点（每边），代表色不需要逐像素精确。
const SAMPLES = 8;

/** 体素档把每个模型画成一个纯色立方体，这里求出每个模型的代表色。
 * 结果每个模型两项 RGBA：[线性颜色, 不透明度]、[自发光强度, 0, 0, 0]。
 * 完整方块在着色器里逐面使用资源包的面代表色，这里只给出不透明度与自发光；四边形模型按各面面积与贴图覆盖率加权平均图集像素。
 * 半透明混合的表面（水、染色玻璃）保留平均不透明度；其余表面覆盖过半就当作不透明，
 * 树叶因此是实心块，玻璃、花草这类大部分透空的方块仍是淡淡的透明块。
 */
export function voxelColors(sources: VoxelSources): Float32Array<ArrayBuffer> {
  const { catalog, info } = sources,
    fast = new Float32Array(sources.fast),
    references = new Uint32Array(sources.references),
    records = new Float32Array(sources.records),
    surfaces = new Uint8Array(sources.surfaces),
    surfaceSpecular = new Uint8Array(sources.surfaceSpecular),
    atlas = new Uint8Array(sources.atlas),
    atlasSpecular = new Uint8Array(sources.atlasSpecular),
    result = new Float32Array(catalog.models.length * 8);
  // 面贴图第 0 级里每层的平均自发光，按颜色的不透明度加权。
  const layerGlow = new Map<number, number>();
  function surfaceGlow(layer: number): number {
    let value = layerGlow.get(layer);
    if (value !== undefined) return value;
    const size = info.side * info.side * 4,
      start = layer * size;
    let sum = 0,
      weight = 0;
    for (let i = start; i < start + size; i += 4) {
      const alpha = surfaces[i + 3] / 255;
      sum += glow(surfaceSpecular[i + 3]) * alpha;
      weight += alpha;
    }
    value = weight > 0 ? sum / weight : 0;
    layerGlow.set(layer, value);
    return value;
  }
  // 四边形记录所用图集区域的平均：按不透明度加权的线性颜色、覆盖率、自发光。
  const regionAverage = new Map<string, number[]>();
  function region(record: number): number[] {
    const r = record * 28,
      ax = records[r + 8], ay = records[r + 9], uz = records[r + 10], uw = records[r + 11],
      vx = records[r + 12], vy = records[r + 13];
    // 记录里的 uv 是 a.xy + u·a.zw + v·b.xy；取四个角的包围盒。
    const us = [ax, ax + uz, ax + vx, ax + uz + vx].map((v) => Math.min(1, Math.max(0, v))),
      vs = [ay, ay + uw, ay + vy, ay + uw + vy].map((v) => Math.min(1, Math.max(0, v)));
    const [x, y, w, h] = records.subarray(r + 16, r + 20),
      left = Math.floor((x + Math.min(...us) * w) * info.atlasWidth),
      right = Math.max(left + 1, Math.ceil((x + Math.max(...us) * w) * info.atlasWidth)),
      top = Math.floor((y + Math.min(...vs) * h) * info.atlasHeight),
      bottom = Math.max(top + 1, Math.ceil((y + Math.max(...vs) * h) * info.atlasHeight));
    const key = `${left},${top},${right},${bottom}`;
    let value = regionAverage.get(key);
    if (value) return value;
    const stepX = Math.max(1, (right - left) / SAMPLES),
      stepY = Math.max(1, (bottom - top) / SAMPLES);
    let red = 0, green = 0, blue = 0, coverage = 0, light = 0, count = 0;
    for (let py = top + stepY / 2; py < bottom; py += stepY)
      for (let px = left + stepX / 2; px < right; px += stepX) {
        const i = (Math.min(info.atlasHeight - 1, Math.floor(py)) * info.atlasWidth +
          Math.min(info.atlasWidth - 1, Math.floor(px))) * 4,
          alpha = atlas[i + 3] / 255;
        red += linear(atlas[i] / 255) * alpha;
        green += linear(atlas[i + 1] / 255) * alpha;
        blue += linear(atlas[i + 2] / 255) * alpha;
        light += glow(atlasSpecular[i + 3]) * alpha;
        coverage += alpha;
        count++;
      }
    const scale = coverage > 0 ? 1 / coverage : 0;
    value = [red * scale, green * scale, blue * scale, coverage / Math.max(1, count), light * scale];
    regionAverage.set(key, value);
    return value;
  }
  catalog.models.forEach((model, index) => {
    let red = 0, green = 0, blue = 0, covered = 0, area = 0, light = 0, blend = false;
    if (model.kind === 1 || model.kind === 3) {
      for (let face = 0; face < 6; face++) {
        const o = model.offset * 4 + face * 16,
          alpha = fast[o + 15],
          layer = fast[o + 6];
        red += linear(fast[o + 12]) * alpha;
        green += linear(fast[o + 13]) * alpha;
        blue += linear(fast[o + 14]) * alpha;
        light += (layer >= 0 ? surfaceGlow(layer) : 0) * alpha;
        covered += alpha;
        area += 1;
        if (fast[o + 7] % 2 === 1) blend = true;
      }
    } else if (model.kind === 2) {
      for (let i = model.offset; i < model.offset + model.count; i++) {
        const record = references[i * 4 + 2],
          r = record * 28,
          [cr, cg, cb, coverage, emission] = region(record),
          // 面内参数 u、v 的梯度互为对偶，平行四边形面积是两者叉积长度的倒数。
          ux = records[r], uy = records[r + 1], uz = records[r + 2],
          vx = records[r + 4], vy = records[r + 5], vz = records[r + 6],
          size = 1 / Math.max(1e-6, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)),
          alpha = coverage * records[r + 23],
          weight = size * alpha;
        red += cr * records[r + 20] * weight;
        green += cg * records[r + 21] * weight;
        blue += cb * records[r + 22] * weight;
        light += emission * weight;
        covered += weight;
        area += size;
        if (records[r + 14] === 2) blend = true;
      }
    }
    if (covered <= 0) return;
    const opacity = covered / area,
      at = index * 8;
    result[at] = red / covered;
    result[at + 1] = green / covered;
    result[at + 2] = blue / covered;
    result[at + 3] = blend || opacity < 0.5 ? opacity : 1;
    result[at + 4] = light / covered;
  });
  return result;
}
