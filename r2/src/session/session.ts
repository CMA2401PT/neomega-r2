import { regionKey } from "../scene/prepare.ts";
import type { ObjectRegistry } from "../objects/registry.ts";
import type { TextureSet } from "../render/textures.ts";
import type { RegionDirectory } from "../render/region-directory.ts";
import type { WorkerRequest, WorkerResponse } from "../scene/worker.ts";
import type { ObjectDescriptor, PreparedR2Region } from "../contracts.ts";
import type { createRenderer } from "../render/renderer.ts";

type Renderer = Awaited<ReturnType<typeof createRenderer>>;

/** r2region 坐标：每格横跨 8×8 个区块（chunk），r2region (x, z) 覆盖方块 [128x, 128x+128)。 */
export interface RegionCoord {
  x: number;
  z: number;
}

/** 需要近景对象的区域：数据源只提供以 center 为圆心、radius 区块以内的对象。
 * center 是区块坐标 [x, y, z]（方块坐标除以 16 向下取整）。 */
export interface ObjectWant extends RegionCoord {
  center: number[];
  radius: number;
}

/** 会话需要的数据集合的变化，只发增减。
 * regions.add 按离相机由近到远排列；objects.add 对已需要的区域再次出现时，表示圆心或半径变了，需要重新提供。 */
export interface WantChange {
  /** 当前远景中心的方块坐标 [x, z]；数据源排队时可以先供给离它近的区域。 */
  center: number[];
  regions: { add: RegionCoord[]; remove: RegionCoord[] };
  objects: { add: ObjectWant[]; remove: RegionCoord[] };
}

/** 数据源向会话提交数据的入口。只接受当前需要的区域，其余调用被忽略。
 * 同一区域再次提交就是更新：会话用新内容替换，旧画面保留到新内容准备完成。 */
export interface WorldSink {
  /** 区域的方块数据，编码见 README 的「区域编码」；null 表示这个区域没有方块。 */
  region(x: number, z: number, data: ArrayBuffer | null): void;
  /** 区域内、当前近景范围里的特殊对象。 */
  objects(x: number, z: number, descriptors: ObjectDescriptor[]): void;
  /** 区域数据无法提供；会话把区域标成失败，直到它移出又重新需要，或数据源再次提交。 */
  error(x: number, z: number, error: unknown): void;
}

/** 世界数据源。会话打开时调用 open，之后用 want 告知需要的区域与近景对象；
 * 数据源为需要的区域调用 sink.region（以及 sink.objects），可以立即、稍后或在内容变化时重复调用。 */
export interface DataSource {
  open(sink: WorldSink): void;
  want(change: WantChange): void;
  close(): void;
}

/** 会话的观察位置与范围。 */
export interface Focus {
  /** 近景对象的范围，单位区块。 */
  nearRadius: number;
  /** 远景（静态方块）的范围，单位区块。 */
  farRadius: number;
  /** 近景对象跟随的位置；省略时与远景位置相同。地图视角下传主相机位置，收起地图时无需重新加载对象。 */
  nearPosition?: number[];
}

export interface SessionOptions {
  /** 把对象描述变成可绘制配方的工厂表。 */
  registry: ObjectRegistry;
  /** 数据源报告的错误与准备失败；会话继续运行。 */
  onError?: (message: string) => void;
  /** 准备线程脚本的地址，默认与本模块同一构建目录下的 scene/worker.js。 */
  workerURL?: string | URL;
  /** 文件页面可提供已打包的 classic Blob worker。默认使用模块 worker。 */
  workerType?: WorkerType;
}

/** 空间计数以 r2region 为单位；sections 单独统计已发布的子区块（subchunk）。 */
export interface SessionStats {
  /** 可见窗口内的区域数。 */
  wanted: number;
  /** 已显示的区域数。 */
  loaded: number;
  /** 还在等待数据、准备或发布的区域数。 */
  pending: number;
  failed: number;
  /** 近景范围内还没显示完的区域数（方块或对象）。 */
  nearPending: number;
  sections: number;
  /** 数据源提交的区域数据累计字节数。 */
  bytes: number;
  /** 区域池已用字节数。 */
  usedBytes: number;
  prepareMS: number;
  uploadMS: number;
  objects: number;
  /** 已显示区域里状态表没有的方块哈希的调色板项数，按空气绘制。 */
  unknownBlocks: number;
}

interface Entry extends RegionCoord {
  key: string;
  visible: boolean;
  near: boolean;
  /** waiting：等数据源提交；storing：交给准备线程保存；stored：可以准备；failed：数据源报错。 */
  state: "waiting" | "storing" | "stored" | "failed";
  /** 最近一次提交给准备线程的编号，用来丢弃过期的回复。 */
  request: number;
  /** 依赖的来源（自己或邻区）变化时加一；准备结果带着版本，过期的不发布。 */
  version: number;
  prepared: number;
  published: number;
  /** 当前要的近景对象；空串表示不需要。 */
  objectSignature: string;
  objectsLoaded: string;
  failed: boolean;
}

interface TextureChange {
  set: TextureSet;
  versions: Map<string, number>;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/** 世界会话：根据观察位置计算需要的区域，向数据源要数据，在后台线程准备，再逐帧发布到 GPU。
 * 宿主每帧调用 focus 与 publish；相机、拍照与界面都由宿主管理。
 */
export class WorldSession {
  readonly renderer: Renderer;
  readonly source: DataSource;
  readonly gpu: RegionDirectory;
  private readonly registry: ObjectRegistry;
  private readonly onError: (message: string) => void;
  private readonly worker: Worker;
  /** 模型最远伸出所在区域的距离，单位区域；窗口外要多保留这么多圈来源区域。 */
  private readonly fragmentRadius: number;
  private entries = new Map<string, Entry>();
  private ready: Array<{ entry: Entry; version: number; result: PreparedR2Region }> = [];
  private preparing: { request: number; entry: Entry; version: number } | null = null;
  private serial = 0;
  private bytes = 0;
  private uploadMS = 0;
  private prepareMS = 0;
  private disposed = false;
  private signature = "";
  private center: number[] | null = null;
  private farCenter: number[] = [0, 0, 0];
  private nearRadius = 0;
  private textureChange: TextureChange | null = null;
  /** 对象配方可能要加载图片，各区域的对象依次替换。 */
  private objectQueue: Promise<void> = Promise.resolve();

  constructor(renderer: Renderer, source: DataSource, options: SessionOptions) {
    this.renderer = renderer;
    this.source = source;
    this.registry = options.registry;
    this.onError = options.onError ?? ((message) => console.error(message));
    this.fragmentRadius = Math.max(
      1,
      Math.ceil(
        Math.max(
          0,
          ...renderer.catalog.models.flatMap((model) =>
            (model.fragments || []).flatMap((part) => part.offset.map(Math.abs)),
          ),
        ) / 128,
      ),
    );
    this.gpu = renderer.createWorld();
    this.worker = new Worker(options.workerURL ?? new URL("../scene/worker.js", import.meta.url), {
      type: options.workerType ?? "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.message(event.data);
    this.worker.onerror = (event) => this.onError(event.message);
    this.post({ type: "init", catalog: renderer.catalog, states: renderer.states });
    source.open({
      region: (x, z, data) => this.receiveRegion(x, z, data),
      objects: (x, z, descriptors) => {
        this.objectQueue = this.objectQueue.then(() => this.receiveObjects(x, z, descriptors));
      },
      error: (x, z, error) => this.receiveError(x, z, error),
    });
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }
  private get objects() {
    return this.renderer.objects;
  }
  private near(x: number, z: number): boolean {
    const center = this.center!,
      dx = Math.max(x * 8 - center[0], 0, center[0] - (x * 8 + 7)),
      dz = Math.max(z * 8 - center[2], 0, center[2] - (z * 8 + 7));
    return dx * dx + dz * dz <= this.nearRadius ** 2;
  }
  private dirty(entry: Entry): void {
    entry.version++;
    entry.failed = false;
  }
  /** 模型会伸进邻区，来源变化时附近显示中的区域都要重新准备。 */
  private dirtyNeighbors(x: number, z: number): void {
    for (let dz = -this.fragmentRadius; dz <= this.fragmentRadius; dz++)
      for (let dx = -this.fragmentRadius; dx <= this.fragmentRadius; dx++) {
        const entry = this.entries.get(regionKey(x + dx, z + dz));
        if (entry?.visible) this.dirty(entry);
      }
  }
  private priority(entry: RegionCoord): number {
    return Math.hypot(entry.x * 8 + 4 - this.farCenter[0], entry.z * 8 + 4 - this.farCenter[2]);
  }

  /** 远景跟随 position，近景对象跟随 nearPosition；位置或范围没变时什么都不做，每帧调用即可。 */
  focus(position: number[], { nearRadius, farRadius, nearPosition = position }: Focus): void {
    if (this.disposed || this.textureChange) return;
    const center = nearPosition.map((v) => Math.floor(v / 16)),
      farCenter = position.map((v) => Math.floor(v / 128 + 0.5)),
      signature = `${center.join("/")}/${farCenter.join("/")}/${nearRadius}/${farRadius}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.center = center;
    this.farCenter = position.map((v) => v / 16);
    this.nearRadius = nearRadius;
    const side = farRadius * 32,
      origin = [
        Math.floor(position[0] / 128 + 0.5) * 128 - side / 2,
        -64,
        Math.floor(position[2] / 128 + 0.5) * 128 - side / 2,
      ];
    this.gpu.setWindow(origin, [side, 512, side]);
    const wanted = new Map<string, RegionCoord & { visible: boolean }>();
    for (let z = origin[2] / 128; z < (origin[2] + side) / 128; z++)
      for (let x = origin[0] / 128; x < (origin[0] + side) / 128; x++)
        wanted.set(regionKey(x, z), { x, z, visible: true });
    // 所有静态模型都可能越界；整个可见窗口保留一圈来源区域。
    for (const value of [...wanted.values()])
      for (let dz = -this.fragmentRadius; dz <= this.fragmentRadius; dz++)
        for (let dx = -this.fragmentRadius; dx <= this.fragmentRadius; dx++) {
          const x = value.x + dx,
            z = value.z + dz,
            key = regionKey(x, z);
          if (!wanted.has(key)) wanted.set(key, { x, z, visible: false });
        }
    // 地图移到远处时仍保留主相机附近的来源与对象，收起地图无需重新加载对象。
    for (let z = Math.floor((center[2] - nearRadius) / 8); z <= Math.floor((center[2] + nearRadius) / 8); z++)
      for (let x = Math.floor((center[0] - nearRadius) / 8); x <= Math.floor((center[0] + nearRadius) / 8); x++) {
        const key = regionKey(x, z);
        if (this.near(x, z) && !wanted.has(key)) wanted.set(key, { x, z, visible: false });
      }
    const change: WantChange = {
      center: [position[0], position[2]],
      regions: { add: [], remove: [] },
      objects: { add: [], remove: [] },
    };
    const dropped: string[] = [];
    for (const [key, entry] of this.entries)
      if (!wanted.has(key)) {
        this.gpu.remove(key);
        this.objects.removeRegion(key);
        this.entries.delete(key);
        dropped.push(key);
        change.regions.remove.push({ x: entry.x, z: entry.z });
        if (entry.objectSignature) change.objects.remove.push({ x: entry.x, z: entry.z });
        this.dirtyNeighbors(entry.x, entry.z);
      }
    if (dropped.length) this.post({ type: "drop", keys: dropped });
    for (const [key, value] of wanted) {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          x: value.x,
          z: value.z,
          key,
          visible: value.visible,
          near: false,
          state: "waiting",
          request: 0,
          version: 1,
          prepared: 0,
          published: 0,
          objectSignature: "",
          objectsLoaded: "",
          failed: false,
        };
        this.entries.set(key, entry);
        change.regions.add.push({ x: value.x, z: value.z });
      }
      if (entry.visible !== value.visible) this.dirty(entry);
      if (entry.visible && !value.visible) this.gpu.remove(key);
      entry.visible = value.visible;
      entry.near = this.near(value.x, value.z);
      const objectSignature = entry.near ? `${center.join("/")}/${nearRadius}` : "";
      if (objectSignature !== entry.objectSignature) {
        if (objectSignature)
          change.objects.add.push({ x: entry.x, z: entry.z, center: [...center], radius: nearRadius });
        else change.objects.remove.push({ x: entry.x, z: entry.z });
        entry.objectSignature = objectSignature;
      }
      if (!entry.near && entry.objectsLoaded) {
        const changed = this.objects.removeRegion(key);
        entry.objectsLoaded = "";
        if (changed) this.dirtyNeighbors(entry.x, entry.z);
      }
    }
    change.regions.add.sort((a, b) => this.priority(a) - this.priority(b));
    change.objects.add.sort((a, b) => this.priority(a) - this.priority(b));
    if (
      change.regions.add.length ||
      change.regions.remove.length ||
      change.objects.add.length ||
      change.objects.remove.length
    )
      this.source.want(change);
    this.pump();
  }

  private receiveRegion(x: number, z: number, data: ArrayBuffer | null): void {
    const entry = this.entries.get(regionKey(x, z));
    if (this.disposed || !entry) return;
    // 没有方块的区域用只有文件头的编码表示，准备线程照常保存，邻区准备时看到的是空气。
    const buffer = data ?? new Uint32Array([0x34504c54, 0]).buffer;
    this.bytes += buffer.byteLength;
    entry.request = ++this.serial;
    entry.state = "storing";
    entry.failed = false;
    this.post({ type: "put", key: entry.key, request: entry.request, buffer }, [buffer]);
  }

  private async receiveObjects(x: number, z: number, descriptors: ObjectDescriptor[]): Promise<void> {
    const entry = this.entries.get(regionKey(x, z));
    if (this.disposed || !entry || !entry.objectSignature) return;
    const signature = entry.objectSignature;
    try {
      await this.textureChange?.promise;
      if (this.disposed || this.entries.get(entry.key) !== entry || entry.objectSignature !== signature) return;
      const changed = await this.objects.setRegion(entry.key, descriptors, this.registry);
      if (this.disposed) return;
      if (this.entries.get(entry.key) !== entry || entry.objectSignature !== signature) {
        this.objects.removeRegion(entry.key);
        this.dirtyNeighbors(entry.x, entry.z);
        return;
      }
      entry.objectsLoaded = signature;
      if (changed) this.dirtyNeighbors(entry.x, entry.z);
    } catch (error) {
      if ((error as Error)?.name !== "AbortError" && !this.disposed) {
        entry.failed = true;
        this.onError(String(error));
      }
    } finally {
      this.pump();
    }
  }

  private receiveError(x: number, z: number, error: unknown): void {
    const entry = this.entries.get(regionKey(x, z));
    if (this.disposed || !entry) return;
    entry.failed = true;
    if (entry.state === "waiting") entry.state = "failed";
    this.onError(String((error as Error)?.message ?? error));
  }

  /** 准备线程一次只做一个区域，按离相机由近到远。 */
  private pump(): void {
    if (this.disposed || this.textureChange || !this.center || this.preparing || this.ready.length) return;
    let best: Entry | null = null;
    for (const entry of this.entries.values())
      if (
        entry.visible &&
        entry.state === "stored" &&
        !entry.failed &&
        entry.prepared < entry.version &&
        (!best || this.priority(entry) < this.priority(best))
      )
        best = entry;
    if (!best) return;
    const request = ++this.serial;
    this.preparing = { request, entry: best, version: best.version };
    this.post({ type: "prepare", request, x: best.x, z: best.z, objects: this.objects.references() });
  }

  private message(data: WorkerResponse): void {
    if (this.disposed) return;
    if (data.type === "stored") {
      const entry = this.entries.get(data.key);
      if (entry && entry.request === data.request) {
        entry.state = "stored";
        this.dirtyNeighbors(entry.x, entry.z);
      }
    } else if (data.type === "textures") {
      const change = this.textureChange!;
      try {
        for (const result of data.results) this.gpu.install(result);
        this.renderer.setTextures(change.set);
        for (const [key, version] of change.versions) {
          const entry = this.entries.get(key);
          if (!entry) continue;
          entry.prepared = version;
          entry.published = version;
        }
        change.resolve();
      } catch (error) {
        change.reject(error);
      }
      return;
    } else if (data.type === "prepared") {
      const pending = this.preparing;
      if (!pending || pending.request !== data.request) return;
      this.preparing = null;
      if (this.textureChange) return;
      const entry = this.entries.get(pending.entry.key);
      if (entry === pending.entry && entry.version === pending.version && entry.visible) {
        entry.prepared = pending.version;
        this.ready.push({ entry, version: pending.version, result: data.result });
        this.prepareMS += data.result.stats.prepareMS;
      }
    } else if (data.type === "error") {
      if (this.textureChange) {
        this.textureChange.reject(Error(data.error));
        return;
      }
      const entry = this.preparing?.entry ?? (data.key ? this.entries.get(data.key) : undefined);
      if (entry) entry.failed = true;
      this.preparing = null;
      this.onError(data.error);
    }
    this.pump();
  }

  /** 在绘制前发布一个准备好的区域；每帧最多一个，上传不会让单帧卡顿太久。 */
  publish(): void {
    if (this.disposed || this.textureChange) return;
    const next = this.ready.shift();
    if (next && this.entries.get(next.entry.key) === next.entry && next.entry.version === next.version) {
      try {
        const start = performance.now();
        this.gpu.install(next.result);
        this.uploadMS += performance.now() - start;
        next.entry.published = next.version;
      } catch (error) {
        next.entry.failed = true;
        this.onError(String(error));
      }
    }
    this.pump();
  }

  /** 这个区域的方块是否已经显示。 */
  published(x: number, z: number): boolean {
    return this.gpu.regions.has(regionKey(x, z));
  }

  /** 换材质包：用已保存的来源按新的透明分类重新准备显示中的区域，完成后贴图与空间目录在同一帧替换。 */
  async setTextures(set: TextureSet): Promise<void> {
    if (this.disposed) return this.renderer.setTextures(set);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const change: TextureChange = { set, versions: new Map(), promise, resolve, reject };
    this.textureChange = change;
    this.ready = [];
    for (const entry of this.entries.values()) this.dirty(entry);
    const regions = [...this.gpu.regions.keys()].flatMap((key) => {
      const entry = this.entries.get(key);
      if (!entry) return [];
      change.versions.set(key, entry.version);
      return [{ x: entry.x, z: entry.z }];
    });
    this.post({ type: "textures", catalog: set.catalog, regions, objects: this.objects.references() });
    try {
      await promise;
    } finally {
      this.textureChange = null;
      this.pump();
    }
  }

  get stats(): SessionStats {
    const all = [...this.entries.values()],
      installed = [...this.gpu.regions.values()];
    return {
      wanted: all.filter((e) => e.visible).length,
      loaded: this.gpu.regions.size,
      pending: all.filter(
        (e) => !e.failed && (e.state !== "stored" || (e.visible && e.published !== e.version)),
      ).length,
      failed: all.filter((e) => e.failed).length,
      nearPending: all.filter(
        (e) =>
          e.near &&
          ((e.visible && e.published !== e.version) || e.objectsLoaded !== e.objectSignature),
      ).length,
      sections: installed.reduce((n, e) => n + e.stats.sections, 0),
      bytes: this.bytes,
      usedBytes: this.gpu.allocator.used * 4,
      prepareMS: this.prepareMS,
      uploadMS: this.uploadMS,
      objects: this.objects.objects.size,
      unknownBlocks: installed.reduce((n, e) => n + e.stats.unknown, 0),
    };
  }

  /** 关闭数据源与准备线程，清掉对象；GPU 世界留到下一个会话 createWorld 时替换。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textureChange?.reject(Error("会话已经关闭"));
    this.source.close();
    this.worker.terminate();
    this.objects.clear();
    this.ready = [];
  }
}
