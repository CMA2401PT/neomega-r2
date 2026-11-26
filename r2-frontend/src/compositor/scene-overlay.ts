import { cameraBasis, cameraSpan, type Camera } from "neomega-r2-core";
import type { MarkerStyle, OverlayStyle, SceneOverlay } from "./overlay-types.ts";

type Point = readonly number[];
type Path = readonly Point[];
type Mark =
  | { kind: "marker"; position: number[]; style: MarkerStyle }
  | { kind: "geometry"; faces: Path[]; lines: Path[]; style: OverlayStyle };
export interface Stamp {
  image: OffscreenCanvas;
  /** 屏幕左上角和宽高，单位为 CSS 像素。 */
  rect: number[];
  /** 在单位屏幕坐标中，a*x+b*y+c 是正交深度或透视深度的倒数。 */
  plane: number[];
  test: boolean;
}
const near = 0.01;
const equal = (a: Point, b: Point) => a.length === b.length && a.every((v, i) => v === b[i]);
const dot = (a: Point, b: Point) => a.reduce((sum, v, i) => sum + v * b[i], 0);

/** 裁剪穿过近面的边，投影只接收相机前方的点。 */
function intersectNear(a: Point, b: Point): number[] {
  const t = (near - a[2]) / (b[2] - a[2]);
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), near];
}
function clipFace(points: Path): Path {
  const front: Point[] = [];
  let a = points[points.length - 1];
  for (const b of points) {
    if (a[2] >= near !== b[2] >= near) front.push(intersectNear(a, b));
    if (b[2] >= near) front.push(b);
    a = b;
  }
  return front;
}
/** 从屏幕上的点求平面深度。线段只沿投影方向改变深度。 */
function depthPlane(points: Path, width: number, height: number): number[] {
  const a = points[0];
  // 裁剪点可能落在已有顶点上，取最长基线，也减少近共线点带来的误差。
  const b = points.reduce(
    (farthest, p) =>
      Math.hypot(p[0] - a[0], p[1] - a[1]) > Math.hypot(farthest[0] - a[0], farthest[1] - a[1])
        ? p
        : farthest,
    a,
  );
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    dz = b[2] - a[2];
  const square = dx * dx + dy * dy;
  let sx = square ? (dx * dz) / square : 0;
  let sy = square ? (dy * dz) / square : 0;
  let largest = 0;
  for (const c of points) {
    const x = c[0] - a[0],
      y = c[1] - a[1],
      z = c[2] - a[2];
    const area = dx * y - dy * x;
    if (Math.abs(area) <= largest) continue;
    largest = Math.abs(area);
    sx = (dz * y - dy * z) / area;
    sy = (dx * z - dz * x) / area;
  }
  return [sx * width, sy * height, a[2] - sx * a[0] - sy * a[1]];
}

/** 收集宿主和地图的标记；每次视图或标记改变时，为可见部分生成覆盖图及其深度平面。 */
export class SceneMarks implements SceneOverlay {
  private marks = new Set<Mark>();
  version = 0;
  get size() {
    return this.marks.size;
  }
  get needsDepth(): boolean {
    for (const mark of this.marks) if (!mark.style.alwaysVisible) return true;
    return false;
  }
  clear() {
    this.marks.clear();
    this.version++;
  }

  private add(mark: Mark) {
    this.marks.add(mark);
    this.version++;
    return {
      remove: () => {
        if (this.marks.delete(mark)) this.version++;
      },
    };
  }
  marker(position: Point, style: MarkerStyle = {}) {
    const mark: Extract<Mark, { kind: "marker" }> = {
      kind: "marker",
      position: [...position],
      style: { ...style },
    };
    return {
      ...this.add(mark),
      setPosition: (next: Point) => {
        if (!equal(mark.position, next)) {
          mark.position = [...next];
          this.version++;
        }
      },
      setDirection: (next: Point) => {
        if (!equal(mark.style.direction ?? [], next)) {
          mark.style.direction = [...next];
          this.version++;
        }
      },
      refresh: () => {
        this.version++;
      },
    };
  }
  polygon(points: Path, style: OverlayStyle = {}) {
    return this.add({ kind: "geometry", faces: [points], lines: [], style: { fill: "#ffd76c88", ...style } });
  }
  line(points: Path, style: OverlayStyle = {}) {
    return this.add({ kind: "geometry", faces: [], lines: [points], style });
  }
  blockOutline(position: Point, style: OverlayStyle = {}) {
    const corners = Array.from({ length: 8 }, (_, i) => position.map((v, axis) => v + ((i >> axis) & 1)));
    const lines = corners.flatMap((p, i) =>
      [1, 2, 4].filter((bit) => !(i & bit)).map((bit) => [p, corners[i | bit]]),
    );
    return this.add({ kind: "geometry", faces: [], lines, style });
  }
  blockFace({ position, normal }: { position: Point; normal: Point }, style: OverlayStyle = {}) {
    const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    const [u, v] = [0, 1, 2].filter((i) => i !== axis);
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([x, y]) => {
      const p = [...position];
      p[axis] += Number(normal[axis] > 0);
      p[u] += x;
      p[v] += y;
      return p;
    });
    return this.polygon(corners, style);
  }

  stamps(
    camera: Camera,
    width: number,
    height: number,
    ratio: number,
    overview: boolean,
    aspect: number,
  ): Stamp[] {
    const { right, up, forward } = cameraBasis(camera);
    const scale = height / cameraSpan(camera),
      perspective = camera.ortho === undefined;
    const view = (p: Point) => {
      const delta = p.map((v, i) => v - camera.position[i]);
      return [dot(delta, right), dot(delta, up), dot(delta, forward)];
    };
    const project = ([x, y, z]: Point) => {
      const k = perspective ? scale / z : scale;
      return [width / 2 + (x * k * width) / (height * aspect), height / 2 - y * k, perspective ? 1 / z : z];
    };
    const stamps: Stamp[] = [];
    // 只为轮廓与屏幕相交的矩形分配像素。每个元素单独保留深度，重叠时先测试再混色。
    function paint(
      points: Path,
      plane: number[],
      style: OverlayStyle,
      draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
    ) {
      const pad = (style.strokeWidth ?? 2) / 2 + 1;
      const x = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0])) - pad));
      const y = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1])) - pad));
      const w = Math.min(width, Math.ceil(Math.max(...points.map((p) => p[0])) + pad)) - x;
      const h = Math.min(height, Math.ceil(Math.max(...points.map((p) => p[1])) + pad)) - y;
      if (w <= 0 || h <= 0) return;
      const image = new OffscreenCanvas(Math.ceil(w * ratio), Math.ceil(h * ratio));
      const ctx = image.getContext("2d")!;
      ctx.setTransform(
        image.width / w,
        0,
        0,
        image.height / h,
        (-x * image.width) / w,
        (-y * image.height) / h,
      );
      ctx.lineWidth = style.strokeWidth ?? 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.fillStyle = style.fill ?? "#ffd76c";
      ctx.strokeStyle = style.stroke ?? "#fff";
      draw(ctx);
      stamps.push({ image, rect: [x, y, w, h], plane, test: !style.alwaysVisible });
    }
    function path(ctx: OffscreenCanvasRenderingContext2D, points: Path, closed: boolean) {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (closed) ctx.closePath();
    }
    for (const mark of this.marks) {
      if (overview && !mark.style.alwaysVisible) continue;
      if (mark.kind === "marker") {
        const { style } = mark,
          p = view(mark.position);
        if (p[2] < near) continue;
        const [x, y, depth] = project(p);
        const direction = style.direction;
        let angle = 0;
        if (direction) {
          const axial = perspective ? dot(direction, forward) / p[2] : 0;
          angle = Math.atan2(
            -(dot(direction, up) - p[1] * axial),
            ((dot(direction, right) - p[0] * axial) * width) / (height * aspect),
          );
        }
        const image = style.image;
        const w = style.width ?? (image ? ("naturalWidth" in image ? image.naturalWidth : image.width) : 8);
        const h =
          style.height ?? (image ? ("naturalHeight" in image ? image.naturalHeight : image.height) : 8);
        const points =
          !image && style.points
            ? style.points
            : [
                [-w / 2, -h / 2],
                [w / 2, -h / 2],
                [w / 2, h / 2],
                [-w / 2, h / 2],
              ];
        const screen = points.map(([a, b]) => [
          x + a * Math.cos(angle) - b * Math.sin(angle),
          y + a * Math.sin(angle) + b * Math.cos(angle),
        ]);
        paint(screen, [0, 0, depth], style, (ctx) => {
          ctx.translate(x, y);
          ctx.rotate(angle);
          if (image) {
            ctx.drawImage(image, -w / 2, -h / 2, w, h);
            return;
          }
          if (style.points) path(ctx, style.points, true);
          else {
            ctx.beginPath();
            ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, 2 * Math.PI);
          }
          ctx.fill();
          if (style.stroke && style.strokeWidth !== 0) ctx.stroke();
        });
        continue;
      }
      for (const face of mark.faces) {
        const visible = clipFace(face.map(view)).map(project);
        if (visible.length < 3) continue;
        paint(visible, depthPlane(visible, width, height), mark.style, (ctx) => {
          path(ctx, visible, true);
          ctx.fill();
          if (mark.style.stroke && mark.style.strokeWidth !== 0) ctx.stroke();
        });
      }
      for (const line of mark.lines) {
        for (let i = 1; i < line.length; i++) {
          let a = view(line[i - 1]),
            b = view(line[i]);
          if (a[2] < near && b[2] < near) continue;
          if (a[2] < near) a = intersectNear(a, b);
          if (b[2] < near) b = intersectNear(a, b);
          const edge = [project(a), project(b)];
          if (mark.style.strokeWidth !== 0)
            paint(edge, depthPlane(edge, width, height), mark.style, (ctx) => {
              path(ctx, edge, false);
              ctx.stroke();
            });
        }
      }
    }
    return stamps.sort((a, b) => Number(b.test) - Number(a.test));
  }
}
