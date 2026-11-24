import { decode } from "fast-png";

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}
export type Tile = [Pixels, Pixels, Pixels];
export interface Part {
  texture: string;
  uv: number[];
  tint: number[];
  cutout?: boolean;
}

export function image(width: number, height: number): Pixels {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function solid(...rgba: number[]): Pixels {
  return { width: 1, height: 1, data: Uint8Array.from(rgba) };
}

/** 直接解码 PNG 样本，保留法线与高光图里透明像素的 RGB。 */
export function decodePNG(bytes: Uint8Array): Pixels {
  const png = decode(bytes);
  const { width, height, depth, channels, data, palette, transparency } = png;
  // 普通 RGBA8 已经是 GPU 需要的未预乘排列。
  if (!palette && depth === 8 && channels === 4) return { width, height, data: Uint8Array.from(data) };
  const out = image(width, height);
  const max = 2 ** depth - 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const first =
        depth < 8
          ? (data[y * Math.ceil((width * depth) / 8) + ((x * depth) >> 3)] >>
              (8 - depth - ((x * depth) % 8))) &
            max
          : data[i * channels];
      if (palette) {
        const color = palette[first];
        out.data[i * 4 + 3] = 255;
        out.data.set(color, i * 4);
      } else {
        const gray = channels <= 2;
        const rgb = [first, gray ? first : data[i * channels + 1], gray ? first : data[i * channels + 2]];
        const transparent = transparency?.length && transparency.every((v, c) => v === rgb[c]);
        const alpha = channels % 2 === 0 ? data[i * channels + channels - 1] : transparent ? 0 : max;
        out.data.set(
          [...rgb, alpha].map((v) => (depth === 16 ? v >>> 8 : Math.round((255 * v) / max))),
          i * 4,
        );
      }
    }
  return out;
}

/** 按行复制未经颜色转换的像素，供裁动画帧与拼图集共用。 */
export function copyRect(
  src: Pixels,
  dst: Pixels,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  w: number,
  h: number,
) {
  for (let y = 0; y < h; y++) {
    const start = ((sy + y) * src.width + sx) * 4;
    dst.data.set(src.data.subarray(start, start + w * 4), ((dy + y) * dst.width + dx) * 4);
  }
}
export function crop(src: Pixels, x: number, y: number, w: number, h: number): Pixels {
  const dst = image(w, h);
  copyRect(src, dst, x, y, 0, 0, w, h);
  return dst;
}

const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
export function srgb(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}
function sample(src: Pixels, u: number, v: number): number {
  const x = Math.max(0, Math.min(src.width - 1, Math.floor(u * src.width)));
  const y = Math.max(0, Math.min(src.height - 1, Math.floor(v * src.height)));
  return (y * src.width + x) * 4;
}

/** 放大时保持像素边缘，缩小时按覆盖面积平均。颜色用线性预乘，数据通道独立平均。 */
export function resize(src: Pixels, w: number, h: number, color: boolean): Pixels {
  if (w === src.width && h === src.height) return src;
  const dst = image(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const out = (y * w + x) * 4;
      if (w >= src.width && h >= src.height) {
        const i = sample(src, (x + 0.5) / w, (y + 0.5) / h);
        dst.data.set(src.data.subarray(i, i + 4), out);
        continue;
      }
      const x0 = (x * src.width) / w,
        x1 = ((x + 1) * src.width) / w;
      const y0 = (y * src.height) / h,
        y1 = ((y + 1) * src.height) / h;
      const sum = [0, 0, 0, 0];
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const area = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
          const i = (sy * src.width + sx) * 4;
          for (let c = 0; c < 4; c++)
            sum[c] +=
              area *
              (color && c < 3 ? (linear[src.data[i + c]] * src.data[i + 3]) / 255 : src.data[i + c] / 255);
          weight += area;
        }
      for (let c = 0; c < 4; c++)
        dst.data[out + c] =
          color && c < 3 ? srgb(sum[3] ? sum[c] / sum[3] : 0) : Math.round((sum[c] / weight) * 255);
    }
  return dst;
}

/** 按面配方叠加颜色。覆盖层的可见性也决定这一点使用哪张法线和高光图。 */
export function compose(parts: Part[], tiles: Map<string, Tile>, side: number): Tile {
  const result: Tile = [image(side, side), image(side, side), image(side, side)];
  const [color, normal, specular] = result.map((img) => img.data);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      normal.set([128, 128, 255, 255], i);
      for (const { texture, uv, tint, cutout } of parts) {
        const tile = tiles.get(texture)!;
        const u = (x + 0.5) / side,
          v = (y + 0.5) / side;
        const s = uv[0] + u * uv[2] + v * uv[4],
          t = uv[1] + u * uv[3] + v * uv[5];
        const front = tile[0].data,
          p = sample(tile[0], s, t);
        if (cutout && front[p + 3] < 26) continue;
        const a = cutout && parts.length > 1 ? 1 : front[p + 3] / 255;
        const back = (color[i + 3] / 255) * (1 - a),
          alpha = a + back;
        if (alpha)
          for (let c = 0; c < 3; c++)
            color[i + c] = srgb(
              (linear[front[p + c]] * Math.fround(tint[c]) * a + linear[color[i + c]] * back) / alpha,
            );
        color[i + 3] = Math.round(alpha * 255);
        if (parts.length === 1 || a) {
          const n = sample(tile[1], s, t),
            sp = sample(tile[2], s, t);
          normal.set(tile[1].data.subarray(n, n + 4), i);
          specular.set(tile[2].data.subarray(sp, sp + 4), i);
        }
      }
    }
  return result;
}

/** 缩小过程保留浮点精度，只在写出各级 GPU 纹理时量化。 */
export function* mipLevels(img: Pixels, color: boolean): Generator<Uint8Array> {
  let values = Float64Array.from(img.data, (v, i) =>
    color && i % 4 < 3 ? linear[v] * (img.data[i - (i % 4) + 3] / 255) : v / 255,
  );
  for (let side = img.width; ; side /= 2) {
    yield Uint8Array.from(values, (v, i) => (color && i % 4 < 3 ? srgb(v) : Math.round(v * 255)));
    if (side === 1) return;
    const next = new Float64Array(values.length / 4);
    for (let y = 0; y < side; y++)
      for (let x = 0; x < side; x++) {
        const src = (y * side + x) * 4,
          dst = ((y >> 1) * (side / 2) + (x >> 1)) * 4;
        for (let c = 0; c < 4; c++) next[dst + c] += values[src + c] / 4;
      }
    values = next;
  }
}

/** 裁切面和混合面使用不同的覆盖率来推导代表色及模型分类。 */
export function measure(img: Pixels) {
  const alpha = [0, 0],
    rgb = [
      [0, 0, 0],
      [0, 0, 0],
    ];
  for (let i = 0; i < img.data.length; i += 4)
    for (let mode = 0; mode < 2; mode++) {
      const a = mode ? img.data[i + 3] / 255 : Number(img.data[i + 3] >= 128);
      alpha[mode] += a;
      for (let c = 0; c < 3; c++) rgb[mode][c] += linear[img.data[i + c]] * a;
    }
  for (let mode = 0; mode < 2; mode++) {
    if (alpha[mode]) rgb[mode] = rgb[mode].map((v) => v / alpha[mode]);
    alpha[mode] /= img.width * img.height;
  }
  return { alpha, rgb };
}
