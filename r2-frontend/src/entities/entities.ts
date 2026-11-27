import type { ObjectDescriptor, ObjectFactory, ObjectRegistry, Vec3 } from "neomega-r2-core";
import { isCompound, parseSNBT, type Compound } from "../libs/snbt.ts";
import { frameRenderer } from "./item-frame/frame.ts";

export interface EntityRenderer {
  appearance(nbt: Compound): Pick<ObjectDescriptor, "data" | "appearanceKey"> | undefined;
  factory: ObjectFactory;
}

const renderers = new Map<string, EntityRenderer>([
  ["minecraft:item_frame", frameRenderer], ["minecraft:glow_item_frame", frameRenderer],
]);

/** 注册表把 Java 实体类型与其外观处理器对应起来，核心只收到渲染对象。 */
export function registerEntities(registry: ObjectRegistry): void {
  for (const [kind, renderer] of renderers) registry.register(kind, renderer.factory);
}

/** UUID 标识单个实体。未分配 UUID 的结构模板使用该区域快照中的序号。 */
export function entityObject(snbt: string, fallback: string): ObjectDescriptor | undefined {
  const nbt = parseSNBT(snbt);
  if (!isCompound(nbt) || typeof nbt.id !== "string") return;
  const kind = nbt.id, renderer = renderers.get(kind);
  if (!renderer) return;
  const appearance = renderer.appearance(nbt);
  if (!appearance) return;
  if (!Array.isArray(nbt.Pos) || nbt.Pos.length !== 3 || !nbt.Pos.every(n => typeof n === "number" && Number.isFinite(n)))
    throw new SyntaxError("实体 Pos 应为三个世界坐标");
  const uuid = nbt.UUID;
  const identity = uuid instanceof Int32Array ? uuid.join(",") : typeof uuid === "string" ? uuid
    : typeof nbt.UUIDMost === "bigint" && typeof nbt.UUIDLeast === "bigint" ? nbt.UUIDMost + "/" + nbt.UUIDLeast : fallback;
  return { key: "entity/" + identity, kind, position: nbt.Pos as Vec3, ...appearance };
}
