import type { MinecraftAssets } from "../contracts.ts";
import { blockHash, type ObjectRegistry, type ObjectDescriptor, type Vec3 } from "neomega-r2-core";
import { isCompound, parseSNBT } from "../libs/snbt.ts";
import { banner, bannerLayers, dyes } from "./banner/banner.ts";
import { enchantingBook } from "./book/book.ts";
import { decoratedPot, potFaces } from "./pot/pot.ts";
import { signSides } from "./sign/text.ts";
import { sign } from "./sign/sign.ts";

type State = {
  kind: "book" | "pot" | "banner" | "sign";
  rotation: number;
  wall?: boolean;
  hanging?: boolean;
  dye?: string;
};
const states = new Map<number, State>();
const directions = ["south", "west", "north", "east"];
const woods = [
  "acacia",
  "bamboo",
  "birch",
  "cherry",
  "crimson",
  "dark_oak",
  "jungle",
  "mangrove",
  "oak",
  "pale_oak",
  "poplar",
  "spruce",
  "warped",
];

/** 哈希包含完整的 Java 状态。干湿、开裂、悬链属性可共享同一个外观规则。 */
function register(name: string, props: Record<string, string>, state: State, waterlogged = false) {
  const variants = waterlogged
    ? [props, { ...props, waterlogged: "false" }, { ...props, waterlogged: "true" }]
    : [props];
  for (const fields of variants) {
    const values = Object.entries(fields).map(([key, value]) => `"${key}"="${value}"`);
    states.set(blockHash(`${name} [${values.join(",")}]`), state);
  }
}
register("enchanting_table", {}, { kind: "book", rotation: 0 });
for (const [i, facing] of directions.entries())
  for (const cracked of ["false", "true"])
    register("decorated_pot", { facing, cracked }, { kind: "pot", rotation: (i * 4 + 8) % 16 }, true);
for (let rotation = 0; rotation < 16; rotation++) {
  const facing = directions[rotation / 4];
  for (const dye of Object.keys(dyes)) {
    register(dye + "_banner", { rotation: String(rotation) }, { kind: "banner", rotation, dye });
    if (facing) register(dye + "_wall_banner", { facing }, { kind: "banner", rotation, dye, wall: true });
  }
  for (const wood of woods) {
    register(wood + "_sign", { rotation: String(rotation) }, { kind: "sign", rotation }, true);
    for (const attached of ["false", "true"])
      register(
        wood + "_hanging_sign",
        { rotation: String(rotation), attached },
        { kind: "sign", rotation, hanging: true },
        true,
      );
    if (facing) {
      register(wood + "_wall_sign", { facing }, { kind: "sign", rotation, wall: true }, true);
      register(
        wood + "_wall_hanging_sign",
        { facing },
        { kind: "sign", rotation, wall: true, hanging: true },
        true,
      );
    }
  }
}
export const hasAppearance = (hash: number) => states.has(hash);

/** 位置标识方块，外观由提取出的可见字段决定。只改罐内物品时沿用已安装的部件。 */
export function appearance(hash: number, position: Vec3, snbt?: string): ObjectDescriptor | undefined {
  const state = states.get(hash)!;
  const key = "block/" + position.join("/");
  if (state.kind === "book") return { key, kind: "enchanting_book", position };
  if (!snbt) return;
  const nbt = parseSNBT(snbt);
  if (!isCompound(nbt)) return;
  let data;
  if (state.kind === "pot") {
    const sides = potFaces(nbt);
    if (sides) data = { sides, rotation: state.rotation };
  } else if (state.kind === "banner") {
    const layers = bannerLayers(nbt, state.dye!);
    if (layers) data = { layers, rotation: state.rotation, wall: !!state.wall };
  } else {
    const sides = signSides(nbt);
    if (sides) data = { sides, rotation: state.rotation, wall: !!state.wall, hanging: !!state.hanging };
  }
  if (data)
    return { key, kind: state.kind, position, data, appearanceKey: JSON.stringify(data) };
}

/** 登记由方块状态或方块实体决定的内置外观。 */
export function registerBlocks(registry: ObjectRegistry, assets: MinecraftAssets): void {
  registry
    .register("enchanting_book", () => enchantingBook(assets.book))
    .register("pot", (d) => decoratedPot(d.data as Parameters<typeof decoratedPot>[0], assets.pot))
    .register("banner", (d) => banner(d.data as Parameters<typeof banner>[0], assets))
    .register("sign", (d) => sign(d.data as Parameters<typeof sign>[0], assets));
}
