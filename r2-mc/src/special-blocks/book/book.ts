// 附魔书只提供七个盒体及其运动；格子登记、贴图和 GPU 上传由公共对象层负责。
import type { ObjectRecipe } from "neomega-r2-core";

const rotateY = (v: number[], a: number): number[] => [
  Math.cos(a) * v[0] + Math.sin(a) * v[2],
  v[1],
  -Math.sin(a) * v[0] + Math.cos(a) * v[2],
];
const rotateZ = (v: number[], a: number): number[] => [
  Math.cos(a) * v[0] - Math.sin(a) * v[1],
  Math.sin(a) * v[0] + Math.cos(a) * v[1],
  v[2],
];
export function enchantingBook(bookURL: string): ObjectRecipe {
  const definitions: number[][][] = [
    [
      [-6, -5, -0.005],
      [6, 10, 0.005],
      [0, 0],
    ],
    [
      [0, -5, -0.005],
      [6, 10, 0.005],
      [16, 0],
    ],
    [
      [-1, -5, 0],
      [2, 10, 0.005],
      [12, 0],
    ],
    [
      [0, -4, -0.99],
      [5, 8, 1],
      [0, 10],
    ],
    [
      [0, -4, -0.01],
      [5, 8, 1],
      [12, 10],
    ],
    [
      [0, -4, 0],
      [5, 8, 0.005],
      [24, 10],
    ],
    [
      [0, -4, 0],
      [5, 8, 0.005],
      [24, 10],
    ],
  ];
  return {
    texture: { url: bookURL },
    bounds: [
      [-0.1, 0.75, -0.1],
      [1.1, 1.85, 1.1],
    ],
    parts: definitions.map(([minimum, extent, [u, v]]) => {
      const [x, y, z] = extent;
      return {
        minimum,
        maximum: minimum.map((n, i) => n + extent[i]),
        faces: [
          [u, v + z, z, y],
          [u + z + x, v + z, z, y],
          [u + z + x, v, x, z],
          [u + z, v, x, z],
          [u + z, v + z, x, y],
          [u + 2 * z + x, v + z, x, y],
        ],
      };
    }),
    pose(time: number, i: number) {
      const openness = 1.25 + Math.sin(time * 0.4) * 0.1,
        slide = Math.sin(openness),
        angle = [
          Math.PI + openness,
          -openness,
          Math.PI / 2,
          openness,
          -openness,
          openness * (1 - 2 * ((time * 0.35) % 1)),
          openness * (1 - 2 * ((time * 0.35 + 0.5) % 1)),
        ][i],
        pivot = i < 2 ? [0, 0, i === 0 ? -1 : 1] : i > 2 ? [slide, 0, 0] : [0, 0, 0];
      const transform = (v: number[]) =>
          rotateY(rotateZ(rotateY(v, angle), (80 * Math.PI) / 180), time * 0.3),
        position = rotateY(
          rotateZ(
            pivot.map((v) => v / 16),
            (80 * Math.PI) / 180,
          ),
          time * 0.3,
        ).map((v, a) => v + [0.5, 1.1 + Math.sin(time * 1.6) * 0.05, 0.5][a]);
      return {
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ].map(transform),
        position,
        scale: 1 / 16,
      };
    },
  };
}
