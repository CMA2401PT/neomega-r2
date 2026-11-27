import type { TriangleMesh, Vec3 } from "../contracts.ts";

/** 区域池中的三角面地址带此标记。普通模型编号和动画盒体句柄沿用各自的编码。 */
export const TRIANGLE = 0x40000000;

/** 返回覆盖网格的半开整格范围。正好落在格线上的平面归坐标较大的一侧。 */
export function meshCellBounds(mesh: TriangleMesh, owner: Vec3): Vec3[] {
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const { position } of mesh.vertices)
    for (let i = 0; i < 3; i++) {
      const cell = Math.floor(owner[i] + position[i]);
      low[i] = Math.min(low[i], cell);
      high[i] = Math.max(high[i], cell + 1);
    }
  return [low, high];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** 按单个轴裁出半空间内的凸多边形，只用于找格子，GPU 仍收到原三角形。 */
function clip(polygon: Vec3[], axis: number, boundary: number, keepAbove: boolean): Vec3[] {
  const result: Vec3[] = [];
  let a = polygon[polygon.length - 1];
  for (const b of polygon) {
    const da = a[axis] - boundary, db = b[axis] - boundary;
    if (da * db < 0) {
      const fraction = da / (da - db);
      result.push(a.map((v, i) => v + fraction * (b[i] - v)) as Vec3);
    }
    if (keepAbove ? db >= 0 : db <= 0) result.push(b);
    a = b;
  }
  return result;
}

/** 只枚举有面积的条带。平行于格面的多边形即便厚度为零，也要落入一个格子。 */
function visitStrips(
  polygon: Vec3[],
  axis: number,
  low: number,
  high: number,
  visit: (cell: number, shape: Vec3[]) => void,
): void {
  const values = polygon.map(p => p[axis]);
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const first = Math.floor(minimum), last = Math.max(first + 1, Math.ceil(maximum));
  for (let cell = Math.max(first, low); cell < Math.min(last, high); cell++) {
    let shape = polygon;
    if (cell > minimum) shape = clip(shape, axis, cell, true);
    if (cell + 1 < maximum) shape = clip(shape, axis, cell + 1, false);
    visit(cell, shape);
  }
}

/** 按 X、Z 条带找实际覆盖的格子，最后一个轴只需读凸多边形的高度范围。
 * 同一区域共用一条面记录；每个格子只保存地址。顶点的 XZ 相对区域原点以保留远处的小数精度。
 */
export function registerMesh({ mesh, owner, handle, regionX, regionZ, append, cellParts }: {
  mesh: TriangleMesh;
  owner: number[];
  handle: number;
  regionX: number;
  regionZ: number;
  append: (words: Uint32Array) => number;
  cellParts: (cell: number[]) => number[];
}): void {
  const x0 = regionX * 128, z0 = regionZ * 128;
  const positions: Vec3[] = mesh.vertices.map(({ position: p }) => [
    owner[0] - x0 + p[0], owner[1] + p[1], owner[2] - z0 + p[2],
  ]);
  for (const { indices, unlit } of mesh.triangles) {
    const [a, b, c] = indices.map(i => positions[i]);
    const ab = subtract(b, a), ac = subtract(c, a);
    const normal = cross(ab, ac), twiceArea = Math.hypot(...normal);
    if (twiceArea === 0) continue;
    const n = normal.map(v => v / twiceArea) as Vec3;
    // 对射线与平面的交点应用两条对偶向量即可得到重心坐标。
    const u = cross(ac, n).map(v => v / twiceArea), v = cross(n, ab).map(value => value / twiceArea);
    const [ta, tb, tc] = indices.map(i => mesh.vertices[i].uv);
    let id: number | undefined;
    visitStrips([a, b, c], 0, 0, 128, (x, column) => {
      visitStrips(column, 2, 0, 128, (z, slice) => {
        const ys = slice.map(p => p[1]), first = Math.floor(Math.min(...ys));
        const end = Math.min(448, Math.max(first + 1, Math.ceil(Math.max(...ys))));
        for (let y = Math.max(first, -64); y < end; y++) {
          if (id === undefined) {
            const words = new Uint32Array(new Float32Array([
              0, ...a, ...n, n[0] * a[0] + n[1] * a[1] + n[2] * a[2], ...u, ...v,
              ...ta, tb[0] - ta[0], tb[1] - ta[1], tc[0] - ta[0], tc[1] - ta[1],
            ]).buffer);
            // 对象句柄最高位只用于区分盒体；面记录用该位保存自亮标记。
            words[0] = (handle & 0x7fffffff) | (unlit ? 0x80000000 : 0);
            id = TRIANGLE + append(words);
          }
          cellParts([x0 + x, y, z0 + z]).push(id);
        }
      });
    });
  }
}
