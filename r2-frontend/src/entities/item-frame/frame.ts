import type { MeshRecipe, TriangleMesh, Vec3 } from "neomega-r2-core";
import type { EntityRenderer } from "../entities.ts";
import { frameURL } from "./assets.ts";
import model from "./model.json" with { type: "json" };

const directions = ["down", "up", "north", "south", "west", "east"] as const;
type Facing = 0 | 1 | 2 | 3 | 4 | 5;

/** 框体默认朝北。局部原点取框厚度的中点，因此六个方向都能直接平移到实体的 Pos。 */
function orient([x, y, z]: Vec3, facing: Facing): Vec3 {
  switch (facing) {
    case 0: return [-x, z, y];
    case 1: return [-x, -z, -y];
    case 2: return [x, y, z];
    case 3: return [-x, y, -z];
    case 4: return [z, y, -x];
    case 5: return [-z, y, x];
  }
}

/** Java 方块模型每个面的 UV 轴不同；从贴图左上角开始排列四个顶点。 */
function corners(face: typeof directions[number], u: number, v: number): Vec3 {
  switch (face) {
    case "north": return [1 - u, 1 - v, 0];
    case "south": return [u, 1 - v, 1];
    case "west": return [0, 1 - v, u];
    case "east": return [1, 1 - v, 1 - u];
    case "up": return [u, 1, v];
    case "down": return [u, 0, 1 - v];
  }
}

/** 框体沿用 Java 的底板和四根木边。图案与木纹在同一张固定图集，只需一次材质登记。 */
function itemFrame(facing: Facing, glow: boolean): MeshRecipe {
  const mesh: TriangleMesh = { vertices: [], triangles: [] };
  const center = [8, 8, 15.5];
  for (const { from, to, faces } of model.elements) {
    for (const face of directions) {
      const surface = faces[face];
      if (!surface) continue;
      const [u0, v0, u1, v1] = surface.uv;
      const tile = surface.texture === "#wood" ? 0 : glow ? 32 : 16;
      const first = mesh.vertices.length;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const point = corners(face, u, v).map((end, i) => ((end ? to[i] : from[i]) - center[i]) / 16) as Vec3;
        mesh.vertices.push({ position: orient(point, facing), uv: [tile + (u ? u1 : u0), v ? v1 : v0] });
      }
      mesh.triangles.push({ indices: [first, first + 1, first + 2] }, { indices: [first, first + 2, first + 3] });
    }
  }
  return { texture: { url: frameURL }, mesh };
}

export const frameRenderer: EntityRenderer = {
  appearance(nbt) {
    if (nbt.Invisible === 1 || nbt.Invisible === true) return;
    const facing = nbt.Facing ?? 0;
    if (typeof facing !== "number" || !Number.isInteger(facing) || facing < 0 || facing > 5)
      throw new SyntaxError("展示框 Facing 应为 0 到 5 的整数");
    return { data: facing };
  },
  factory: descriptor => itemFrame(descriptor.data as Facing, descriptor.kind === "minecraft:glow_item_frame"),
};
