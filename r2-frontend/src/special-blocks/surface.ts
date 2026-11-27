import type { ObjectPose, ObjectRecipe, ObjectTexture, Vec3 } from "neomega-r2-core";

/** 给静态方块表面加一层盒面。范围用模型的十六分之一格表示，朝向从南向西旋转。 */
export function surface(
  texture: ObjectTexture,
  minimum: Vec3,
  maximum: Vec3,
  faces: number[][],
  rotation: number,
): ObjectRecipe {
  const angle = (rotation * Math.PI) / 8,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const low = minimum.map((v, i) => v / 16 - (i === 1 ? 0 : 0.5));
  const high = maximum.map((v, i) => v / 16 - (i === 1 ? 0 : 0.5));
  const corners = [low[0], high[0]].flatMap((x) =>
    [low[2], high[2]].map((z) => [0.5 + c * x - s * z, 0.5 + s * x + c * z]),
  );
  const pose: ObjectPose = {
    axes: [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c],
    ],
    position: [0.5, 0, 0.5],
  };
  return {
    animated: false,
    texture,
    parts: [{ minimum: low, maximum: high, faces }],
    bounds: [
      [Math.min(...corners.map((p) => p[0])), low[1], Math.min(...corners.map((p) => p[1]))],
      [Math.max(...corners.map((p) => p[0])), high[1], Math.max(...corners.map((p) => p[1]))],
    ],
    pose: () => pose,
  };
}

// 零面积 UV 表示该面继续显示方块原有的材质。
export const bare = [0, 0, 0, 0];
