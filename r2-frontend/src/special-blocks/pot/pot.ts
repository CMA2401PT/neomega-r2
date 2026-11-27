import type { ObjectRecipe } from "neomega-r2-core";
import { isCompound, type Compound } from "../../libs/snbt.ts";
import { bare, surface } from "../surface.ts";
import { atlasURL, tiles } from "./assets.ts";

/** 兼容旧版四项列表和新版按面命名的陶片；罐中物品不参与外观。 */
export function potFaces(nbt: Compound): number[] | undefined {
  const sherds = nbt.sherds;
  const sides = ["back", "left", "right", "front"].map((name, i) => {
    const item = Array.isArray(sherds) ? sherds[i] : isCompound(sherds) ? sherds[name] : undefined;
    const id = isCompound(item) ? item.id : item;
    const pattern = typeof id === "string" && /^(?:minecraft:)?(\w+)_pottery_sherd$/.exec(id);
    return pattern ? tiles.indexOf(pattern[1]) : -1;
  });
  return sides.some((i) => i >= 0) ? sides : undefined;
}

/** 北向陶罐的 front 在南面。每一个纹样只取原图中央的十四列像素。 */
export function decoratedPot(data: { sides: number[]; rotation: number }): ObjectRecipe {
  const [back, left, right, front] = data.sides;
  function face(tile: number, mirror: boolean) {
    if (tile < 0) return bare;
    return [(tile % 8) * 16 + (mirror ? 15 : 1), Math.floor(tile / 8) * 16, mirror ? -14 : 14, 16];
  }
  return surface(
    { url: atlasURL },
    [0.98, 0, 0.98],
    [15.02, 16, 15.02],
    [face(left, false), face(right, true), bare, bare, face(back, true), face(front, false)],
    data.rotation,
  );
}
