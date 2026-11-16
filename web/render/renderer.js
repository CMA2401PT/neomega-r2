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
// 垂直视场 65° 时，距离 1 处画面的高度。
const SPAN = 2 * Math.tan((65 * Math.PI) / 360);
/** 相机朝向的三条轴；绘制与可见性判断共用。
 * @param {{yaw:number,pitch:number}} camera
 */
function basis({ yaw, pitch }) {
  return {
    forward: [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ],
    right: [Math.cos(yaw), 0, Math.sin(yaw)],
    up: [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      Math.cos(yaw) * Math.sin(pitch),
    ],
  };
}

/** 创建射线绘制器；宿主负责相机、帧循环和数据来源，绘制器不读取 UI。
 * @param {HTMLCanvasElement} canvas
 * @param {{assets?:string}} options
 */
export async function createRenderer(canvas, { assets = "/r2/assets/" } = {}) {
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
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw Error(gl.getProgramInfoLog(program));
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
    "uDebug",
    "uHierarchy",
    "uFragments",
    "uShadows",
    "uSun",
    "uWorldData",
    "uSections",
    "uPass",
    "uFrame",
    "uWaterGroup",
    "uFog",
    "uTime",
    "uBounces",
    "uDirectoryOffset",
    "uObjectData",
    "uObjectAtlas",
    "uObjectsEnabled",
  ])
    uniforms.set(name, gl.getUniformLocation(program, name));
  const textures = await createTextures(gl, uniforms, assets),
    catalog = textures.catalog;
  let objects = new ObjectStore(gl, uniforms);
  const accumulator = createAccumulator(gl, vertex);
  // 累积样本的随机种子；每帧不同，样本之间才互不相关。
  let frame = 0;
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
        prepareRegion({ x, z, regions, catalog: preparation, objects: references }),
      );
    }
    resetTiming();
  }
  function createWorld(options = {}) {
    objects.dispose();
    objects = new ObjectStore(gl, uniforms);
    world?.dispose();
    world = new WorldGPU(gl, uniforms, options);
    generation++;
    resetTiming();
    return world;
  }
  /** 绑定射线程序并写入一帧的全部输入，预览、累积和拍照共用；返回这一帧的曝光。
   * 夜里只有月光，曝光随太阳落下逐渐提高，画面不至于全黑。
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number,pass:number,bounces:number,time:number,debug:number,hierarchy:boolean,fragments:boolean,shadows:boolean,sun:number[],fog:number}} options
   */
  function prepare(
    camera,
    {
      width,
      height,
      pass,
      bounces,
      time,
      debug,
      hierarchy,
      fragments,
      shadows,
      sun,
      fog,
    },
  ) {
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.viewport(0, 0, width, height);
    if (world) {
      origin = world.origin;
      world.bind();
    }
    const { forward, right, up } = basis(camera);
    gl.uniform2f(uniforms.get("uViewport"), width, height);
    gl.uniform3fv(
      uniforms.get("uCamera"),
      camera.position.map((v, i) => v - origin[i]),
    );
    gl.uniform3fv(uniforms.get("uForward"), forward);
    gl.uniform3fv(uniforms.get("uRight"), right);
    gl.uniform3fv(uniforms.get("uUp"), up);
    gl.uniform1f(uniforms.get("uSpan"), SPAN);
    gl.uniform1i(uniforms.get("uPass"), pass);
    gl.uniform1ui(uniforms.get("uFrame"), frame++);
    gl.uniform1ui(
      uniforms.get("uWaterGroup"),
      catalog.models[catalog.states[WATER]].group,
    );
    gl.uniform1f(uniforms.get("uFog"), fog);
    gl.uniform1f(uniforms.get("uTime"), time);
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
      objects.enabled === false ? 0 : 1,
    );
    objects.update(time, origin);
    const night = 1 - Math.min(1, Math.max(0, (sun[1] / length + 0.1) / 0.3));
    return 0.9 * (1 + 4 * night);
  }
  /** 只绘制当前已发布的数据；每帧上传的实例变换也计入 GPU 时间。
   * accumulate 为真表示相机、设置与场景都和上一帧相同：这一帧作为累积样本加到画面上，
   * 带抗锯齿、软阴影和一次漫反射反弹；为假时重新出一帧干净的预览。
   * sun 是指向太阳的方向，太阳在地平线下时由月亮照明；fog 是远景雾接近不透明的距离，默认为观察窗口半径。
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number,accumulate?:boolean,time?:number,debug?:number,hierarchy?:boolean,fragments?:boolean,shadows?:boolean,sun?:number[],fog?:number,synchronize?:boolean}} options
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
      synchronize = false,
    },
  ) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      resetTiming();
    }
    accumulator.resize(width, height);
    const exposure = prepare(camera, {
      width,
      height,
      pass: accumulator.begin(accumulate),
      bounces: 1,
      time,
      debug,
      hierarchy,
      fragments,
      shadows,
      sun,
      fog,
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
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number,samples:number,bounces?:number,time?:number,shadows?:boolean,sun?:number[],fog?:number}} options
   */
  function photograph(
    camera,
    {
      width,
      height,
      samples,
      bounces = 4,
      time = 0,
      shadows = true,
      sun = [0.45, 0.62, 0.3],
      fog = world ? Math.min(world.size[0], world.size[2]) / 2 : 1e9,
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
            time,
            debug: 0,
            hierarchy: true,
            fragments: true,
            shadows,
            sun,
            fog,
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
  /** 视野里是否有足够大的动画对象；没有时静止画面不必逐帧重画。
   * 对象只按包围球与视锥比较，投影不足一个像素的忽略。
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number}} size
   */
  function animating(camera, { width, height }) {
    if (objects.enabled === false) return false;
    const { forward, right, up } = basis(camera),
      dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      halfHeight = SPAN / 2,
      halfWidth = (halfHeight * width) / height;
    return objects.references().some(({ bounds: [low, high] }) => {
      const center = low.map((v, i) => (v + high[i]) / 2 - camera.position[i]),
        radius = Math.hypot(...high.map((v, i) => v - low[i])) / 2,
        depth = dot(center, forward);
      if (depth < -radius) return false;
      if (depth > radius && (2 * radius * height) / (depth * SPAN) < 1)
        return false;
      const reach = Math.max(depth, 0);
      return (
        Math.abs(dot(center, right)) <= reach * halfWidth + 2 * radius &&
        Math.abs(dot(center, up)) <= reach * halfHeight + 2 * radius
      );
    });
  }
  return {
    gl,
    uniforms,
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
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
