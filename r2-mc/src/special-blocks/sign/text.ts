import { isCompound, type Tag, type Compound } from "../../libs/snbt.ts";

const inks: Record<string, number> = {
  white: 16777215,
  orange: 16738335,
  magenta: 16711935,
  light_blue: 10141901,
  yellow: 16776960,
  lime: 12582656,
  pink: 16738740,
  gray: 8421504,
  light_gray: 13882323,
  cyan: 65535,
  purple: 10494192,
  blue: 255,
  brown: 9127187,
  green: 65280,
  red: 16711680,
  black: 0,
};
const names = [
  "black",
  "dark_blue",
  "dark_green",
  "dark_aqua",
  "dark_red",
  "dark_purple",
  "gold",
  "gray",
  "dark_gray",
  "blue",
  "green",
  "aqua",
  "red",
  "light_purple",
  "yellow",
  "white",
];
const colors = [
  0, 0xaa, 0xaa00, 0xaaaa, 0xaa0000, 0xaa00aa, 0xffaa00, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff,
  0xff5555, 0xff55ff, 0xffff55, 0xffffff,
];
type Style = {
  color: number;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
};
export type Run = Style & { text: string };
export interface SignSide {
  lines: Run[][];
  glow: boolean;
  edge: number;
}

/** 降低文字染料亮度；普通字和发光字的轮廓使用同样的比例。 */
function dark(rgb: number): number {
  return (
    (Math.floor((rgb >> 16) * 0.4) << 16) |
    (Math.floor(((rgb >> 8) & 255) * 0.4) << 8) |
    Math.floor((rgb & 255) * 0.4)
  );
}

/** 将旧 JSON 或新 NBT 文本组件展开成带样式的文字段，子组件继承父样式。 */
function runs(value: Tag | undefined, style: Style, out: Run[]): void {
  if (Array.isArray(value)) {
    for (const child of value) runs(child, style, out);
    return;
  }
  if (value === undefined || value === null) return;
  if (isCompound(value)) {
    const next = { ...style };
    for (const key of ["bold", "italic", "underlined", "strikethrough"] as const)
      if (value[key] !== undefined) next[key] = Boolean(value[key]);
    if (typeof value.color === "string") {
      const index = names.indexOf(value.color);
      if (index >= 0) next.color = colors[index];
      else if (/^#[0-9a-f]{6}$/i.test(value.color)) next.color = parseInt(value.color.slice(1), 16);
    }
    if (value.translate) {
      let arg = 0;
      const args = Array.isArray(value.with) ? value.with : [];
      for (const part of String(value.fallback ?? value.translate).split(/(%(?:\d+\$)?s|%%)/)) {
        if (part === "%%") runs("%", next, out);
        else if (/^%(?:\d+\$)?s$/.test(part))
          runs(args[part === "%s" ? arg++ : parseInt(part.slice(1)) - 1], next, out);
        else runs(part, next, out);
      }
    } else
      runs(
        value.text ??
          value.keybind ??
          (isCompound(value.score) ? value.score.value : undefined) ??
          (value.selector || value.nbt ? "…" : undefined),
        next,
        out,
      );
    runs(value.extra, next, out);
    return;
  }
  let active = { ...style };
  for (const part of String(value).split(/(§[0-9a-fklmnor])/gi)) {
    if (!part) continue;
    if (part.length !== 2 || part[0] !== "§") {
      out.push({ ...active, text: part });
      continue;
    }
    const code = part[1].toLowerCase(),
      color = "0123456789abcdef".indexOf(code);
    if (color >= 0) active = { color: colors[color] };
    else if (code === "r") active = { ...style };
    else if (code === "l") active.bold = true;
    else if (code === "o") active.italic = true;
    else if (code === "n") active.underlined = true;
    else if (code === "m") active.strikethrough = true;
  }
}

/** 一面最多四行。没有现代正面字段时，读取旧存档的 Text1 至 Text4。 */
export function signSides(nbt: Compound): SignSide[] | undefined {
  const sides = ["front_text", "back_text"].map((key, index) => {
    const tag = nbt[key];
    // Bedrock 的文字以换行分隔，颜色直接保存为 ARGB。
    const bedrock = nbt[index === 0 ? "FrontText" : "BackText"] ?? (index === 0 ? nbt : undefined);
    const native = isCompound(bedrock) && typeof bedrock.Text === "string" ? bedrock : undefined;
    const side = native
      ? {
          messages: String(native.Text).split(/\r?\n/),
          color: "black",
          has_glowing_text: native.IgnoreLighting,
        }
      : isCompound(tag)
        ? tag
        : index === 0
          ? {
              messages: [nbt.Text1, nbt.Text2, nbt.Text3, nbt.Text4],
              color: nbt.Color,
              has_glowing_text: nbt.GlowingText,
            }
          : {};
    const ink =
        typeof native?.SignTextColor === "number"
          ? native.SignTextColor & 0xffffff
          : (inks[String(side.color)] ?? 0),
      glow = Boolean(side.has_glowing_text);
    const lines = (Array.isArray(side.messages) ? side.messages.slice(0, 4) : []).map((message) => {
      if (!native && typeof message === "string" && /^\s*[[{"]/.test(message)) {
        try {
          message = JSON.parse(message);
        } catch {
          /* 文字本身也可能以括号开头。 */
        }
      }
      const line: Run[] = [];
      runs(message, { color: glow ? ink : dark(ink) }, line);
      return line;
    });
    return { lines, glow, edge: ink ? dark(ink) : 0xf0ebcc };
  });
  return sides.some((side) => side.lines.some((line) => line.length)) ? sides : undefined;
}
