/// <reference types="@webgpu/types" />
import { sampleCell } from "./options.ts";
import type { Camera } from "../contracts.ts";
import type { DrawOptions, PhotoOptions, RendererOptions, Tier } from "./options.ts";
import { cameraBasis, cameraRay, PERSPECTIVE_SPAN } from "./camera.ts";
import { hasVisibleAnimation } from "./animation.ts";
import { loadTextureSet, type TextureSet } from "./textures.ts";
import { GPUWorld, materialTextures, objectTextures } from "./webgpu-resources.ts";
import { mod, SIZE } from "./region-directory.ts";
import { displayPipelines, frameFilm, group, readTexture, vertex } from "./webgpu-film.ts";

type Program = Tier | "photo" | "basic-pick" | "voxel-pick";
type Ray = { slots: string[] } & (
  | { kind: "render"; pipeline: GPURenderPipeline }
  | {
      kind: "compute";
      pipeline: GPUComputePipeline;
      retry: GPUComputePipeline;
      groupWidth: number;
      groupHeight: number;
    }
);
type Film = ReturnType<typeof frameFilm>;
type Frame = DrawOptions & {
  bounces?: number;
  jitter?: number[];
  pickPixel?: number[];
  tileOrigin?: [number, number];
};
export async function createWebGPURenderer(
  canvas: HTMLCanvasElement,
  { tier: initial = "shading", assets = "/r2/assets/", readResource, onProgress }: RendererOptions = {},
) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter)
    throw Error(
      "无法取得 WebGPU 设备。请使用支持 WebGPU 的浏览器，并通过 HTTPS、localhost 或本地导出文件打开。",
    );
  const poolLimit = Math.min(
    256 * 1024 * 1024,
    adapter.limits.maxStorageBufferBindingSize,
    adapter.limits.maxBufferSize,
  );
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: poolLimit, maxBufferSize: poolLimit },
    requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
  });
  try {
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw Error("无法创建 WebGPU 画布");
    ctx.configure({
      device,
      format: "rgba8unorm",
      alphaMode: "opaque",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    let fatal = "",
      disposed = false;
    device.lost.then((info) => {
      if (!disposed) fatal = "WebGPU 设备连接中断：" + info.message;
    });
    device.addEventListener("uncapturederror", (e) => {
      fatal = e.error.message;
      console.error(fatal);
    });
    const rayStages = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
    const layout: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: rayStages, buffer: { type: "uniform" } },
      { binding: 3, visibility: rayStages, buffer: { type: "read-only-storage" } },
      { binding: 14, visibility: rayStages, sampler: { type: "filtering" } },
    ];
    for (const binding of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17]) {
      const integer = [1, 2, 4, 6].includes(binding),
        unfiltered = [5, 7, 15, 16].includes(binding);
      layout.push({
        binding,
        visibility: rayStages,
        texture: {
          viewDimension: binding <= 2 ? "3d" : [10, 11, 13].includes(binding) ? "2d-array" : "2d",
          sampleType: integer ? "uint" : unfiltered ? "unfilterable-float" : "float",
        },
      });
    }
    const sceneLayout = device.createBindGroupLayout({ entries: layout });
    const historyLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: rayStages, texture: { sampleType: "unfilterable-float" } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, historyLayout] });
    const outputLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { format: "rgba32float", access: "write-only" },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const computeLayout = device.createPipelineLayout({
      bindGroupLayouts: [sceneLayout, historyLayout, outputLayout],
    });
    let outputs = new WeakMap<GPUTextureView, GPUBindGroup>();
    let retryMask: GPUBuffer | undefined;
    const vert = device.createShaderModule({ code: vertex });
    const programs = new Map<Program, Ray>(),
      jobs = new Map<Program, Promise<void>>();
    async function shaderSource(name: string): Promise<string> {
      const r = await (readResource ? readResource(name) : fetch(new URL(name, import.meta.url)));
      if (!r.ok) throw Error("无法加载 " + name);
      return r.text();
    }
    async function compileProgram(tier: Program): Promise<void> {
      if (programs.has(tier)) return;
      let job = jobs.get(tier);
      if (!job) {
        job = (async () => {
          const name = tier + ".wgsl";
          const code = await shaderSource(name),
            slots = code
              .match(/^\/\/ Uniform slots: (.*)$/m)?.[1]
              .trim()
              .split(",");
          if (!slots) throw Error("无效的 R2 着色器 " + name);
          const module = device.createShaderModule({ code });
          if (tier === "shading" || tier === "accumulation" || tier === "photo") {
            const size = /@workgroup_size\((\d+),\s*(\d+),\s*1\)/.exec(code);
            if (!size) throw Error("着色器缺少工作组尺寸 " + tier);
            const makePipeline = (module: GPUShaderModule, label: string) =>
              device.createComputePipelineAsync({
                label,
                layout: computeLayout,
                compute: { module, entryPoint: "main" },
              });
            const [pipeline, retry] = await Promise.all([
              makePipeline(module, tier),
              shaderSource(tier + "-retry.wgsl").then((code) =>
                makePipeline(device.createShaderModule({ code }), tier + "-retry"),
              ),
            ]);
            programs.set(tier, {
              kind: "compute",
              pipeline,
              retry,
              slots,
              groupWidth: Number(size[1]),
              groupHeight: Number(size[2]),
            });
            return;
          }
          const pipeline = await device.createRenderPipelineAsync({
            label: tier,
            layout: pipelineLayout,
            vertex: { module: vert, entryPoint: "vert" },
            fragment: {
              module,
              entryPoint: "main",
              targets: [{ format: "rgba32float" }],
            },
          });
          programs.set(tier, { kind: "render", pipeline, slots });
        })().finally(() => jobs.delete(tier));
        jobs.set(tier, job);
      }
      return job;
    }
    await onProgress?.({ index: 1, total: 3, label: "正在编译 WebGPU " + initial + " 着色器…" });
    const keyFor = (tier: Tier, purpose?: "photo"): Program =>
      purpose === "photo" && tier === "accumulation" ? "photo" : tier;
    const compile = (tier: Tier, purpose?: "photo") => compileProgram(keyFor(tier, purpose));
    await compile(initial);
    await onProgress?.({ index: 2, total: 3, label: "正在加载材质与方块模型…" });
    const set = await loadTextureSet(readResource ?? ((name) => fetch(assets + name))),
      { catalog, states } = set,
      references = set.files.get("quad-references.bin")!;
    let materials = materialTextures(device, set, references),
      objects = objectTextures(device),
      generation = 0,
      world: GPUWorld | null = null;
    await onProgress?.({ index: 3, total: 3, label: "正在准备 WebGPU 绘制缓冲区…" });
    const fx = await displayPipelines(device, vert),
      sampler = device.createSampler({ minFilter: "nearest", magFilter: "nearest", mipmapFilter: "linear" });
    const frame = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const emptyInfo = device.createTexture({
      size: [1, 1, 1],
      dimension: "3d",
      format: "rgba32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const emptyTree = device.createTexture({
      size: [1, 1, 1],
      dimension: "3d",
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const emptyPool = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
    const emptyHistory = device.createTexture({
      size: [1, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const pickHistory = group(device, historyLayout, [[0, emptyHistory.createView()]]);
    let boundPool: GPUBuffer;
    function bind() {
      boundPool = world?.pool ?? emptyPool;
      const pairs: [number, GPUBindingResource][] = [
        [0, { buffer: frame }],
        [1, (world?.info ?? emptyInfo).createView()],
        [2, (world?.tree ?? emptyTree).createView()],
        [3, { buffer: world?.pool ?? emptyPool }],
        [14, sampler],
        [16, objects.table.createView()],
        [17, objects.atlas.createView()],
      ];
      materials.views.forEach((v, i) => pairs.push([i === 10 ? 15 : i + 4, v]));
      return group(device, sceneLayout, pairs);
    }
    let scene = bind(),
      waterTime = 0,
      film: Film | undefined,
      samples = 0,
      keepPreview = false;
    let pendingFrame = false,
      epoch = 0;
    let frameDone: Promise<void> = Promise.resolve();
    const times: number[] = [];
    const queries = device.features.has("timestamp-query")
      ? device.createQuerySet({ type: "timestamp", count: 2 })
      : null;
    function resetTiming() {
      epoch++;
      times.length = 0;
    }
    function prepare(camera: Camera, tier: Program, o: Frame, history: boolean, sampleIndex = 0) {
      if (boundPool !== (world?.pool ?? emptyPool)) scene = bind();
      if (fatal) throw Error(fatal);
      const ray = programs.get(tier)!;
      const { right, up, forward } = cameraBasis(camera),
        origin = world?.origin ?? [0, 0, 0],
        sun = o.sun ?? [0.45, 0.62, 0.3],
        length = Math.hypot(...sun);
      const values: Record<string, number | number[]> = {
        uCamera: camera.position.map((v, i) => v - origin[i]),
        uRight: right,
        uUp: up,
        uForward: forward,
        uSpan: camera.ortho ?? PERSPECTIVE_SPAN,
        uOrtho: +(camera.ortho !== undefined),
        uSize: world?.size ?? [0, 0, 0],
        uHasWorld: +!!world,
        uViewport: [o.width, o.height],
        uFrame: sampleIndex,
        uSun: sun.map((v) => v / length),
        uWorldOrigin: origin,
        uDirectoryOffset: [mod(origin[0], SIZE[0] * 16), 0, mod(origin[2], SIZE[2] * 16)],
        uOcean: +(o.ocean !== undefined),
        uOceanHeight: (o.ocean ?? 0) - origin[1],
        uTime: o.time ?? 0,
        uPicking: +!!o.pickPixel,
        uPickPixel: o.pickPixel ?? [0, 0],
        uWater: catalog.water,
        uWaterGroup: catalog.models[catalog.water].group,
        uFragments: +(o.fragments !== false),
        uHierarchy: +(o.hierarchy !== false),
        uObjectsEnabled: +(o.objects !== false && objects.store.enabled !== false),
        uDebug: o.debug ?? 0,
        uBounces: o.bounces ?? 1,
        uJitter: o.jitter ?? [0, 0, 1],
        uFog: o.fog ?? (world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9),
      };
      const data = new Float32Array(256);
      ray.slots.forEach((name, i) => {
        const v = values[name] ?? 0;
        data.set(typeof v === "number" ? [v] : v, i * 4);
      });
      if (o.tileOrigin) data.set(o.tileOrigin, 62 * 4);
      data[252] = +history;
      device.queue.writeBuffer(frame, 0, data);
      return 0.9 * (1 + 2.3 * (1 - Math.max(0, Math.min(1, (sun[1] / length + 0.1) / 0.3))));
    }
    type Target = { hdr: GPUTextureView; history: GPUBindGroup; width: number; height: number };
    function trace(enc: GPUCommandEncoder, tier: Program, target: Target, tile?: number[], timer = false) {
      const ray = programs.get(tier)!;
      const timestampWrites =
        timer && queries ? { querySet: queries, beginningOfPassWriteIndex: 0 } : undefined;
      if (ray.kind === "compute") {
        const groupsX = Math.ceil((tile?.[2] ?? target.width) / ray.groupWidth);
        const groupsY = Math.ceil((tile?.[3] ?? target.height) / ray.groupHeight);
        const bytes = groupsX * groupsY * 4;
        if (!retryMask || retryMask.size < bytes) {
          retryMask?.destroy();
          retryMask = device.createBuffer({
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          outputs = new WeakMap();
        }
        enc.clearBuffer(retryMask, 0, bytes);
        let output = outputs.get(target.hdr);
        if (!output) {
          output = group(device, outputLayout, [
            [0, target.hdr],
            [1, { buffer: retryMask }],
          ]);
          outputs.set(target.hdr, output);
        }
        for (const pipeline of [ray.pipeline, ray.retry]) {
          const pass = enc.beginComputePass({
            timestampWrites: pipeline === ray.pipeline ? timestampWrites : undefined,
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, scene);
          pass.setBindGroup(1, target.history);
          pass.setBindGroup(2, output);
          pass.dispatchWorkgroups(groupsX, groupsY);
          pass.end();
        }
        return;
      }
      const p = enc.beginRenderPass({
        colorAttachments: [
          {
            view: target.hdr,
            loadOp: tile && tile[0] + tile[1] > 0 ? "load" : "clear",
            clearValue: [0, 0, 0, 0],
            storeOp: "store",
          },
        ],
        timestampWrites,
      });
      p.setPipeline(ray.pipeline);
      p.setBindGroup(0, scene);
      p.setBindGroup(1, target.history);
      if (tile) p.setScissorRect(tile[0], tile[1], tile[2], tile[3]);
      p.draw(3);
      p.end();
    }
    function present(enc: GPUCommandEncoder, f: Film) {
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width;
        canvas.height = f.height;
      }
      enc.copyTextureToTexture({ texture: f.output }, { texture: ctx!.getCurrentTexture() }, [
        f.width,
        f.height,
      ]);
    }
    function submitFrame(camera: Camera, o: DrawOptions) {
      const tier = o.accumulate ? "accumulation" : (o.tier ?? "shading");
      // 每次只接受一张交互画面。GPU 忙时让宿主继续处理输入，下次绘制直接取最新相机。
      if (!programs.has(tier) || pendingFrame) return false;
      if (!film || film.width !== o.width || film.height !== o.height) {
        film?.dispose();
        film = frameFilm(device, fx, historyLayout, o.width, o.height);
        resetTiming();
        samples = 0;
        keepPreview = false;
      }
      const add = !!o.accumulate && (samples > 0 || keepPreview);
      if (!o.accumulate) {
        waterTime = o.time ?? 0;
        samples = 0;
        keepPreview = tier === "shading";
      } else samples++;
      objects.store.update(o.time ?? 0, world?.origin ?? [0, 0, 0]);
      const exposure = prepare(camera, tier, { ...o, time: waterTime }, add, Math.max(0, samples - 1)),
        enc = device.createCommandEncoder();
      trace(enc, tier, film.next(), undefined, !!queries);
      film.composite(enc, exposure, !!o.debug, queries);
      present(enc, film);
      let read: GPUBuffer | undefined, resolve: GPUBuffer | undefined;
      if (queries) {
        resolve = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        enc.resolveQuerySet(queries, 0, 2, resolve, 0);
        enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
      }
      device.queue.submit([enc.finish()]);
      pendingFrame = true;
      const stamp = epoch;
      frameDone = device.queue.onSubmittedWorkDone();
      frameDone.then(
        () => {
          pendingFrame = false;
        },
        () => {
          pendingFrame = false;
        },
      );
      if (read) {
        const buffer = read;
        void buffer
          .mapAsync(GPUMapMode.READ)
          .then(() => {
            const [a, b] = new BigUint64Array(buffer.getMappedRange());
            if (stamp === epoch && b > a) {
              times.push(Number(b - a) / 1e6);
              if (times.length > 240) times.shift();
            }
          })
          .catch(() => {})
          .finally(() => {
            buffer.destroy();
            resolve?.destroy();
          });
      }
      return true;
    }
    function draw(camera: Camera, o: DrawOptions & { synchronize: true }): Promise<boolean>;
    function draw(camera: Camera, o: DrawOptions & { synchronize?: false }): boolean;
    function draw(camera: Camera, o: DrawOptions): boolean | Promise<boolean>;
    function draw(camera: Camera, o: DrawOptions) {
      if (o.synchronize)
        return device.queue.onSubmittedWorkDone().then(async () => {
          const rendered = submitFrame(camera, o);
          await device.queue.onSubmittedWorkDone();
          return rendered;
        });
      return submitFrame(camera, o);
    }
    async function pick(camera: Camera, pixel: { width: number; height: number; x: number; y: number }) {
      const tier =
        programs.has("basic") || programs.has("shading") || programs.has("accumulation")
          ? "basic-pick"
          : "voxel-pick";
      await compileProgram(tier);
      const target = device.createTexture({
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      try {
        prepare(
          camera,
          tier,
          {
            ...pixel,
            objects: false,
            pickPixel: [Math.floor(pixel.x) + 0.5, pixel.height - Math.floor(pixel.y) - 0.5],
          },
          false,
        );
        const enc = device.createCommandEncoder();
        trace(enc, tier, { hdr: target.createView(), history: pickHistory, width: 1, height: 1 });
        device.queue.submit([enc.finish()]);
        const ray = cameraRay(camera, { ...pixel, x: Math.floor(pixel.x), y: Math.floor(pixel.y) });
        const hit = new Float32Array((await readTexture(device, target, 16)).buffer);
        if (hit[0] < 0) return null;
        const normal = Array.from(hit.subarray(1));
        return {
          position: ray.origin.map((v, i) => Math.floor(v + ray.direction[i] * hit[0] - normal[i] * 0.002)),
          normal,
        };
      } finally {
        target.destroy();
      }
    }
    function photograph(camera: Camera, o: PhotoOptions) {
      const { width, height, tier = "accumulation" } = o;
      const program = keyFor(tier, (o.bounces ?? 4) === 1 ? undefined : "photo");
      let compileError: unknown;
      if (!programs.has(program))
        void compileProgram(program).catch((error) => {
          compileError = error;
        });
      const f = frameFilm(device, fx, historyLayout, width, height),
        view = { ...camera, position: camera.position.slice() },
        grid = Math.max(1, Math.round(o.supersample ?? (tier === "accumulation" ? 1 : 4))),
        total = tier === "accumulation" ? Infinity : grid * grid;
      const columns = Math.ceil(width / 256),
        tiles = columns * Math.ceil(height / 256);
      let done = 0,
        tile = 0,
        pending = false,
        closed = false,
        presented = 0,
        target: Target,
        exposure = 1;
      return {
        get samples() {
          return done;
        },
        get complete() {
          return done >= total;
        },
        step() {
          if (compileError) throw compileError;
          if (closed || pending || done >= total || !programs.has(program)) return;
          if (!tile) {
            target = f.next();
            objects.store.update(o.time ?? 0, world?.origin ?? [0, 0, 0]);
          }
          const jitter = sampleCell(done, grid);
          const x = (tile % columns) * 256,
            y = Math.floor(tile / columns) * 256;
          exposure = prepare(
            view,
            program,
            { ...o, tier: undefined, bounces: o.bounces ?? 4, jitter, tileOrigin: [x, y] },
            done > 0,
            done,
          );
          const enc = device.createCommandEncoder();
          trace(enc, program, target, [x, y, Math.min(256, width - x), Math.min(256, height - y)]);
          const last = ++tile === tiles;
          if (last) f.composite(enc, exposure, false);
          device.queue.submit([enc.finish()]);
          pending = true;
          device.queue.onSubmittedWorkDone().then(
            () => {
              pending = false;
              if (last) {
                done++;
                tile = 0;
              }
            },
            () => {
              closed = true;
            },
          );
        },
        present() {
          if (done > presented && !closed) {
            presented = done;
            const enc = device.createCommandEncoder();
            present(enc, f);
            device.queue.submit([enc.finish()]);
          }
        },
        async png() {
          const data = await readTexture(device, f.output, 4);
          const c = new OffscreenCanvas(width, height);
          c.getContext("2d")!.putImageData(
            new ImageData(new Uint8ClampedArray(data.buffer), width, height),
            0,
            0,
          );
          return c.convertToBlob({ type: "image/png" });
        },
        dispose() {
          closed = true;
          f.dispose();
        },
      };
    }
    function clear() {
      world?.dispose();
      world = null;
      objects.store.clear();
      scene = bind();
      generation++;
      samples = 0;
      keepPreview = false;
      resetTiming();
    }
    const readyError = await device.queue.onSubmittedWorkDone().then(() => fatal);
    if (readyError) throw Error(readyError);
    return {
      backend: "webgpu" as const,
      gl: null,
      device,
      maxTextureSize: device.limits.maxTextureDimension2D,
      catalog,
      states,
      compile,
      draw,
      pick,
      photograph,
      ready: (tier: Tier, purpose?: "photo") => programs.has(keyFor(tier, purpose)),
      compiling: (tier: Tier, purpose?: "photo") => jobs.has(keyFor(tier, purpose)),
      get objects() {
        return objects.store;
      },
      get version() {
        return generation + "/" + (world?.version ?? 0) + "/" + objects.store.version;
      },
      /** 最近一次成功提交的交互画面在 GPU 上完成时兑现。 */
      get frameDone() {
        return frameDone;
      },
      get accumulated() {
        return samples;
      },
      get times() {
        return times.slice();
      },
      resetTiming,
      get textureBytes() {
        return materials.bytes + objects.store.textureBytes + (world?.textureBytes ?? 0) + (film?.bytes ?? 0);
      },
      animating: (camera: Camera, size: { width: number; height: number }) =>
        hasVisibleAnimation(objects.store, camera, size),
      createWorld({ capacityWords = Math.floor(poolLimit / 4) } = {}) {
        if (capacityWords * 4 > poolLimit) throw Error("区域池超过当前 GPU 容量");
        const next = new GPUWorld(device, capacityWords);
        world?.dispose();
        world = next;
        objects.store.dispose();
        objects = objectTextures(device);
        scene = bind();
        generation++;
        samples = 0;
        keepPreview = false;
        resetTiming();
        return world;
      },
      setTextures(set: TextureSet) {
        const next = materialTextures(device, set, references);
        materials.dispose();
        materials = next;
        Object.assign(catalog, set.catalog);
        scene = bind();
        generation++;
        resetTiming();
      },
      fence() {
        let ready = false;
        device.queue.onSubmittedWorkDone().then(
          () => (ready = true),
          () => (ready = true),
        );
        return { ready: () => ready, dispose() {} };
      },
      async pixels() {
        if (!film) return new Uint8Array(0);
        const { output, width, height } = film,
          raw = await readTexture(device, output, 4),
          flipped = new Uint8Array(raw.length),
          row = width * 4;
        for (let y = 0; y < height; y++)
          flipped.set(raw.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
        return flipped;
      },
      clear,
      dispose() {
        disposed = true;
        world?.dispose();
        objects.store.dispose();
        materials.dispose();
        film?.dispose();
        retryMask?.destroy();
        ctx.unconfigure();
        device.destroy();
      },
    };
  } catch (e) {
    device.destroy();
    throw e;
  }
}
