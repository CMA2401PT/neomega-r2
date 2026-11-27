// 全屏地图只提供相机和输入；近处复用主射线渲染器，远处用区块位图显示存档分布。
import { cameraBasis, cameraRay, type Camera, type Renderer, type WorldSession } from "neomega-r2-core";
import type { OverlayItem, OverlayMarker, SceneOverlay } from "../../compositor/overlay-types.ts";
import { closePopovers, element } from "../layout/dom.ts";

/** 把地图像素投影到水平参考面，拖动与光标缩放因此保持同一世界锚点。 */
function mapPoint(camera: Camera, { width, height, x, y, plane }: {width:number; height:number; x:number; y:number; plane:number}) {
  const ray = cameraRay(camera, { width, height, x: x - 0.5, y: y - 0.5 });
  const t = (plane - ray.origin[1]) / ray.direction[1];
  return ray.origin.map((v, i) => v + ray.direction[i] * t);
}

type Points = Map<number, number[]>;
interface Gesture {
  button: number;
  camera: Camera;
  center: number[];
  yaw: number;
  pitch: number;
  span: number;
  start: Points;
  now: Points;
  moved: boolean;
}
interface MapTile { x: number; z: number; canvas: OffscreenCanvas }
/** 地图控制器持有独立姿态；主视图相机只在跳转时改变。 */
export class FullscreenMap {
  private readonly mainCamera: Camera;
  private readonly renderer: Renderer;
  private readonly jump: (position: number[]) => void;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  open = false;
  isOverview = false;
  center = [0, 80, 0];
  private yaw = 0;
  private pitch = -70 * Math.PI / 180;
  private span = 320;
  private farRadius = 32;
  tiles: MapTile[] = [];
  private occupancy: (MapTile & {key: string}) | null = null;
  selection: Awaited<ReturnType<Renderer["pick"]>> = null;
  pending: {camera: Camera; pixel: {width:number; height:number; x:number; y:number}} | null = null;
  private gesture: Gesture | null = null;
  private session: WorldSession | null = null;
  private readChunks?: () => ArrayBuffer | Promise<ArrayBuffer>;
  private chunksRequest = 0;
  private readonly overlay: SceneOverlay;
  private arrow?: OverlayMarker;
  private faceMarks: OverlayItem[] = [];
  private events = new AbortController();
  constructor({ camera, renderer, jump, overlay }: {camera: Camera; renderer: Renderer; jump(position: number[]): void; overlay: SceneOverlay}) {
    this.overlay = overlay;
    this.mainCamera = camera;
    this.renderer = renderer;
    this.jump = jump;
    this.canvas = element<HTMLCanvasElement>("map-overlay");
    this.context = this.canvas.getContext("2d")!;
    element<HTMLButtonElement>("map-open").onclick = () => this.open ? this.hide() : this.show();
    element<HTMLButtonElement>("map-jump").onclick = () => {
      if (!this.selection) return;
      this.jump(this.selection.position.map((v, i) => v + (i === 1 ? 2 : 0.5)));
      this.hide();
    };
    element<HTMLInputElement>("map-zoom").oninput = (event) =>
      this.zoom({
        span: 2 ** Number((event.currentTarget as HTMLInputElement).value),
        x: innerWidth / 2,
        y: innerHeight / 2,
      });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.open) {
        event.preventDefault();
        this.hide();
      }
    }, { signal: this.events.signal });
    this.canvas.oncontextmenu = (event) => event.preventDefault();
    this.canvas.onpointerdown = (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      this.canvas.focus();
      this.canvas.setPointerCapture(event.pointerId);
      const points = new Map(this.gesture?.now);
      points.set(event.pointerId, [event.clientX, event.clientY]);
      this.beginGesture({
        points,
        button: event.button,
        moved: points.size > 1,
      });
    };
    this.canvas.onpointermove = (event) => {
      const gesture = this.gesture;
      if (!gesture || !gesture.now.has(event.pointerId)) return;
      gesture.now.set(event.pointerId, [event.clientX, event.clientY]);
      const [x, y] = gesture.start.get(event.pointerId)!;
      gesture.moved ||= Math.hypot(event.clientX - x, event.clientY - y) > 4;
      if (!gesture.moved) return;
      if (this.pending) {
        this.pending = null;
        element<HTMLOutputElement>("map-selection").textContent = "单击方块选点";
      }
      this.applyGesture(gesture);
    };
    const release = (event: PointerEvent) => {
      const gesture = this.gesture;
      if (!gesture || !gesture.now.has(event.pointerId)) return;
      if (this.canvas.hasPointerCapture(event.pointerId))
        this.canvas.releasePointerCapture(event.pointerId);
      const tapped =
        event.type === "pointerup" &&
        !gesture.moved &&
        gesture.now.size === 1 &&
        gesture.button === 0;
      gesture.now.delete(event.pointerId);
      this.gesture = null;
      if (gesture.now.size)
        this.beginGesture({
          points: gesture.now,
          button: gesture.button,
          moved: true,
        });
      if (tapped) this.choose({ x: event.clientX, y: event.clientY });
    };
    this.canvas.onpointerup = release;
    this.canvas.onpointercancel = release;
    this.canvas.onlostpointercapture = release;
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.zoom({
          span:
            this.span *
            Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.002))),
          x: event.clientX,
          y: event.clientY,
        });
      },
      { passive: false },
    );
  }
  /** 手指数变化时从当前相机重新开始，双指松开后不会跳回旧的拖动起点。 */
  beginGesture({ points, button, moved }: {points: Points; button: number; moved: boolean}) {
    this.gesture = {
      button,
      moved,
      camera: this.camera,
      center: [...this.center],
      yaw: this.yaw,
      pitch: this.pitch,
      span: this.span,
      start: new Map(points),
      now: new Map(points),
    };
  }
  /** 左键或单指平移，右键旋转；双指同时旋转缩放，并固定两指中点下的地面。 */
  applyGesture(gesture: Gesture) {
    const ids = [...gesture.start.keys()],
      start = gesture.start,
      now = gesture.now;
    if (ids.length === 1 && gesture.button === 2) {
      const [x0, y0] = start.get(ids[0])!,
        [x, y] = now.get(ids[0])!;
      this.yaw = gesture.yaw + ((x - x0) * 0.3 * Math.PI) / 180;
      this.pitch = Math.max(
        (-85 * Math.PI) / 180,
        Math.min(
          (-40 * Math.PI) / 180,
          gesture.pitch - ((y - y0) * 0.25 * Math.PI) / 180,
        ),
      );
      return;
    }
    let from = start.get(ids[0])!,
      to = now.get(ids[0])!;
    this.yaw = gesture.yaw;
    this.span = gesture.span;
    if (ids.length > 1) {
      const a0 = from,
        b0 = start.get(ids[1])!,
        a = to,
        b = now.get(ids[1])!;
      const angle = (p: number[], q: number[]) => Math.atan2(q[1] - p[1], q[0] - p[0]);
      // R2 的 yaw 正方向与旧地图相反，手势转角在这里换算。
      this.yaw = gesture.yaw - (angle(a, b) - angle(a0, b0));
      this.span = Math.max(
        8,
        Math.min(
          65536,
          (gesture.span * Math.hypot(b0[0] - a0[0], b0[1] - a0[1])) /
            Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])),
        ),
      );
      from = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
      to = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    const anchor = mapPoint(gesture.camera, {
      width: innerWidth,
      height: innerHeight,
      x: from[0],
      y: from[1],
      plane: gesture.center[1],
    });
    this.center = [...gesture.center];
    const moved = this.point({ x: to[0], y: to[1] });
    this.center = gesture.center.map((v, i) => v + anchor[i] - moved[i]);
  }
  /** 高空相机指向中心参考面；所有像素的起点都在与方向垂直的平面上。 */
  get camera() {
    const camera = { yaw: this.yaw, pitch: this.pitch, ortho: this.span };
    const { forward } = cameraBasis(camera),
      distance = 8192 + this.span;
    return {
      ...camera,
      position: this.center.map((v, i) => v - forward[i] * distance),
    };
  }
  /** 画面在水平参考面上的长边超过远景直径（farRadius × 2 区块）的 √2 倍时，改为区块占用图。
   * 阈值随远景半径变化，不是常数。 */
  overview(farRadius: number) {
    return Boolean(this.readChunks) && (
      this.span *
        Math.max(innerWidth / innerHeight, 1 / Math.abs(Math.sin(this.pitch))) >
      farRadius * 32 * Math.SQRT2
    );
  }
  /** 更换场景时重置地图；宿主可提供区块占用表以启用远距离概览。 */
  async setWorld(readChunks?: () => ArrayBuffer | Promise<ArrayBuffer>) {
    this.hide();
    this.readChunks = readChunks;
    this.tiles = [];
    this.occupancy = null;
    return this.refreshChunks();
  }
  async refreshChunks() {
    const request = ++this.chunksRequest;
    if (!this.readChunks) return;
    const buffer = await this.readChunks();
    if (request !== this.chunksRequest) return;
    const data = new DataView(buffer),
      tiles = [];
    for (let offset = 0; offset < buffer.byteLength; offset += 136) {
      const canvas = new OffscreenCanvas(32, 32),
        context = canvas.getContext("2d")!;
      context.fillStyle = "#c3d6d1";
      for (let i = 0; i < 1024; i++)
        if (data.getUint8(offset + 8 + (i >> 3)) & (1 << (i & 7)))
          context.fillRect(i & 31, i >> 5, 1, 1);
      tiles.push({
        x: data.getInt32(offset, true) * 512,
        z: data.getInt32(offset + 4, true) * 512,
        canvas,
      });
    }
    if (request === this.chunksRequest) {
      this.tiles = tiles;
      this.occupancy = null;
    }
  }
  /** 打开时从主相机位置开始，北方朝上。 */
  show() {
    closePopovers();
    this.open = true;
    this.gesture = null;
    this.center = [...this.mainCamera.position];
    this.yaw = 0;
    this.pitch = (-70 * Math.PI) / 180;
    this.span = Math.min(320, this.farRadius * 16 / Math.max(1, innerWidth / innerHeight));
    this.selection = this.pending = null;
    this.arrow?.remove();
    this.arrow = this.overlay.marker(this.mainCamera.position, {
      points: [[12,0],[-7,-7],[-3,0],[-7,7]], fill: "#0b6b6b", stroke: "#fff", strokeWidth: 3, alwaysVisible: true,
    });
    element<HTMLOutputElement>("map-selection").textContent = "单击方块选点";
    element<HTMLButtonElement>("map-jump").disabled = true;
    document.body.classList.add("map-open");
    element("map-open").setAttribute("aria-pressed", "true");
    for (const id of ["map-overlay", "map-hud", "map-help"])
      element(id).hidden = false;
    this.canvas.focus();
  }
  /** 收起时保留主相机原来的位置与方向。 */
  hide() {
    this.pickRequest++;
    this.arrow?.remove();
    this.arrow = undefined;
    for (const mark of this.faceMarks) mark.remove();
    this.faceMarks = [];
    this.open = false;
    this.isOverview = false;
    this.gesture = null;
    this.pending = null;
    document.body.classList.remove("map-open");
    element("map-open").setAttribute("aria-pressed", "false");
    for (const id of ["map-overlay", "map-hud", "map-help"])
      element(id).hidden = true;
  }
  /** 输入使用 CSS 像素，与射线画布的渲染分辨率无关。 */
  point({ x, y }: {x:number; y:number}) {
    return mapPoint(this.camera, {
      width: innerWidth,
      height: innerHeight,
      x,
      y,
      plane: this.center[1],
    });
  }
  /** 缩放前后固定鼠标下的水平面锚点。 */
  zoom({ span, x, y }: {span:number; x:number; y:number}) {
    const before = this.point({ x, y });
    this.span = Math.max(8, Math.min(65536, span));
    const after = this.point({ x, y });
    this.center = this.center.map((v, i) => v + before[i] - after[i]);
    this.pending = null;
  }
  /** 已加载区域直接拾取；缺少区域时移动窗口后沿原来的射线重试。 */
  choose({ x, y }: {x:number; y:number}) {
    const point = this.point({ x, y });
    if (this.isOverview) {
      this.center = point;
      this.span =
        ((this.farRadius * 32) /
          Math.max(
            innerWidth / innerHeight,
            1 / Math.abs(Math.sin(this.pitch)),
          )) *
        0.75;
      return;
    }
    const pixel = { width: innerWidth, height: innerHeight, x, y },
      camera = this.camera;
    if (!this.session?.published(Math.floor(point[0] / 128), Math.floor(point[2] / 128))) {
      this.select(null);
      this.center = point;
      this.pending = { camera, pixel };
      element<HTMLOutputElement>("map-selection").textContent = "等待所选位置的 r2region 加载…";
      return;
    }
    this.pick(camera,pixel);
  }

  private pickRequest=0;
  private async pick(camera: Camera,pixel:{width:number;height:number;x:number;y:number}) {
    const request=++this.pickRequest;
    const value=await this.renderer.pick(camera,pixel);
    if(request===this.pickRequest && this.open)this.select(value);
  }
  /** 法线用主要分量命名，倾斜模型表面也有稳定的读数。 */
  select(selection: Awaited<ReturnType<Renderer["pick"]>>) {
    this.pickRequest++;
    this.selection = selection;
    for (const mark of this.faceMarks) mark.remove();
    this.faceMarks = [];
    element<HTMLButtonElement>("map-jump").disabled = !selection;
    if (!selection) {
      element<HTMLOutputElement>("map-selection").textContent = "未命中方块";
      return;
    }
    const axis = selection.normal
      .map(Math.abs)
      .indexOf(Math.max(...selection.normal.map(Math.abs)));
    const center = selection.position.map((v,i) => v + 0.5 + (i === axis ? 0.5 * Math.sign(selection.normal[i]) : 0));
    this.faceMarks = [
      this.overlay.blockFace(selection, { fill: "#ffd76c88", stroke: "#fff", strokeWidth: 4 }),
      this.overlay.blockFace(selection, { fill: "transparent", stroke: "#795400", strokeWidth: 2 }),
      this.overlay.marker(center, { width: 10, height: 10, fill: "#ffd76c", stroke: "#795400" }),
    ];
    const face = [
      ["西面", "东面"],
      ["底面", "顶面"],
      ["北面", "南面"],
    ][axis][Number(selection.normal[axis] > 0)];
    element<HTMLOutputElement>("map-selection").textContent =
      `X ${selection.position[0]}  Y ${selection.position[1]}  Z ${selection.position[2]} · ${face}`;
  }
  /** 提供绘制与流式调度共用的视图描述，主循环无需逐项判断地图状态。 */
  frame(settings: {farRadius:number; fog:boolean}) {
    this.farRadius = settings.farRadius;
    if (!this.open)
      return {
        camera: this.mainCamera,
        center: this.mainCamera.position,
        objects: true,
        overview: false,
        fog: settings.fog ? settings.farRadius * 16 : Infinity,
      };
    this.isOverview = this.overview(settings.farRadius);
    element<HTMLInputElement>("map-zoom").value = String(Math.log2(this.span));
    return {
      camera: this.camera,
      center: this.center,
      objects: false,
      overview: this.isOverview,
      fog: Infinity,
    };
  }
  /** 在宿主更新窗口并发布数据后重试选点，避免把旧窗口的空闲状态当作加载完成。 */
  refresh(session: WorldSession | null) {
    if (!this.open) return;
    this.session = session;
    if (this.pending && session && !session.stats.pending) {
      const { camera, pixel } = this.pending;
      this.pending = null;
      this.pick(camera,pixel);
    }
    const position = [...this.mainCamera.position];
    if (this.isOverview) position[1] = this.center[1];
    this.arrow?.setPosition(position);
    this.arrow?.setDirection(cameraBasis(this.mainCamera).forward);
    this.drawBackground();
  }
  /** 叠加标记与区块占用使用同一个投影，旋转后仍与地形对齐。 */
  screen(point: number[]) {
    const { right, up } = cameraBasis(this.camera),
      delta = point.map((v, i) => v - this.center[i]);
    const dot = (a: number[]) => a.reduce((v, n, i) => v + n * delta[i], 0);
    return [
      innerWidth / 2 + (dot(right) * innerHeight) / this.span,
      innerHeight / 2 - (dot(up) * innerHeight) / this.span,
    ];
  }
  /** 先在区块坐标中拼接可见区域，再整体投影，避免每张图块边缘各自抗锯齿形成接缝。 */
  composeOccupancy() {
    const corners = [0, innerWidth].flatMap((x) =>
      [0, innerHeight].map((y) => this.point({ x, y })),
    );
    const low = [0, 2].map((axis) =>
      Math.floor(Math.min(...corners.map((p) => p[axis])) / 512),
    );
    const high = [0, 2].map((axis) =>
      Math.floor(Math.max(...corners.map((p) => p[axis])) / 512),
    );
    const key = [...low, ...high].join("/");
    if (this.occupancy?.key === key) return;
    const canvas = new OffscreenCanvas(
      (high[0] - low[0] + 1) * 32,
      (high[1] - low[1] + 1) * 32,
    );
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    for (const tile of this.tiles) {
      const x = tile.x / 512,
        z = tile.z / 512;
      if (x >= low[0] && x <= high[0] && z >= low[1] && z <= high[1])
        context.drawImage(tile.canvas, (x - low[0]) * 32, (z - low[1]) * 32);
    }
    this.occupancy = { key, x: low[0] * 512, z: low[1] * 512, canvas };
  }
  /** 远处绘制区块占用底图，近处保留透明画布处理地图输入。 */
  drawBackground() {
    const canvas = this.canvas,
      ctx = this.context,
      ratio = devicePixelRatio;
    if (
      canvas.width !== innerWidth * ratio ||
      canvas.height !== innerHeight * ratio
    ) {
      canvas.width = innerWidth * ratio;
      canvas.height = innerHeight * ratio;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (this.isOverview) {
      ctx.fillStyle = "#e9eeeb";
      ctx.fillRect(0, 0, innerWidth, innerHeight);
      this.composeOccupancy();
      const image = this.occupancy!;
      const p = this.screen([image.x, this.center[1], image.z]);
      const px = this.screen([image.x + 16, this.center[1], image.z]);
      const pz = this.screen([image.x, this.center[1], image.z + 16]);
      ctx.save();
      ctx.transform(
        px[0] - p[0],
        px[1] - p[1],
        pz[0] - p[0],
        pz[1] - p[1],
        p[0],
        p[1],
      );
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image.canvas, 0, 0);
      ctx.restore();
      ctx.font = "12px system-ui";
      ctx.fillStyle = "#526d67";
      ctx.fillText("区块占用图 · 单击定位并放大", 18, 28);
    }
  }
  dispose() {
    this.hide();
    this.events.abort();
  }
}
