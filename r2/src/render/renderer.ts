import { createTextures, type TextureSet } from "./textures.ts";
import { createAccumulator } from "./accumulator.ts";
import { WorldGPU } from "./world-gpu.ts";
import { ObjectStore } from "../objects/store.ts";
import type { Camera } from "../contracts.ts";

import {
  cameraBasis as basis,
  cameraRay,
  PERSPECTIVE_SPAN as SPAN,
} from "./camera.ts";

// 拍照时每次绘制覆盖的方块边长（像素）。
const PHOTO_TILE = 256;

/** 单帧预览可选的三档绘制器，从低到高：
 * voxel 每个格子画成纯色立方体；basic 完整方块形状与贴图，没有阴影、雾与水面效果；
 * shading 硬阴影、远景雾、水面波纹与反射、labPBR 材质。 */
export type PreviewTier = "voxel" | "basic" | "shading";
/** 四档绘制器；accumulation 在光影之上加软阴影与漫反射反弹，静止累积与拍照专用。 */
export type Tier = PreviewTier | "accumulation";
/** 档位在着色器里的编号，与 ray.frag 的 RENDER_TIER 一致。 */
const TIERS: readonly Tier[] = ["voxel", "basic", "shading", "accumulation"];
const TIER_NAMES: Record<Tier, string> = {
  voxel: "体素绘制器",
  basic: "基础绘制器",
  shading: "光影绘制器",
  accumulation: "累积绘制器",
};
/** 射线程序的全部采样器及其固定纹理单元；各档程序链接后按这张表设置，换程序时贴图绑定保持不变。 */
const SAMPLER_UNITS: Record<string, number> = {
  uAtlasNormals: 0,
  uTree: 1,
  uModels: 2,
  uQuadRecords: 3,
  uFast: 4,
  uAtlas: 5,
  uSurfaces: 6,
  uSurfaceNormals: 7,
  uQuadReferences: 8,
  uSurfaceSpecular: 9,
  uSections: 10,
  uWorldData: 11,
  uObjectData: 12,
  uObjectAtlas: 13,
  uAtlasSpecular: 14,
  uVoxels: 18,
};

export interface RendererOptions {
  /** 资源目录的 URL，以 / 结尾。 */
  assets?: string;
  /** 离线宿主按文件名提供着色器、模型与贴图。省略时从模块与 assets 目录读取。 */
  readResource?: (name: string) => Promise<Response>;
  /** 启动时编译的预览档，默认 shading；其他档第一次需要时用 compile() 编译。 */
  tier?: PreviewTier;
  /** 每个启动阶段开始前调用；返回 Promise 时等它完成，宿主可先绘制状态提示。 */
  onProgress?: (step: { index: number; total: number; label: string }) => void | Promise<void>;
}

/** 光照、时间与可选效果；预览、累积与拍照共用。阴影、雾与海面效果只在 shading 与 accumulation 档出现。 */
export interface LightingOptions {
  /** 动画时钟（秒），驱动水波与活动对象。 */
  time?: number;
  /** 指向太阳的方向；太阳在地平线下时由月亮照明。 */
  sun?: number[];
  /** 远景雾接近不透明的距离，默认为观察窗口半径。 */
  fog?: number;
  /** 无限海面的世界高度；省略时只绘制场景里的体素水。 */
  ocean?: number;
  /** 为假时这次绘制隐藏特殊对象。 */
  objects?: boolean;
}

export interface DrawOptions extends LightingOptions {
  width: number;
  height: number;
  /** 预览用哪一档，默认 shading；必须已经编译好。 */
  tier?: PreviewTier;
  /** 相机、设置与场景都和上一帧相同：这一帧用累积档作为样本加到画面上。 */
  accumulate?: boolean;
  debug?: number;
  hierarchy?: boolean;
  fragments?: boolean;
  /** 绘制后读回一个像素，等待 GPU 完成。 */
  synchronize?: boolean;
}

export interface PhotoOptions extends LightingOptions {
  width: number;
  height: number;
  /** 用哪一档绘制，默认 accumulation：每个像素不停累积随机样本，没有上限。
   * 预览档用于导出当前画面：每个像素按 supersample×supersample 的网格取样，取满后完成。 */
  tier?: Tier;
  /** 预览档每个像素每边的样本数，默认 4。 */
  supersample?: number;
  /** 累积档光线最多反弹次数。 */
  bounces?: number;
}

/** 一帧的全部着色器输入。 */
interface FrameInputs {
  width: number;
  height: number;
  tier: Tier;
  /** 预览档的像素内偏移，单位为像素。 */
  jitter?: number[];
  bounces: number;
  time: number;
  waterTime?: number;
  debug: number;
  hierarchy: boolean;
  fragments: boolean;
  sun: number[];
  fog: number;
  ocean?: number;
  objects?: boolean;
}

type Uniforms = Map<string, WebGLUniformLocation | null>;
/** 让宿主刚显示的提示先上屏：驱动编译可能占住 GPU 进程，期间页面无法再合成新画面。
 * 后台页面不触发动画帧，超时后照样继续。 */
function paint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
    setTimeout(resolve, 250);
  });
}
/** 创建射线绘制器；宿主负责相机、帧循环和数据来源，绘制器不读取 UI。
 * 四档绘制器各自编译。启动时只编译 options.tier 指定的预览档；其余各档第一次需要时由宿主调用 compile()，
 * 编译期间已有的档照常绘制。累积档最大，在 Windows 的 D3D 后端可能要编一两分钟。
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  { assets = "/r2/assets/", tier: initialTier = "shading", readResource, onProgress }: RendererOptions = {},
) {
  const context = canvas.getContext("webgl2", {
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!context) throw Error("需要支持 WebGL 2 的浏览器");
  const gl: WebGL2RenderingContext = context;
  const [fragmentSource, objectSource] = await Promise.all(
    ["ray.frag", "objects.frag"].map((name) =>
      (readResource ? readResource(name) : fetch(new URL(name, import.meta.url))).then((r) => r.text()),
    ),
  );
  const fragment = fragmentSource.replace("#include <objects>", objectSource);
  const vertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
  const uniformNames = [
    "uTree",
    "uModels",
    "uQuadRecords",
    "uQuadReferences",
    "uFast",
    "uAtlas",
    "uSurfaces",
    "uSize",
    "uCamera",
    "uRight",
    "uUp",
    "uForward",
    "uViewport",
    "uSpan",
    "uOrtho",
    "uHasWorld",
    "uPicking",
    "uPickPixel",
    "uDebug",
    "uHierarchy",
    "uFragments",
    "uSun",
    "uWorldData",
    "uSections",
    "uFrame",
    "uWaterGroup",
    "uWater",
    "uJitter",
    "uFog",
    "uTime",
    "uOcean",
    "uOceanHeight",
    "uWorldOrigin",
    "uBounces",
    "uDirectoryOffset",
    "uObjectData",
    "uObjectAtlas",
    "uObjectsEnabled",
    ...Object.keys(SAMPLER_UNITS),
  ];
  /** 一档编译好的程序与它的 uniform 位置。 */
  interface Compiled {
    program: WebGLProgram;
    locations: Uniforms;
  }
  /** 编译一档射线程序；各档共享纹理和世界数据，链接后按固定表设置采样器单元。 */
  async function createRayProgram(tier: Tier): Promise<Compiled> {
    await paint();
    const program = gl.createProgram();
    const shaders: WebGLShader[] = [];
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [
        gl.FRAGMENT_SHADER,
        fragment.replace(
          "#version 300 es",
          `#version 300 es\n#define RENDER_TIER ${TIERS.indexOf(tier)}`,
        ),
      ],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw Error("无法创建着色器");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      shaders.push(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    // Windows 的驱动编译可能很慢；完成前查询 LINK_STATUS 会同步阻塞整个页面。
    function checkContext() {
      if (gl.isContextLost()) throw Error("着色器编译期间 WebGL 上下文丢失，请刷新页面重试");
    }
    while (parallel) {
      checkContext();
      if (gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    // 上下文丢失后完成状态也可能为真，且状态查询本身可能发现 GPU 进程已退出。
    checkContext();
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    checkContext();
    const errors = linked ? "" : shaders
      .map((shader) => gl.getShaderInfoLog(shader)).filter(Boolean).join("\n") || gl.getProgramInfoLog(program);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!linked) {
      gl.deleteProgram(program);
      throw Error(`${TIER_NAMES[tier]}编译失败：${errors || "浏览器未提供编译日志"}`);
    }
    const locations: Uniforms = new Map(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    const current = gl.getParameter(gl.CURRENT_PROGRAM);
    gl.useProgram(program);
    for (const [name, unit] of Object.entries(SAMPLER_UNITS))
      gl.uniform1i(locations.get(name) ?? null, unit);
    gl.useProgram(current);
    return { program, locations };
  }
  /** 已编译的各档程序与正在编译的档。 */
  const programs = new Map<Tier, Compiled>(),
    compiling = new Map<Tier, Promise<void>>();
  /** 编译一档绘制器；只编译一次，重复调用返回同一个 Promise。失败后可以再次调用重试。 */
  function compile(tier: Tier): Promise<void> {
    if (programs.has(tier)) return Promise.resolve();
    let job = compiling.get(tier);
    if (!job) {
      job = createRayProgram(tier).then(
        (compiled) => {
          programs.set(tier, compiled);
          compiling.delete(tier);
        },
        (error) => {
          compiling.delete(tier);
          throw error;
        },
      );
      compiling.set(tier, job);
    }
    return job;
  }
  // 宿主可先绘制状态提示，再进入可能阻塞页面的驱动编译。
  await onProgress?.({ index: 1, total: 3, label: `正在编译${TIER_NAMES[initialTier]}…` });
  await compile(initialTier);
  let program = programs.get(initialTier)!.program;
  gl.useProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  /** 当前程序的 uniform 位置；世界、对象与贴图模块持有同一个表，换程序时整体替换内容。 */
  const uniforms: Uniforms = new Map(programs.get(initialTier)!.locations);
  const u = (name: string) => uniforms.get(name) ?? null;
  await onProgress?.({ index: 2, total: 3, label: "正在加载材质与方块模型…" });
  const textures = await createTextures(gl, uniforms, assets, readResource),
    catalog = textures.catalog,
    states = textures.states;
  // 即使只画天空，WebGL 仍验证所有采样器；用最小的空纹理满足整数采样器绑定。
  const empty = [
    [1, gl.TEXTURE_3D, "uTree"],
    [10, gl.TEXTURE_3D, "uSections"],
    [11, gl.TEXTURE_2D, "uWorldData"],
  ].map(([unit, target, name]) => {
    // 表项是固定的三元组。
    return [unit, target, name] as [number, number, string];
  }).map(([unit, target, name]) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, texture);
    if (target === gl.TEXTURE_3D) gl.texStorage3D(target, 1, gl.R32UI, 1, 1, 1);
    else gl.texStorage2D(target, 1, gl.R32UI, 1, 1);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { unit, target, name, texture };
  });
  let objects = new ObjectStore(gl, uniforms);
  await onProgress?.({ index: 3, total: 3, label: "正在准备绘制缓冲区…" });
  const accumulator = createAccumulator(gl, vertex);
  // 累积样本的随机种子；每帧不同，样本之间才互不相关。
  let frame = 0;
  // 一个累积序列固定水面时刻，否则样本会把移动波纹平均成模糊镜面。
  let waterTime = 0;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    queries: WebGLQuery[] = [],
    times: number[] = [];
  let world: WorldGPU | null = null,
    origin = [0, 0, 0],
    // 世界或对象仓库被整体替换时加一，与它们各自的版本一起组成场景版本。
    generation = 0;
  function resetTiming() {
    for (const q of queries) gl.deleteQuery(q);
    queries.length = 0;
    times.length = 0;
  }
  function createWorld(options: { capacityWords?: number } = {}): WorldGPU {
    gl.useProgram(program);
    objects.dispose();
    objects = new ObjectStore(gl, uniforms);
    world?.dispose();
    world = new WorldGPU(gl, uniforms, options);
    generation++;
    resetTiming();
    return world;
  }
  /** 绑定射线程序并写入一帧的全部输入，预览、累积和拍照共用；返回这一帧的曝光。
   * 夜间提高曝光，让微弱月光仍可见，同时给灯块保留高光余量。
   */
  function prepare(
    camera: Camera,
    {
      width,
      height,
      tier,
      jitter = [0, 0],
      bounces,
      time,
      waterTime = time,
      debug,
      hierarchy,
      fragments,
      sun,
      fog,
      ocean,
      objects: drawObjects = true,
    }: FrameInputs,
  ): number {
    const compiled = programs.get(tier);
    if (!compiled) throw Error(`${TIER_NAMES[tier]}尚未编译，先调用 compile("${tier}")`);
    if (program !== compiled.program) {
      program = compiled.program;
      for (const [name, location] of compiled.locations)
        uniforms.set(name, location);
    }
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, width, height);
    if (world) {
      origin = world.origin;
      world.bind();
    } else {
      origin = [0, 0, 0];
      for (const { unit, target, name, texture } of empty) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(target, texture);
        gl.uniform1i(u(name), unit);
      }
    }
    gl.uniform1i(u("uHasWorld"), Number(world !== null));
    gl.uniform1i(u("uPicking"), 0);
    gl.uniform1i(u("uOrtho"), Number(camera.ortho !== undefined));
    const { forward, right, up } = basis(camera);
    gl.uniform2f(u("uViewport"), width, height);
    gl.uniform3fv(
      u("uCamera"),
      camera.position.map((v, i) => v - origin[i]),
    );
    gl.uniform3fv(u("uForward"), forward);
    gl.uniform3fv(u("uRight"), right);
    gl.uniform3fv(u("uUp"), up);
    gl.uniform1f(u("uSpan"), camera.ortho ?? SPAN);
    gl.uniform1ui(u("uFrame"), frame++);
    gl.uniform1ui(
      u("uWaterGroup"),
      catalog.models[catalog.water].group,
    );
    gl.uniform1ui(u("uWater"), catalog.water);
    gl.uniform2fv(u("uJitter"), jitter);
    gl.uniform1f(u("uFog"), fog);
    gl.uniform1f(u("uTime"), waterTime);
    gl.uniform1i(u("uOcean"), Number(ocean !== undefined));
    gl.uniform1f(u("uOceanHeight"), (ocean ?? 0) - origin[1]);
    gl.uniform3fv(u("uWorldOrigin"), origin);
    gl.uniform1i(u("uBounces"), bounces);
    gl.uniform1i(u("uDebug"), debug);
    gl.uniform1i(u("uHierarchy"), Number(hierarchy));
    gl.uniform1i(u("uFragments"), Number(fragments));
    const length = Math.hypot(...sun);
    gl.uniform3fv(
      u("uSun"),
      sun.map((v) => v / length),
    );
    gl.uniform1i(
      u("uObjectsEnabled"),
      !drawObjects || objects.enabled === false ? 0 : 1,
    );
    objects.update(time, origin);
    const night = 1 - Math.min(1, Math.max(0, (sun[1] / length + 0.1) / 0.3));
    return 0.9 * (1 + 2.3 * night);
  }
  // 上一帧预览所用的档；累积从光影预览开始时保留预览帧作为起点，其他档的画面差别太大，先清空。
  let previewTier: PreviewTier = initialTier;
  /** 只绘制当前已发布的数据；每帧上传的实例变换也计入 GPU 时间。
   * accumulate 为假时用 tier 档重新出一帧干净的预览；为真表示相机、设置与场景都和上一帧相同，
   * 这一帧用累积档作为样本加到画面上，带抗锯齿、软阴影和一次漫反射反弹。所需的档尚未编译好时不画，返回 false。
   * ocean 指定无限海面的世界高度；省略时只绘制场景里的体素水。
   * sun 是指向太阳的方向，太阳在地平线下时由月亮照明；fog 是远景雾接近不透明的距离，默认为观察窗口半径。
   */
  function draw(
    camera: Camera,
    {
      width,
      height,
      tier = "shading",
      accumulate = false,
      time = 0,
      debug = 0,
      hierarchy = true,
      fragments = true,
      sun = [0.45, 0.62, 0.3],
      fog = world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9,
      ocean,
      objects = true,
      synchronize = false,
    }: DrawOptions,
  ): boolean {
    if (!programs.has(accumulate ? "accumulation" : tier)) return false;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      resetTiming();
    }
    accumulator.resize(width, height);
    if (!accumulate) {
      waterTime = time;
      previewTier = tier;
    } else if (accumulator.samples === 0 && previewTier !== "shading") accumulator.clear();
    accumulator.begin(accumulate);
    const exposure = prepare(camera, {
      width,
      height,
      objects,
      tier: accumulate ? "accumulation" : tier,
      bounces: 1,
      time,
      waterTime,
      debug,
      hierarchy,
      fragments,
      sun,
      fog,
      ocean,
    });
    if (timer && gl.getParameter(timer.GPU_DISJOINT_EXT)) resetTiming();
    while (
      queries.length &&
      gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = queries.shift()!;
      times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      if (times.length > 240) times.shift();
      gl.deleteQuery(q);
    }
    const q = timer && queries.length < 8 ? gl.createQuery() : null;
    // GPU 时间包括射线绘制与显示合成（泛光、色调映射）。
    if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    accumulator.present({ exposure, raw: debug !== 0 });
    if (q) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    if (synchronize)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return true;
  }
  /** 拍一张照片：相机固定，每个像素累积多个样本。默认用累积档，不停累积随机样本（抗锯齿、软阴影、
   * 光线最多反弹 bounces 次），没有样本上限；指定预览档时按 supersample×supersample 的网格在像素内取样，取满后 complete 为真，
   * 用于以更高设置导出当前预览画面。一个样本要跑很久，整张画面一次画完可能触发 Windows 的显卡超时重置，
   * 所以画面切成小块分批提交。GPU 上始终排着两批，一批画完时下一批已经在等，不必空等下一帧；
   * 批量按完成速度调整：每帧都把队列画空就加倍，一批拖过两帧就减半。
   * 宿主在每个动画帧调用 step() 推进、present() 把当前结果显示到画布上，期间暂停交互绘制；
   * 满意时用 png() 取图，再 dispose()。所用的档需要先 compile()。
   */
  function photograph(
    camera: Camera,
    {
      width,
      height,
      tier = "accumulation",
      supersample = 4,
      objects = true,
      bounces = 4,
      time = 0,
      sun = [0.45, 0.62, 0.3],
      fog = world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9,
      ocean,
    }: PhotoOptions,
  ) {
    if (!programs.has(tier)) throw Error(`拍照需要先调用 compile("${tier}")`);
    const film = createAccumulator(gl, vertex),
      tiles: Array<[number, number]> = [];
    film.resize(width, height);
    film.clear();
    for (let y = 0; y < height; y += PHOTO_TILE)
      for (let x = 0; x < width; x += PHOTO_TILE) tiles.push([x, y]);
    const view = { ...camera, position: [...camera.position] },
      grid = tier === "accumulation" ? 0 : Math.max(1, Math.round(supersample)),
      // 预览档取满网格后不再提交；累积档没有上限。
      total = grid ? grid * grid * tiles.length : Infinity;
    let done = 0,
      finished = 0,
      batch = 1,
      exposure = 1;
    // 已提交、尚未完成的批次；end 是这一批画完后累计画完的小块数，age 是提交后经过的 step 次数。
    const pending: Array<{ sync: WebGLSync; end: number; age: number }> = [];
    /** 绑定照片缓冲并写入输入；每轮样本开始时也调用一次，换随机种子或网格位置。 */
    function begin() {
      film.begin(true);
      const round = Math.floor(done / tiles.length);
      exposure = prepare(view, {
        width,
        height,
        tier,
        jitter: grid
          ? [((round % grid) + 0.5) / grid - 0.5, (Math.floor(round / grid) + 0.5) / grid - 0.5]
          : [0, 0],
        bounces,
        objects,
        time,
        debug: 0,
        hierarchy: true,
        fragments: true,
        sun,
        fog,
        ocean,
      });
    }
    /** 把接下来的 batch 个小块提交给 GPU，末尾插一个栅栏。两次提交之间画布可能被显示用过，先重新绑定。 */
    function submit() {
      begin();
      gl.enable(gl.SCISSOR_TEST);
      for (const end = Math.min(done + batch, total); done < end; done++) {
        const tile = done % tiles.length;
        if (tile === 0 && done > 0) begin();
        gl.scissor(...tiles[tile], PHOTO_TILE, PHOTO_TILE);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      pending.push({
        sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!,
        end: done,
        age: 0,
      });
      gl.flush();
    }
    return {
      /** 收回已完成的批次，把队列补到两批。 */
      step() {
        for (const item of pending) item.age++;
        if (pending[0]?.age > 2) {
          batch = Math.max(1, batch >> 1);
          pending[0].age = -Infinity;
        }
        while (
          pending.length &&
          gl.getSyncParameter(pending[0].sync, gl.SYNC_STATUS) === gl.SIGNALED
        ) {
          const item = pending.shift()!;
          finished = item.end;
          gl.deleteSync(item.sync);
        }
        if (!pending.length && done > 0)
          batch = Math.min(batch * 2, tiles.length);
        while (pending.length < 2 && done < total) submit();
      },
      /** 每个像素已画完的样本数（整张画面都画完的轮数）。 */
      get samples() {
        return Math.floor(finished / tiles.length);
      },
      /** 预览档的网格样本是否已经取满；累积档永远为假。 */
      get complete() {
        return finished >= total;
      },
      /** 把当前累积结果显示到画布上；画布暂时改成照片尺寸，由页面样式缩放到窗口。
       * 第一轮画完之前还有没有样本的像素，画布保留原来的画面。 */
      present() {
        if (finished < tiles.length) return;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          resetTiming();
        }
        film.present({ exposure, raw: false });
      },
      /** 把累积结果做色调映射后读回，编码成 PNG。 */
      png() {
        const pixels = film.read({ exposure });
        const image = new ImageData(width, height),
          row = width * 4;
        // 帧缓冲的第一行在画面底部，PNG 的第一行在顶部。
        for (let y = 0; y < height; y++)
          image.data.set(
            pixels.subarray((height - 1 - y) * row, (height - y) * row),
            y * row,
          );
        const target = new OffscreenCanvas(width, height);
        target.getContext("2d")!.putImageData(image, 0, 0);
        return target.convertToBlob({ type: "image/png" });
      },
      dispose() {
        for (const item of pending) gl.deleteSync(item.sync);
        film.dispose();
      },
    };
  }
  // 拾取只需一个浮点像素，读回距离和几何法线；不占用或清空实时累积缓冲。
  const pickTexture = gl.createTexture(),
    pickFramebuffer = gl.createFramebuffer();
  gl.activeTexture(gl.TEXTURE17);
  gl.bindTexture(gl.TEXTURE_2D, pickTexture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    pickTexture,
    0,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  /** 拾取该像素主射线最先遇到的可见表面，坐标从画面左上角计数。
   * 返回整数方块坐标和几何法线；透明孔洞继续穿透，活动对象不参与地图选点。
   * 用已编译的最精细预览档求交，体素档只能给出整格的面。
   */
  function pick(
    camera: Camera,
    pixel: { width: number; height: number; x: number; y: number },
  ): { position: number[]; normal: number[] } | null {
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const viewport = gl.getParameter(gl.VIEWPORT);
    const blend = gl.isEnabled(gl.BLEND);
    prepare(camera, {
      ...pixel,
      tier: (["shading", "basic", "voxel"] as const).find((tier) => programs.has(tier)) ?? "accumulation",
      bounces: 0,
      time: 0,
      debug: 0,
      hierarchy: true,
      fragments: true,
      sun: [0, 1, 0],
      fog: Infinity,
      objects: false,
    });
    gl.uniform1i(u("uPicking"), 1);
    gl.uniform2f(
      u("uPickPixel"),
      Math.floor(pixel.x) + 0.5,
      pixel.height - Math.floor(pixel.y) - 0.5,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, result);
    gl.uniform1i(u("uPicking"), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    if (blend) gl.enable(gl.BLEND);
    if (result[0] < 0) return null;
    const normal = [...result.slice(1)],
      { origin: eye, direction } = cameraRay(camera, {
        ...pixel,
        x: Math.floor(pixel.x),
        y: Math.floor(pixel.y),
      });
    return {
      position: eye.map((v, i) =>
        Math.floor(v + direction[i] * result[0] - normal[i] * 0.002),
      ),
      normal,
    };
  }
  /** 视野里是否有足够大的动画对象；没有时静止画面不必逐帧重画。
   * 对象只按包围球与视锥比较，投影不足一个像素的忽略。
   */
  function animating(camera: Camera, { width, height }: { width: number; height: number }): boolean {
    if (objects.enabled === false) return false;
    const { forward, right, up } = basis(camera),
      dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      halfHeight = (camera.ortho ?? SPAN) / 2,
      halfWidth = (halfHeight * width) / height;
    return objects.references().some(({ bounds: [low, high] }) => {
      const center = low.map((v, i) => (v + high[i]) / 2 - camera.position[i]),
        radius = Math.hypot(...high.map((v, i) => v - low[i])) / 2,
        depth = dot(center, forward);
      if (depth < -radius) return false;
      const reach = camera.ortho !== undefined ? 1 : Math.max(depth, 0);
      if (
        (2 * radius * height) /
          (camera.ortho ?? Math.max(depth, radius) * SPAN) <
        1
      )
        return false;
      return (
        Math.abs(dot(center, right)) <= reach * halfWidth + 2 * radius &&
        Math.abs(dot(center, up)) <= reach * halfHeight + 2 * radius
      );
    });
  }
  return {
    gl,
    uniforms,
    /** 调试 uniform 时必须与当前射线程序配对，显示合成使用的是另一个程序。 */
    get program() {
      return program;
    },
    catalog,
    /** 方块哈希到模型的状态表，按哈希升序的 [hash, model] 对；数据源的调色板用它解释。 */
    states,
    /** 贴图与派生表在同一帧替换；宿主同时发布按新分类准备的区域。 */
    setTextures(set: TextureSet): void {
      gl.useProgram(program);
      textures.install(set);
      generation++;
      resetTiming();
    },
    animating,
    /** 已发布数据的版本；版本与相机都不变时，上一帧画面仍然有效。 */
    get version() {
      return `${generation}/${world?.version ?? 0}/${objects.version}`;
    },
    get objects() {
      return objects;
    },
    createWorld,
    draw,
    compile,
    /** 这一档是否已经编译好、可以绘制。 */
    ready(tier: Tier): boolean {
      return programs.has(tier);
    },
    /** 这一档是否正在编译。 */
    compiling(tier: Tier): boolean {
      return compiling.has(tier);
    },
    pick,
    photograph,
    resetTiming,
    clear() {
      world?.dispose();
      world = null;
      objects.clear();
      generation++;
      resetTiming();
    },
    /** 当前画面已累积的样本数；画面变化后归零。 */
    get accumulated() {
      return accumulator.samples;
    },
    get times() {
      return [...times];
    },
    get textureBytes() {
      return (
        textures.bytes +
        accumulator.bytes +
        (world?.textureBytes || 0) +
        objects.textureBytes
      );
    },
    pixels() {
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data,
      );
      return data;
    },
    dispose() {
      world?.dispose();
      objects.dispose();
      textures.dispose();
      accumulator.dispose();
      resetTiming();
      for (const { texture } of empty) gl.deleteTexture(texture);
      gl.deleteTexture(pickTexture);
      gl.deleteFramebuffer(pickFramebuffer);
      gl.deleteVertexArray(vao);
      for (const { program } of programs.values()) gl.deleteProgram(program);
    },
  };
}
