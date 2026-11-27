import type { ObjectDescriptor, RenderRecipe, ObjectRegistry, Vec3 } from "neomega-r2-core";
import { isCompound, parseSNBT, type Compound } from "../libs/snbt.ts";
import type { MinecraftAssets } from "../contracts.ts";
import { frameRenderer } from "./item-frame/frame.ts";

export interface EntityRenderer {
  appearance(nbt: Compound): Pick<ObjectDescriptor, "data" | "appearanceKey"> | undefined;
  factory(descriptor: ObjectDescriptor, assets: MinecraftAssets): RenderRecipe | Promise<RenderRecipe>;
}

const renderers = new Map<string, EntityRenderer>([
  ["minecraft:item_frame", frameRenderer], ["minecraft:glow_item_frame", frameRenderer],
]);

/** 注册表把 Java 实体类型与其外观处理器对应起来，核心只收到渲染对象。 */
export function registerEntities(registry: ObjectRegistry, assets: MinecraftAssets): void {
  for (const [kind, renderer] of renderers) registry.register(kind, descriptor => renderer.factory(descriptor, assets));
}

/** 实例 ID 由数据源提供；SNBT 中的 id 仅用于选取外观。 */
export function entityObject(entityId: string, snbt: string): ObjectDescriptor | undefined {
  const nbt = parseSNBT(snbt);
  if (!isCompound(nbt) || typeof nbt.id !== "string") return;
  const kind = nbt.id, renderer = renderers.get(kind);
  if (!renderer) return;
  const appearance = renderer.appearance(nbt);
  if (!appearance) return;
  if (!Array.isArray(nbt.Pos) || nbt.Pos.length !== 3 || !nbt.Pos.every(n => typeof n === "number" && Number.isFinite(n)))
    throw new SyntaxError("实体 Pos 应为三个世界坐标");
  return { key: "entity/" + entityId, kind, position: nbt.Pos as Vec3, ...appearance };
}
