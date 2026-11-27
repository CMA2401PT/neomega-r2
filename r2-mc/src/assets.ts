import type { MinecraftAssets } from "./contracts.ts";
import { bookURL } from "./special-blocks/book/assets.ts";
import { atlasURL as pot } from "./special-blocks/pot/assets.ts";
import { atlasURL as banner } from "./special-blocks/banner/assets.ts";
import { glyphURL } from "./special-blocks/sign/assets.ts";
import { frameURL } from "./entities/item-frame/assets.ts";
import { itemAtlasURL, shapesURL } from "./items/assets.ts";

export const defaultMinecraftAssets: MinecraftAssets = {
  book: bookURL, pot, banner, glyphs: glyphURL, frame: frameURL, items: itemAtlasURL, shapes: shapesURL,
};
