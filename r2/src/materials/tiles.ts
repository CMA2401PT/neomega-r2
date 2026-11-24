import { crop, decodePNG, image, solid, type Pixels } from "./images.ts";

export type PackFiles = Record<string, Uint8Array>;
export function json<T>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data));
}
const aliases: Record<string, string> = {
  bricks: "brick",
  stone_bricks: "stonebrick",
  oak_planks: "planks_oak",
  sandstone: "sandstone_normal",
  chiseled_stone_bricks: "stonebrick_carved",
  cracked_stone_bricks: "stonebrick_cracked",
  mossy_stone_bricks: "stonebrick_mossy",
};

/** 材质包只覆盖存在且可读的通道，损坏的单张图片沿用原版。 */
function optionalPNG(files: PackFiles, name: string): Pixels | undefined {
  if (!files[name]) return;
  try {
    return decodePNG(files[name]);
  } catch {
    return;
  }
}

type OptionalTile = [Pixels?, Pixels?, Pixels?];
function javaTile(files: PackFiles, name: string): OptionalTile {
  const [namespace, path] = name.split(":");
  const base = "assets/" + namespace + "/textures/" + path;
  return ["", "_n", "_s"].map((suffix) => {
    const img = optionalPNG(files, base + suffix + ".png");
    if (!img) return;
    const meta = files[base + suffix + ".png.mcmeta"] ?? files[base + ".png.mcmeta"];
    if (!meta) return img;
    try {
      const anim = json<{
        animation?: { width?: number; height?: number; frames?: (number | { index: number })[] };
      }>(meta).animation;
      if (!anim) return img;
      const size = Math.min(img.width, img.height);
      const w = anim.width || (anim.height ? img.width : size),
        h = anim.height || (anim.width ? img.height : size);
      const first = anim.frames?.[0] ?? 0,
        index = typeof first === "number" ? first : first.index;
      const cols = Math.floor(img.width / w),
        x = (index % cols) * w,
        y = Math.floor(index / cols) * h;
      if (cols && index >= 0 && w > 0 && h > 0 && y + h <= img.height) return crop(img, x, y, w, h);
    } catch {
      return;
    }
  }) as OptionalTile;
}

/** 将基岩高度图的邻点斜率转成法线，最高点对应方块表面。 */
function heightNormals(src: Pixels): Pixels {
  const { width: w, height: h, data } = src,
    result = image(w, h);
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, data[i]);
  const height = (x: number, y: number) => data[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = ((height(x - 1, y) - height(x + 1, y)) * w) / 32,
        dy = ((height(x, y - 1) - height(x, y + 1)) * h) / 32;
      const scale = 127.5 / Math.sqrt(1 + dx * dx + dy * dy),
        i = (y * w + x) * 4;
      result.data.set(
        [
          Math.round(127.5 + dx * scale),
          Math.round(127.5 + dy * scale),
          255,
          255 - Math.round((peak - data[i]) / 8),
        ],
        i,
      );
    }
  return result;
}
type Layer = string | number[];
function bedrockTile(files: PackFiles, prefix: string, texture: string): OptionalTile {
  if (!texture.startsWith("minecraft:block/")) return [];
  const name = texture.slice("minecraft:block/".length);
  const raw =
    files[prefix + name + ".texture_set.json"] ?? files[prefix + aliases[name] + ".texture_set.json"];
  if (!raw) return [];
  let def: Record<string, Layer>;
  try {
    def = json<Record<string, Record<string, Layer>>>(raw)["minecraft:texture_set"];
  } catch {
    return [];
  }
  if (!def) return [];
  function layer(value?: Layer): Pixels | undefined {
    if (Array.isArray(value) && value.length >= 3)
      return solid(value[0], value[1], value[2], value[3] ?? 255);
    if (typeof value !== "string") return;
    const img = optionalPNG(files, prefix + value + ".png");
    return img && img.height > img.width && img.height % img.width === 0
      ? crop(img, 0, 0, img.width, img.width)
      : img;
  }
  let normal = layer(def.normal);
  if (normal) {
    for (let i = 0; i < normal.data.length; i += 4) normal.data[i + 2] = normal.data[i + 3] = 255;
  } else {
    const heights = layer(def.heightmap);
    if (heights) normal = heightNormals(heights);
  }
  const mer = layer(def.metalness_emissive_roughness);
  if (mer)
    for (let i = 0; i < mer.data.length; i += 4) {
      const d = mer.data;
      d.set([255 - d[i + 2], d[i] >= 128 ? 230 : 10, 0, Math.round((d[i + 1] * 254) / 255)], i);
    }
  return [layer(def.color), normal, mer];
}

/** 基岩包可能把 textures/blocks 放在 ZIP 中的一层外包装目录下。 */
export function replacementReader(files: PackFiles): (texture: string) => OptionalTile {
  const roots = Object.keys(files).flatMap(
    (name) => name.match(/^(?:[^/]+\/)?textures\/blocks\//)?.[0] ?? [],
  );
  const root = roots.includes("textures/blocks/") ? "textures/blocks/" : roots.sort()[0];
  return root ? (name) => bedrockTile(files, root, name) : (name) => javaTile(files, name);
}
