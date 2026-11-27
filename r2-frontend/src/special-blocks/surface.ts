import type { MeshRecipe, ObjectTexture, TriangleMesh, Vec3 } from "neomega-r2-core";

/** 将有纹样的盒面拆成静态三角形。尺寸以十六分之一格表示，贴图矩形可用负宽度镜像。
 * 各面的 U、V 方向沿用方块贴图约定，同一个角在不同面上可以有不同的 UV。
 */
export function surface(
  texture: ObjectTexture,
  minimum: Vec3,
  maximum: Vec3,
  faces: number[][],
  rotation: number,
  unlitFaces = 0,
): MeshRecipe {
  const angle = (rotation * Math.PI) / 8;
  const c = Math.cos(angle), s = Math.sin(angle);
  const mesh: TriangleMesh = { vertices: [], triangles: [] };
  for (const [face, [u, v, w, h]] of faces.entries()) {
    if (w === 0 && h === 0) continue;
    const axis = face >> 1, side = face % 2, first = mesh.vertices.length;
    for (const [horizontal, vertical] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const corner = axis === 0 ? [side, 1 - vertical, horizontal]
        : axis === 1 ? [horizontal, side, vertical] : [horizontal, 1 - vertical, side];
      const [x, y, z] = corner.map((end, i) => (end ? maximum[i] : minimum[i]) / 16);
      mesh.vertices.push({
        position: [0.5 + c * (x - 0.5) - s * (z - 0.5), y, 0.5 + s * (x - 0.5) + c * (z - 0.5)],
        uv: [u + horizontal * w, v + vertical * h],
      });
    }
    const unlit = (unlitFaces & (1 << face)) !== 0;
    mesh.triangles.push(
      { indices: [first, first + 1, first + 2], unlit },
      { indices: [first, first + 2, first + 3], unlit },
    );
  }
  return { texture, mesh };
}

export const bare = [0, 0, 0, 0];
