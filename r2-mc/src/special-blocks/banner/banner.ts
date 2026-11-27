import type { MinecraftAssets } from "../../contracts.ts";
import type { MeshRecipe } from "neomega-r2-core";
import { isCompound, type Compound } from "../../libs/snbt.ts";
import { surface } from "../surface.ts";
import { tiles } from "./assets.ts";

// Java 染料顺序同时对应旧版旗帜的数字颜色。
export const dyes = {
  white: 0xf9fffe,
  orange: 0xf9801d,
  magenta: 0xc74ebd,
  light_blue: 0x3ab3da,
  yellow: 0xfed83d,
  lime: 0x80c71f,
  pink: 0xf38baa,
  gray: 0x474f52,
  light_gray: 0x9d9d97,
  cyan: 0x169c9c,
  purple: 0x8932b8,
  blue: 0x3c44aa,
  brown: 0x835432,
  green: 0x5e7c16,
  red: 0xb02e26,
  black: 0x1d1d21,
};
const legacy: Record<string, string> = {
  b: "base",
  bl: "square_bottom_left",
  br: "square_bottom_right",
  tl: "square_top_left",
  tr: "square_top_right",
  bs: "stripe_bottom",
  ts: "stripe_top",
  ls: "stripe_left",
  rs: "stripe_right",
  cs: "stripe_center",
  ms: "stripe_middle",
  drs: "stripe_downright",
  dls: "stripe_downleft",
  ss: "small_stripes",
  cr: "cross",
  sc: "straight_cross",
  bt: "triangle_bottom",
  tt: "triangle_top",
  bts: "triangles_bottom",
  tts: "triangles_top",
  ld: "diagonal_left",
  rd: "diagonal_up_right",
  lud: "diagonal_up_left",
  rud: "diagonal_right",
  mc: "circle",
  mr: "rhombus",
  vh: "half_vertical",
  hh: "half_horizontal",
  vhr: "half_vertical_right",
  hhb: "half_horizontal_bottom",
  bo: "border",
  cbo: "curly_border",
  gra: "gradient",
  gru: "gradient_up",
  bri: "bricks",
  glb: "globe",
  cre: "creeper",
  sku: "skull",
  flo: "flower",
  moj: "mojang",
  pig: "piglin",
};
type Layer = [number, number];

/** 从底色向上叠加有效图案；未来版本的未知图案仍可在 SNBT 面板查看。 */
export function bannerLayers(nbt: Compound, dye: string): Layer[] | undefined {
  const entries = nbt.patterns ?? nbt.Patterns;
  if (!Array.isArray(entries)) return;
  const bedrock = nbt.id === "Banner";
  const palette = Object.values(dyes);
  const patternNames = bedrock
    ? {
        ...legacy,
        ld: "diagonal_up_left",
        lud: "diagonal_left",
        rd: "diagonal_right",
        rud: "diagonal_up_right",
        flw: "flow",
        gus: "guster",
      }
    : legacy;
  const layers: Layer[] = [[tiles.indexOf("base"), dyes[dye as keyof typeof dyes]]];
  for (const entry of entries) {
    if (!isCompound(entry)) continue;
    const pattern =
      typeof entry.pattern === "string"
        ? entry.pattern.replace(/^minecraft:/, "")
        : patternNames[String(entry.Pattern)];
    const index = tiles.indexOf(pattern);
    const color =
      typeof entry.color === "string"
        ? dyes[entry.color as keyof typeof dyes]
        : palette[bedrock ? 15 - Number(entry.Color) : Number(entry.Color)];
    if (index >= 0 && typeof color === "number") layers.push([index, color]);
  }
  return layers.length > 1 ? layers : undefined;
}

const atlases = new WeakMap<MinecraftAssets, Promise<ImageData>>();
async function readAtlas(url: string): Promise<ImageData> {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  const ctx = new OffscreenCanvas(image.width, image.height).getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  image.close();
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** 给原版图案的布料明暗染色，然后按透明度从下向上绘制。 */
async function bannerPixels(layers: Layer[], assets: MinecraftAssets): Promise<Uint8Array> {
  if (!atlases.has(assets)) atlases.set(assets, readAtlas(assets.banner));
  const { width, data: atlasPixels } = await atlases.get(assets)!;
  const pixels = new Uint8Array(64 * 64 * 4);
  for (const [tile, color] of layers) {
    const tint = [color >> 16, (color >> 8) & 255, color & 255];
    const start = (tile % 8) * 64 + Math.floor(tile / 8) * 64 * width;
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const src = (start + y * width + x) * 4,
          dst = (y * 64 + x) * 4;
        const alpha = atlasPixels[src + 3] / 255,
          under = (pixels[dst + 3] / 255) * (1 - alpha);
        if (!alpha) continue;
        for (let c = 0; c < 3; c++)
          pixels[dst + c] = Math.round(
            ((alpha * atlasPixels[src + c] * tint[c]) / 255 + under * pixels[dst + c]) / (alpha + under),
          );
        pixels[dst + 3] = Math.round((alpha + under) * 255);
      }
  }
  return pixels;
}

/** 安装旗布的表面，立旗和墙旗共用相同图案的贴图。 */
export function banner(data: {
  layers: Layer[];
  rotation: number;
  wall: boolean;
}, assets: MinecraftAssets): MeshRecipe {
  const bottom = data.wall ? -13.333 : 2.667,
    back = data.wall ? 1.417 : 8.667;
  return surface(
    {
      width: 64,
      height: 64,
      cacheKey: "banner/" + JSON.stringify(data.layers),
      renderPixels: () => bannerPixels(data.layers, assets),
    },
    [1.31, bottom - 0.02, back - 0.02],
    [14.69, bottom + 26.69, back + 0.687],
    [
      [21, 1, 1, 40],
      [0, 1, 1, 40],
      [22, 0, 20, 1],
      [1, 0, 20, 1],
      [42, 1, -20, 40],
      [1, 1, 20, 40],
    ],
    data.rotation,
  );
}
