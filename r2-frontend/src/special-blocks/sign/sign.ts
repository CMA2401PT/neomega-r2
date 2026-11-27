import type { MeshRecipe, Vec3 } from "neomega-r2-core";
import { bare, surface } from "../surface.ts";
import { glyphURL } from "./assets.ts";
import type { Run, SignSide } from "./text.ts";

interface Font {
  bytes: DataView;
  offsets: Map<number, number>;
}
let font: Promise<Font> | undefined;

/** 首次显示有字的牌时解压字模；之后每个字符直接按码点定位。 */
async function loadFont(): Promise<Font> {
  const stream = (await fetch(glyphURL)).body!.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new DataView(await new Response(stream).arrayBuffer());
  const offsets = new Map<number, number>();
  for (let at = 0; at < bytes.byteLength;) {
    offsets.set(bytes.getUint32(at, true), at);
    at += 9 + Math.ceil(bytes.getUint8(at + 4) / 8) * bytes.getUint8(at + 8);
  }
  return { bytes, offsets };
}

/** 在同一张透明图的上下两半绘制正背面，反面 UV 由观看方向决定。 */
async function signPixels(sides: SignSide[], width: number, height: number, hanging: boolean): Promise<Uint8Array> {
  const { bytes, offsets } = await (font ??= loadFont());
  const pixels = new Uint8Array(width * height * 2 * 4);
  function dot(x: number, y: number, side: number, color: number) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = ((side * height + y) * width + x) * 4;
    pixels[i] = color >> 16;
    pixels[i + 1] = color >> 8;
    pixels[i + 2] = color;
    pixels[i + 3] = 255;
  }
  for (const [sideIndex, side] of sides.entries()) {
    const spacing = hanging ? 18 : 20;
    for (const [lineIndex, line] of side.lines.entries()) {
      const chars: { at: number; x: number; advance: number; style: Run }[] = [];
      let length = 0,
        lastSpace = -1;
      line: for (const style of line)
        for (const char of style.text) {
          if (char === "\n" || char === "\r") break line;
          const at = offsets.get(char.codePointAt(0)!) ?? offsets.get(0x25a1)!;
          const advance = bytes.getUint8(at + 6) + (style.bold ? bytes.getUint8(at + 7) : 0);
          if (char === " ") lastSpace = chars.length;
          if (length + advance > (hanging ? 120 : 180)) {
            if (lastSpace >= 0) {
              length = chars[lastSpace]?.x ?? length;
              chars.length = lastSpace;
            }
            break line;
          }
          chars.push({ at, x: length, advance, style });
          length += advance;
        }
      const left = Math.floor((width - length) / 2),
        top = (height - 4 * spacing) / 2 + lineIndex * spacing;
      for (const outline of side.glow ? [true, false] : [false])
        for (const { at, x, advance, style } of chars) {
          const w = bytes.getUint8(at + 4),
            h = bytes.getUint8(at + 8),
            dy = bytes.getInt8(at + 5);
          const spread = bytes.getUint8(at + 7),
            stride = Math.ceil(w / 8);
          for (let row = 0; row < h; row++)
            for (let col = 0; col < w; col++) {
              const bit = w - col - 1;
              if (!(bytes.getUint8(at + 9 + row * stride + (bit >> 3)) & (1 << (bit & 7)))) continue;
              const px = left + x + col + (style.italic ? Math.round(2 - (row + dy) / 4) : 0);
              const py = top + row + dy;
              for (const dx of outline ? [-spread, 0, spread] : [0])
                for (const oy of outline ? [-spread, 0, spread] : [0]) {
                  dot(px + dx, py + oy, sideIndex, outline ? side.edge : style.color);
                  if (style.bold)
                    dot(px + dx + spread, py + oy, sideIndex, outline ? side.edge : style.color);
                }
            }
          if (!outline)
            for (let col = 0; col < advance; col++)
              for (const dy of [0, 1]) {
                if (style.underlined) dot(left + x + col, top + 16 + dy, sideIndex, style.color);
                if (style.strikethrough) dot(left + x + col, top + 7 + dy, sideIndex, style.color);
              }
        }
    }
  }
  return pixels;
}

/** 用正背面文字覆盖牌面。相同版式和文字可以在不同朝向的牌面上共用。 */
export function sign(data: {
  sides: SignSide[];
  hanging: boolean;
  wall: boolean;
  rotation: number;
}): MeshRecipe {
  const width = data.hanging ? 128 : 192, height = 96;
  const bottom = data.wall ? 4.33333 : 9.33333,
    z = data.wall ? 0.33333 : 7.33333;
  const low: Vec3 = data.hanging ? [0.8, -0.52, 6.98] : [0, bottom, z - 0.02];
  const high: Vec3 = data.hanging ? [15.2, 10.28, 9.02] : [16, bottom + 8, z + 1.35334];
  return surface(
    {
      width,
      height: height * 2,
      cacheKey: "sign/" + width + "/" + JSON.stringify(data.sides),
      renderPixels: () => signPixels(data.sides, width, height, data.hanging),
    },
    low,
    high,
    [bare, bare, bare, bare, [width, height, -width, height], [0, 0, width, height]],
    data.rotation,
    (data.sides[0].glow ? 1 << 5 : 0) | (data.sides[1].glow ? 1 << 4 : 0),
  );
}
