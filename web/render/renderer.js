import { WorldGPU } from "./world-gpu.js";
import { ObjectStore } from "../objects/store.js";
import { prepareRegion } from "../scene/prepare.js";
import { gridRegions } from "../scene/grid.js";

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
    "uSamples",
    "uDirectoryOffset",
    "uObjectData",
    "uObjectAtlas",
    "uObjectsEnabled",
  ])
    uniforms.set(name, gl.getUniformLocation(program, name));
  const [
    headerBuffer,
    fastBuffer,
    recordBuffer,
    referenceBuffer,
    layerBuffer,
    catalog,
  ] = await Promise.all(
      [
        "headers.bin",
        "fast.bin",
        "quad-records.bin",
        "quad-references.bin",
        "surface-layers.bin",
        "catalog.json",
      ].map((name) =>
        fetch(assets + name).then((r) =>
          name.endsWith(".json") ? r.json() : r.arrayBuffer(),
        ),
      ),
    );
  const headers = new Uint32Array(headerBuffer);
  let allocated = 0;
  const textures = [];
  /** 上传共享表或片段编号表；表内索引均以纹素为单位。
   * @param {number} unit
   * @param {string} name
   * @param {Uint32Array | Float32Array} input
   * @param {number} components
   * @param {boolean} integer
   */
  function tableTexture(unit, name, input, components, integer, width = 2048) {
    const height = Math.max(1, Math.ceil(input.length / components / width));
    const data = integer
      ? new Uint32Array(width * height * components)
      : new Float32Array(width * height * components);
    data.set(input);
    const texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const format = integer
      ? components === 1
        ? gl.RED_INTEGER
        : gl.RGBA_INTEGER
      : gl.RGBA;
    const internal = integer
      ? components === 1
        ? gl.R32UI
        : gl.RGBA32UI
      : gl.RGBA32F;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internal,
      width,
      height,
      0,
      format,
      integer ? gl.UNSIGNED_INT : gl.FLOAT,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(uniforms.get(name), unit);
    allocated += data.byteLength;
    return { texture, bytes: data.byteLength };
  }
  textures.push(
    tableTexture(
      8,
      "uQuadReferences",
      new Uint32Array(referenceBuffer),
      4,
      true,
    ).texture,
  );
  textures.push(tableTexture(2, "uModels", headers, 4, true).texture);
  textures.push(
    tableTexture(3, "uQuadRecords", new Float32Array(recordBuffer), 4, false)
      .texture,
  );
  textures.push(
    tableTexture(4, "uFast", new Float32Array(fastBuffer), 4, false).texture,
  );
  /** @param {number} unit @param {string} name @param {string} url @param {boolean} linear */
  async function imageTexture(unit, name, url, linear) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const texture = gl.createTexture();
    textures.push(texture);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      linear ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      linear ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.get(name), unit);
    allocated += image.width * image.height * 4;
  }
  /** 完整方块的面贴图：16×16 纹理数组，带预先生成的 mip，按线性预乘 alpha 存放。
   * 着色器由射线微分算出 mip 级，并沿斜看方向多点采样。
   * @param {number} unit @param {ArrayBuffer} buffer @param {number} layers
   */
  function surfaceTexture(unit, buffer, layers) {
    const data = new Uint8Array(buffer),
      levels = 5,
      texture = gl.createTexture();
    textures.push(texture);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.SRGB8_ALPHA8, 16, 16, layers);
    let offset = 0;
    for (let level = 0; level < levels; level++) {
      const size = 16 >> level,
        length = size * size * 4 * layers;
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        level,
        0,
        0,
        0,
        size,
        size,
        layers,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        data.subarray(offset, offset + length),
      );
      offset += length;
    }
    // 级内最近点保持像素硬边，级间线性混合；斜看方向的多点采样由着色器完成。
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.uniform1i(uniforms.get("uSurfaces"), unit);
    allocated += data.byteLength;
  }
  surfaceTexture(6, layerBuffer, catalog.statistics.surfaceLayers);
  await imageTexture(5, "uAtlas", assets + "atlas.png", false);
  let objects = new ObjectStore(gl, uniforms),
    staticBytes = allocated;
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
    allocated = staticBytes;
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
    allocated = staticBytes;
    world = new WorldGPU(gl, uniforms, options);
    generation++;
    resetTiming();
    return world;
  }
  /** 只绘制当前已发布的数据；每帧上传的实例变换也计入 GPU 时间。
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number,samples?:number,time?:number,debug?:number,hierarchy?:boolean,fragments?:boolean,shadows?:boolean,sun?:number[],synchronize?:boolean}} options
   */
  function draw(
    camera,
    {
      width,
      height,
      samples = 1,
      time = 0,
      debug = 0,
      hierarchy = true,
      fragments = true,
      shadows = true,
      sun = [0.45, 0.62, 0.3],
      synchronize = false,
    },
  ) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      resetTiming();
    }
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
    gl.uniform1i(uniforms.get("uSamples"), samples);
    gl.uniform1i(uniforms.get("uDebug"), debug);
    gl.uniform1i(uniforms.get("uHierarchy"), Number(hierarchy));
    gl.uniform1i(uniforms.get("uFragments"), Number(fragments));
    gl.uniform1i(uniforms.get("uShadows"), Number(shadows));
    const length = Math.hypot(...sun);
    gl.uniform3fv(
      uniforms.get("uSun"),
      sun.map((v) => v / length),
    );
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
    if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    gl.uniform1i(
      uniforms.get("uObjectsEnabled"),
      objects.enabled === false ? 0 : 1,
    );
    objects.update(time, origin);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (q) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queries.push(q);
    }
    if (synchronize)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
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
    resetTiming,
    clear() {
      world?.dispose();
      world = null;
      objects.clear();
      generation++;
      allocated = staticBytes;
      resetTiming();
    },
    get times() {
      return [...times];
    },
    get textureBytes() {
      return allocated + (world?.textureBytes || 0) + objects.textureBytes;
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
      for (const texture of textures) gl.deleteTexture(texture);
      resetTiming();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
