import { createTextures } from "./textures.js";
import { createAccumulator } from "./accumulator.js";
import { WorldGPU } from "./world-gpu.js";
import { ObjectStore } from "../objects/store.js";
import { prepareRegion } from "../scene/prepare.js";
import { gridRegions } from "../scene/grid.js";

// 水体按距离吸收光线，着色器需要知道哪个介质组是水。
const WATER = 'minecraft:water ["level"="0"]';
// 拍照时每次绘制覆盖的方块边长（像素）。
const PHOTO_TILE = 256;
import {
  cameraBasis as basis,
  cameraRay,
  PERSPECTIVE_SPAN as SPAN,
} from "./camera.js";
/** 创建射线绘制器；宿主负责相机、帧循环和数据来源，绘制器不读取 UI。
 * @param {HTMLCanvasElement} canvas
 * @param {{assets?:string}} options
 */
export async function createRenderer(canvas, { assets = "/r2/assets/", onProgress } = {}) {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw Error("需要支持 WebGL 2 的浏览器");
  const [fragmentSource, objectSource] = await Promise.all(
    ["ray.frag", "objects.frag"].map((name) =>
      fetch(new URL(name, import.meta.url)).then((r) => r.text()),
    ),
  );
  const fragment = fragmentSource.replace("#include <objects>", objectSource);
  const vertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
  /** 预览与累积各自编译，让预览去掉累积反弹路径；两者共享纹理和世界数据。
   * @param {0|1} pass
   */
  async function createRayProgram(pass) {
    const program = gl.createProgram();
    const shaders = [];
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [
        gl.FRAGMENT_SHADER,
        fragment.replace(
          "#version 300 es",
          `#version 300 es\n#define RENDER_PASS ${pass}`,
        ),
      ],
    ]) {
      const shader = gl.createShader(type);
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
      throw Error(`射线程序 ${pass} 编译失败：${errors || "浏览器未提供编译日志"}`);
    }
    return program;
  }
  // 两个程序逐个编译并报告进度：Windows 的 D3D 后端编一个大射线程序可能要几十秒，
  // 让人对着空白页面等是最糟的体验。宿主把进度显示在页面顶部那行提示里。
  const modules = ["预览射线程序", "累积射线程序"];
  const programs = [];
  for (const [index, label] of modules.entries()) {
    onProgress?.({ index: index + 1, total: modules.length, label });
    programs.push(await createRayProgram(index));
  }
  let program = programs[1];
  gl.useProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const uniforms = new Map();
  for (const name of [
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
    "uShadows",
    "uSun",
    "uWorldData",
    "uSections",
    "uFrame",
    "uWaterGroup",
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
  ])
    uniforms.set(name, gl.getUniformLocation(program, name));
  const textures = await createTextures(gl, uniforms, assets),
    catalog = textures.catalog;
  // 即使只画天空，WebGL 仍验证所有采样器；用最小的空纹理满足整数采样器绑定。
  const empty = [
    [1, gl.TEXTURE_3D, "uTree"],
    [10, gl.TEXTURE_3D, "uSections"],
    [11, gl.TEXTURE_2D, "uWorldData"],
  ].map(([unit, target, name]) => {
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
  const locations = programs.map(
    (program) =>
      new Map(
        [...uniforms.keys()].map((name) => [
          name,
          gl.getUniformLocation(program, name),
        ]),
      ),
  );
  // 累积程序使用完整材质；预览沿用资源仓库分配的纹理单元，不另维护一份编号表。
  const samplerTypes = [
    gl.SAMPLER_2D,
    gl.SAMPLER_2D_ARRAY,
    gl.UNSIGNED_INT_SAMPLER_2D,
    gl.UNSIGNED_INT_SAMPLER_3D,
  ];
  gl.useProgram(programs[0]);
  for (
    let i = 0;
    i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    i++
  ) {
    const { name, type } = gl.getActiveUniform(program, i);
    if (samplerTypes.includes(type)) {
      gl.uniform1i(
        locations[0].get(name),
        gl.getUniform(program, uniforms.get(name)),
      );
    }
  }
  gl.useProgram(program);
  const accumulator = createAccumulator(gl, vertex);
  // 累积样本的随机种子；每帧不同，样本之间才互不相关。
  let frame = 0;
  // 一个累积序列固定水面时刻，否则样本会把移动波纹平均成模糊镜面。
  let waterTime = 0;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    queries = [],
    times = [];
  let world = null,
    origin = [0, 0, 0],
    // 世界或对象仓库被整体替换时加一，与它们各自的版本一起组成场景版本。
    generation = 0;
  function resetTiming() {
    for (const q of queries) gl.deleteQuery(q);
    queries.length = 0;
    times.length = 0;
  }
  // 准备器需要知道片段最远伸出多少格，才能收集相邻来源。
  const preparation = {
    ...catalog,
    fragmentReach: Math.max(
      0,
      ...catalog.models.flatMap((m) =>
        (m.fragments || []).flatMap((p) => p.offset.map(Math.abs)),
      ),
    ),
  };
  /** 验证页的固定场景：转换为来源区域后与存档走同一路径，已登记的特殊对象一并准备。
   * @param {{grid:{size:number[]}}} scene
   * @param {Uint32Array} cells
   */
  function setGrid(scene, cells) {
    gl.useProgram(program);
    world?.dispose();
    const size = scene.grid.size,
      align = (v) => Math.ceil(v / 128) * 128;
    world = new WorldGPU(gl, uniforms, { capacityWords: 4 * 1024 * 1024 });
    generation++;
    world.setWindow([0, -64, 0], [align(size[0]), 512, align(size[2])]);
    const regions = gridRegions(size, cells),
      references = objects.references();
    for (const key of regions.keys()) {
      const [x, z] = key.split("/").map(Number);
      world.install(
        prepareRegion({
          x,
          z,
          regions,
          catalog: preparation,
          objects: references,
        }),
      );
    }
    resetTiming();
  }
  function createWorld(options = {}) {
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
   * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
   * @param {{width:number,height:number,pass:number,bounces:number,time:number,waterTime?:number,debug:number,hierarchy:boolean,fragments:boolean,shadows:boolean,sun:number[],fog:number,ocean?:number,objects?:boolean}} options
   */
  function prepare(
    camera,
    {
      width,
      height,
      pass,
      bounces,
      time,
      waterTime = time,
      debug,
      hierarchy,
      fragments,
      shadows,
      sun,
      fog,
      ocean,
      objects: drawObjects = true,
    },
  ) {
    if (program !== programs[pass]) {
      program = programs[pass];
      for (const [name, location] of locations[pass])
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
        gl.uniform1i(uniforms.get(name), unit);
      }
    }
    gl.uniform1i(uniforms.get("uHasWorld"), Number(world !== null));
    gl.uniform1i(uniforms.get("uPicking"), 0);
    gl.uniform1i(uniforms.get("uOrtho"), Number(camera.ortho !== undefined));
    const { forward, right, up } = basis(camera);
    gl.uniform2f(uniforms.get("uViewport"), width, height);
    gl.uniform3fv(
      uniforms.get("uCamera"),
      camera.position.map((v, i) => v - origin[i]),
    );
    gl.uniform3fv(uniforms.get("uForward"), forward);
    gl.uniform3fv(uniforms.get("uRight"), right);
    gl.uniform3fv(uniforms.get("uUp"), up);
    gl.uniform1f(uniforms.get("uSpan"), camera.ortho ?? SPAN);
    gl.uniform1ui(uniforms.get("uFrame"), frame++);
    gl.uniform1ui(
      uniforms.get("uWaterGroup"),
      catalog.models[catalog.states[WATER]].group,
    );
    gl.uniform1f(uniforms.get("uFog"), fog);
    gl.uniform1f(uniforms.get("uTime"), waterTime);
    gl.uniform1i(uniforms.get("uOcean"), Number(ocean !== undefined));
    gl.uniform1f(uniforms.get("uOceanHeight"), (ocean ?? 0) - origin[1]);
    gl.uniform3fv(uniforms.get("uWorldOrigin"), origin);
    gl.uniform1i(uniforms.get("uBounces"), bounces);
    gl.uniform1i(uniforms.get("uDebug"), debug);
    gl.uniform1i(uniforms.get("uHierarchy"), Number(hierarchy));
    gl.uniform1i(uniforms.get("uFragments"), Number(fragments));
    gl.uniform1i(uniforms.get("uShadows"), Number(shadows));
    const length = Math.hypot(...sun);
    gl.uniform3fv(
      uniforms.get("uSun"),
      sun.map((v) => v / length),
    );
    gl.uniform1i(
      uniforms.get("uObjectsEnabled"),
      !drawObjects || objects.enabled === false ? 0 : 1,
    );
    objects.update(time, origin);
    const night = 1 - Math.min(1, Math.max(0, (sun[1] / length + 0.1) / 0.3));
    return 0.9 * (1 + 2.3 * night);
  }
  /** 只绘制当前已发布的数据；每帧上传的实例变换也计入 GPU 时间。
   * accumulate 为真表示相机、设置与场景都和上一帧相同：这一帧作为累积样本加到画面上，
   * 带抗锯齿、软阴影和一次漫反射反弹；为假时重新出一帧干净的预览。
   * ocean 指定无限海面的世界高度；省略时只绘制场景里的体素水。
   * sun 是指向太阳的方向，太阳在地平线下时由月亮照明；fog 是远景雾接近不透明的距离，默认为观察窗口半径。
   * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
   * @param {{width:number,height:number,accumulate?:boolean,time?:number,debug?:number,hierarchy?:boolean,fragments?:boolean,shadows?:boolean,sun?:number[],fog?:number,ocean?:number,objects?:boolean,synchronize?:boolean}} options
   */
  function draw(
    camera,
    {
      width,
      height,
      accumulate = false,
      time = 0,
      debug = 0,
      hierarchy = true,
      fragments = true,
      shadows = true,
      sun = [0.45, 0.62, 0.3],
      fog = world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9,
      ocean,
      objects = true,
      synchronize = false,
    },
  ) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      resetTiming();
    }
    accumulator.resize(width, height);
    if (!accumulate) waterTime = time;
    const exposure = prepare(camera, {
      width,
      height,
      objects,
      pass: accumulator.begin(accumulate),
      bounces: 1,
      time,
      waterTime,
      debug,
      hierarchy,
      fragments,
      shadows,
      sun,
      fog,
      ocean,
    });
    if (timer && gl.getParameter(timer.GPU_DISJOINT_EXT)) resetTiming();
    while (
      queries.length &&
      gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = queries.shift();
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
  }
  /** 离屏渲染一张高质量照片：每个像素累积 samples 个样本，光线最多反弹 bounces 次。
   * 一个样本要跑很久，整张画面一次画完可能触发 Windows 的显卡超时重置，
   * 所以画面切成小块分批提交。GPU 上始终排着两批，一批画完时下一批已经在等，不必空等下一帧；
   * 批量按完成速度调整：每帧都把队列画空就加倍，一批拖过两帧就减半。
   * 宿主在每个动画帧调用 step()，期间暂停交互绘制；完成后用 png() 取图，再 dispose()。
   * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
   * @param {{width:number,height:number,samples:number,bounces?:number,time?:number,shadows?:boolean,sun?:number[],fog?:number,ocean?:number,objects?:boolean}} options
   */
  function photograph(
    camera,
    {
      width,
      height,
      samples,
      objects = true,
      bounces = 4,
      time = 0,
      shadows = true,
      sun = [0.45, 0.62, 0.3],
      fog = world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9,
      ocean,
    },
  ) {
    const film = createAccumulator(gl, vertex),
      tiles = [];
    film.resize(width, height);
    film.clear();
    for (let y = 0; y < height; y += PHOTO_TILE)
      for (let x = 0; x < width; x += PHOTO_TILE) tiles.push([x, y]);
    const total = samples * tiles.length,
      view = { ...camera, position: [...camera.position] };
    let done = 0,
      batch = 1,
      exposure = 1;
    // 已提交、尚未完成的批次；age 是提交后经过的 step 次数。
    /** @type {{sync:WebGLSync,age:number}[]} */
    const pending = [];
    /** 把接下来的 batch 个小块提交给 GPU，末尾插一个栅栏。 */
    function submit() {
      gl.enable(gl.SCISSOR_TEST);
      for (const end = Math.min(total, done + batch); done < end; done++) {
        const tile = done % tiles.length;
        // 每轮样本开始时换一次随机种子，同一轮的各个小块共用相机和光照。
        if (tile === 0)
          exposure = prepare(view, {
            width,
            height,
            pass: film.begin(true),
            bounces,
            objects,
            time,
            debug: 0,
            hierarchy: true,
            fragments: true,
            shadows,
            sun,
            fog,
            ocean,
          });
        gl.scissor(...tiles[tile], PHOTO_TILE, PHOTO_TILE);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      pending.push({
        sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0),
        age: 0,
      });
      gl.flush();
    }
    return {
      /** 收回已完成的批次，把队列补到两批。返回是否已全部画完。 */
      step() {
        for (const item of pending) item.age++;
        if (pending[0]?.age > 2) {
          batch = Math.max(1, batch >> 1);
          pending[0].age = -Infinity;
        }
        while (
          pending.length &&
          gl.getSyncParameter(pending[0].sync, gl.SYNC_STATUS) === gl.SIGNALED
        )
          gl.deleteSync(pending.shift().sync);
        if (done === total) return pending.length === 0;
        if (!pending.length && done > 0)
          batch = Math.min(batch * 2, tiles.length);
        while (pending.length < 2 && done < total) submit();
        return false;
      },
      /** 已完成的比例，0 到 1。 */
      get progress() {
        return done / total;
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
        target.getContext("2d").putImageData(image, 0, 0);
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
   * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
   * @param {{width:number,height:number,x:number,y:number}} pixel
   * @returns {{position:number[],normal:number[]}|null}
   */
  function pick(camera, pixel) {
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const viewport = gl.getParameter(gl.VIEWPORT);
    const blend = gl.isEnabled(gl.BLEND);
    prepare(camera, {
      ...pixel,
      pass: 0,
      bounces: 0,
      time: 0,
      debug: 0,
      hierarchy: true,
      fragments: true,
      shadows: false,
      sun: [0, 1, 0],
      fog: Infinity,
      objects: false,
    });
    gl.uniform1i(uniforms.get("uPicking"), 1);
    gl.uniform2f(
      uniforms.get("uPickPixel"),
      Math.floor(pixel.x) + 0.5,
      pixel.height - Math.floor(pixel.y) - 0.5,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFramebuffer);
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, result);
    gl.uniform1i(uniforms.get("uPicking"), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(...viewport);
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
   * @param {{position:number[],yaw:number,pitch:number,ortho?:number}} camera
   * @param {{width:number,height:number}} size
   */
  function animating(camera, { width, height }) {
    if (objects.enabled === false) return false;
    const { forward, right, up } = basis(camera),
      dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
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
    /** 贴图与派生表在同一帧替换；宿主同时发布按新分类准备的区域。
     * @param {import("./textures.js").TextureSet} set
     */
    setTextures(set) {
      gl.useProgram(program);
      textures.install(set);
      preparation.models = catalog.models;
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
    setGrid,
    draw,
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
      for (const program of programs) gl.deleteProgram(program);
    },
  };
}
