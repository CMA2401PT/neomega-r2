import type { Catalog, TextureSet } from "neomega-r2-core";
import {
  compose,
  copyRect,
  crop,
  decodePNG,
  image,
  measure,
  mipLevels,
  resize,
  solid,
  srgb,
  type Part,
  type Tile,
} from "./images.ts";
import { json, replacementReader, type PackFiles } from "./tiles.ts";

interface Manifest {
  textures: Record<string, number[]>;
  layers: Part[][];
  quads: string[];
}
const surfaces = ["surface-layers.bin", "surface-normals.bin", "surface-specular.bin"];
const atlases = ["atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin"];
const powerOfTwo = (n: number) => 2 ** Math.ceil(Math.log2(n));
const emitting = new Set([
  "sea_lantern",
  "glowstone",
  "shroomlight",
  ...["ochre", "pearlescent", "verdant"].flatMap((color) => [
    color + "_froglight_side",
    color + "_froglight_top",
  ]),
]);

/** 三个通道共用图集布局，模型用相同的矩形采样颜色、法线和高光。 */
function buildAtlas(
  quads: string[],
  tiles: Map<string, Tile>,
  limit: number,
  files: Map<string, ArrayBuffer>,
) {
  const names = [...new Set(quads)].sort();
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  let area = 0,
    maxWidth = 1;
  for (const name of names) {
    const tile = tiles.get(name)!,
      color = tile[0];
    const edge = Math.min(limit, Math.max(...tile.map((img) => Math.max(img.width, img.height))));
    const scale = edge / Math.max(color.width, color.height);
    const w = Math.max(1, Math.round(color.width * scale)),
      h = Math.max(1, Math.round(color.height * scale));
    rects.set(name, { x: 0, y: 0, w, h });
    area += w * h;
    maxWidth = Math.max(maxWidth, w);
  }
  const width = powerOfTwo(Math.max(maxWidth, Math.ceil(Math.sqrt(area))));
  let x = 0,
    y = 0,
    row = 0;
  for (const rect of rects.values()) {
    if (x + rect.w > width) {
      x = 0;
      y += row;
      row = 0;
    }
    rect.x = x;
    rect.y = y;
    x += rect.w;
    row = Math.max(row, rect.h);
  }
  const height = powerOfTwo(Math.max(1, y + row));
  const images = atlases.map(() => image(width, height));
  const regions = new Map<string, number[]>(),
    holes = new Set<string>();
  for (const [name, { x, y, w, h }] of rects) {
    regions.set(name, [x / width, y / height, w / width, h / height]);
    tiles.get(name)!.forEach((img, c) => {
      const pixels = resize(img, w, h, c === 0);
      copyRect(pixels, images[c], 0, 0, x, y, w, h);
      if (c === 0 && pixels.data.some((v, i) => i % 4 === 3 && v < 26)) holes.add(name);
    });
  }
  images.forEach((img, c) => files.set(atlases[c], img.data.buffer));
  return { width, height, regions, holes };
}

/** 将指定版本的合成信息与用户材质叠加，返回可直接交给世界会话的贴图及派生表。 */
export function buildTextures(recipe: PackFiles, pack: PackFiles, limit = 128): TextureSet {
  if (![16, 32, 64, 128, 256, 512].includes(limit)) throw Error("贴图尺寸上限应为 16 至 512 的二次幂");
  const { textures, layers, quads } = json<Manifest>(recipe["textures.json"]);
  const base = decodePNG(recipe["base-atlas.png"]),
    replacement = replacementReader(pack);
  const surfaceNames = new Set(layers.flatMap((parts) => parts.map((p) => p.texture)));
  const tiles = new Map<string, Tile>();
  let side = 16;
  for (const [name, rect] of Object.entries(textures)) {
    const [u, v, w, h] = rect.map(Math.fround);
    const x = Math.round(u * base.width),
      y = Math.round(v * base.height);
    const original = crop(
      base,
      x,
      y,
      Math.round(Math.fround(u + w) * base.width) - x,
      Math.round(Math.fround(v + h) * base.height) - y,
    );
    const custom = replacement(name);
    const block = name.replace("minecraft:block/", "");
    const emission = emitting.has(block) ? 190 : block === "redstone_lamp_on" ? 170 : 0;
    tiles.set(name, [
      custom[0] ?? original,
      custom[1] ?? solid(128, 128, 255, 255),
      custom[2] ?? solid(0, 0, 0, emission),
    ]);
    if (surfaceNames.has(name))
      for (const img of custom) if (img) side = Math.max(side, img.width, img.height);
  }
  side = Math.min(limit, powerOfTwo(side));
  const layerTiles = new Map<string, Tile>();
  for (const name of surfaceNames) {
    layerTiles.set(
      name,
      tiles
        .get(name)!
        .map((img, c) =>
          img.width > side || img.height > side ? resize(img, side, side, c === 0) : img,
        ) as Tile,
    );
  }
  const files = new Map<string, ArrayBuffer>();
  const levels = 1 + Math.log2(side);
  // 每个通道按缩小级别排放整组方块层，所有级别的像素数是等比数列之和。
  const arrays = surfaces.map(() => new Uint8Array(((4 * side * side - 1) / 3) * 4 * layers.length));
  const colors = layers.map((parts, index) => {
    const tile = compose(parts, layerTiles, side);
    tile.forEach((img, c) => {
      let offset = 0;
      for (const mip of mipLevels(img, c === 0)) {
        arrays[c].set(mip, offset + index * mip.length);
        offset += mip.length * layers.length;
      }
    });
    return measure(tile[0]);
  });
  arrays.forEach((arr, c) => files.set(surfaces[c], arr.buffer));
  const atlas = buildAtlas(quads, tiles, limit, files);
  const info = { side, levels, layers: layers.length, atlasWidth: atlas.width, atlasHeight: atlas.height };
  const catalog = json<Catalog>(recipe["base-catalog.json"]);
  // 每次从同版本基表的独立副本开始，否则后一包会继承前一包的代表色或透明分类。
  const fast = new Float32Array(Uint8Array.from(recipe["base-fast.bin"]).buffer);
  const records = new Float32Array(Uint8Array.from(recipe["base-quad-records.bin"]).buffer);
  const headers = new Uint32Array(catalog.models.length * 4);
  catalog.models.forEach((model, i) => {
    if (model.kind === 1 || model.kind === 3) {
      model.kind = 1;
      for (let face = 0; face < 6; face++) {
        const p = model.offset * 4 + face * 16,
          layer = fast[p + 6];
        if (layer < 0) continue;
        const color = colors[layer],
          mode = fast[p + 7] & 1;
        if (!mode && color.alpha[0] < 1) model.kind = 3;
        for (let c = 0; c < 3; c++) fast[p + 12 + c] = srgb(color.rgb[mode][c] * fast[p + 8 + c]) / 255;
        fast[p + 15] = Math.fround(color.alpha[mode]) * fast[p + 11];
      }
    }
    headers.set([model.kind, model.offset, model.count, model.group], i * 4);
  });
  quads.forEach((name, i) => {
    records.set(atlas.regions.get(name)!, i * 28 + 16);
    if (records[i * 28 + 14] !== 2) records[i * 28 + 14] = Number(atlas.holes.has(name));
  });
  catalog.statistics.surfaceLayers = layers.length;
  files.set("headers.bin", headers.buffer);
  files.set("fast.bin", fast.buffer);
  files.set("quad-records.bin", records.buffer);
  const encoder = new TextEncoder();
  files.set("textures-info.json", encoder.encode(JSON.stringify(info)).buffer);
  files.set("catalog.json", encoder.encode(JSON.stringify(catalog)).buffer);
  return { info, files, catalog };
}
