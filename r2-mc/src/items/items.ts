import type { TriangleMesh, Vec3 } from "neomega-r2-core";
import { isCompound, type Tag } from "../libs/snbt.ts";
import catalog from "./catalog.json" with { type: "json" };
import type { MinecraftAssets } from "../contracts.ts";

interface ItemModel {
  shape: number;
  tiles: number[];
}

interface Quad {
  positions: Vec3[];
  uv: [number, number][];
  material: number;
  unlit?: boolean;
}

const models: Record<string, ItemModel> = catalog.items;
const shapes = new WeakMap<MinecraftAssets, Promise<Quad[][]>>();

/** 根据 Java 物品栈选择固定展示模型。显示名称、数量和附魔不影响选中的几何。 */
export function displayedModel(stack: Tag | undefined): string | undefined {
  if (!isCompound(stack)) return;
  const components = stack.components;
  const override = isCompound(components) ? components["minecraft:item_model"] ?? components.item_model : undefined;
  const name = override ?? stack.id;
  if (typeof name !== "string") return;
  const id = name.includes(":") ? name : "minecraft:" + name;
  return Object.hasOwn(models, id) ? id : undefined;
}

/** 把固定展示姿态下的模型加入同一拥有者的网格。place 将物品局部坐标变换到拥有者坐标。
 * 图标在形状表中只有一个双面四边形，方块物品保留各自的立体表面。
 */
export async function appendItemModel(
  mesh: TriangleMesh,
  modelId: string,
  place: (position: Vec3) => Vec3,
  unlit: boolean,
  assets: MinecraftAssets,
): Promise<void> {
  // 形状表按素材集合惰性解压一次，不同物品复用形状，只替换面对应的图块。
  if (!shapes.has(assets)) shapes.set(assets, fetch(assets.shapes).then(response =>
    new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).json() as Promise<Quad[][]>
  ));
  const { shape, tiles } = models[modelId];
  for (const face of (await shapes.get(assets)!)[shape]) {
    const first = mesh.vertices.length;
    const tile = tiles[face.material];
    const x = (tile % catalog.columns) * 16, y = Math.floor(tile / catalog.columns) * 16;
    for (const [i, position] of face.positions.entries()) {
      const [u, v] = face.uv[i];
      // 交点恰好在右边或下边时，取本图块的末像素。
      mesh.vertices.push({
        position: place(position),
        uv: [x + Math.min(15.999, Math.max(.001, u * 16)), y + Math.min(15.999, Math.max(.001, v * 16))],
      });
    }
    const faceUnlit = unlit || face.unlit;
    mesh.triangles.push(
      { indices: [first, first + 1, first + 2], unlit: faceUnlit },
      { indices: [first, first + 2, first + 3], unlit: faceUnlit },
    );
  }
}
