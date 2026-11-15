import { WorldGPU } from "./world-gpu.js";
import { ObjectStore } from "../objects/store.js";

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
    "uCells",
    "uTree",
    "uModels",
    "uParts",
    "uTriangles",
    "uTriangleIDs",
    "uFast",
    "uAtlas",
    "uMips",
    "uSize",
    "uCamera",
    "uRight",
    "uUp",
    "uForward",
    "uViewport",
    "uSpan",
    "uTop",
    "uDebug",
    "uHierarchy",
    "uFragments",
    "uWorld",
    "uWorldData",
    "uSections",
    "uSamples",
    "uDirectoryOffset",
    "uObjectData",
    "uObjectAtlas",
    "uObjectsEnabled",
  ])
    uniforms.set(name, gl.getUniformLocation(program, name));
  const [headerBuffer, fastBuffer, triangleBuffer, referenceBuffer, catalog] =
    await Promise.all(
      [
        "headers.bin",
        "fast.bin",
        "triangles.bin",
        "triangle-ids.bin",
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
    tableTexture(8, "uTriangleIDs", new Uint32Array(referenceBuffer), 1, true)
      .texture,
  );
  textures.push(tableTexture(2, "uModels", headers, 4, true).texture);
  textures.push(
    tableTexture(3, "uTriangles", new Float32Array(triangleBuffer), 4, false)
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
  await Promise.all([
    imageTexture(5, "uAtlas", assets + "atlas.png", false),
    imageTexture(6, "uMips", assets + "surfaces.png", true),
  ]);
  /** 层次只合并空气及相同完整立方体；复杂模型和附加裁片必须下钻到格子。
   * @param {number[]} size
   * @param {Uint32Array} cells
   */
  function makeHierarchy(size, cells, occupied) {
    const first = new Uint32Array(cells.length / 2);
    for (let i = 0; i < first.length; i++) {
      const id = cells[i * 2];
      first[i] =
        !occupied?.[i] &&
        cells[i * 2 + 1] === 0 &&
        (id === 0 || headers[id * 4] === 1)
          ? id
          : 0xffffffff;
    }
    const levels = [{ size: [...size], data: first }];
    while (size.some((v) => v > 1)) {
      const previous = levels.at(-1),
        next = size.map((v) => Math.max(1, v / 2)),
        data = new Uint32Array(next[0] * next[1] * next[2]);
      for (let z = 0; z < next[2]; z++)
        for (let y = 0; y < next[1]; y++)
          for (let x = 0; x < next[0]; x++) {
            let value =
              previous.data[x * 2 + size[0] * (y * 2 + size[1] * z * 2)];
            for (let dz = 0; dz < Math.min(2, size[2]); dz++)
              for (let dy = 0; dy < Math.min(2, size[1]); dy++)
                for (let dx = 0; dx < Math.min(2, size[0]); dx++) {
                  if (
                    previous.data[
                      x * 2 +
                        dx +
                        size[0] * (y * 2 + dy + size[1] * (z * 2 + dz))
                    ] !== value
                  )
                    value = 0xffffffff;
                }
            data[x + next[0] * (y + next[1] * z)] = value;
          }
      levels.push({ size: next, data });
      size = next;
    }
    return levels;
  }
  let objects = new ObjectStore(gl, uniforms),
    staticBytes = allocated;
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    queries = [],
    times = [];
  let world = null,
    gridTextures = [],
    origin = [0, 0, 0];
  function resetTiming() {
    for (const q of queries) gl.deleteQuery(q);
    queries.length = 0;
    times.length = 0;
  }
  // 所有采样器有独立纹理单元，即使当前模式没有访问它们。
  for (const [name, unit] of [
    ["uCells", 0],
    ["uParts", 7],
    ["uSections", 10],
    ["uWorldData", 11],
  ])
    gl.uniform1i(uniforms.get(name), unit);
  function setGrid(scene, cells, occupied) {
    world?.dispose();
    world = null;
    for (const texture of gridTextures) gl.deleteTexture(texture);
    gridTextures = [];
    origin = [0, 0, 0];
    allocated = staticBytes;
    const size = scene.grid.size,
      cellTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, cellTexture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RG32UI,
      ...size,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      cells,
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    allocated += cells.byteLength;
    const levels = makeHierarchy(size, cells, occupied),
      tree = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tree);
    gl.texStorage3D(gl.TEXTURE_3D, levels.length, gl.R32UI, ...size);
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        i,
        0,
        0,
        0,
        ...l.size,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        l.data,
      );
      allocated += l.data.byteLength;
    }
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_MIN_FILTER,
      gl.NEAREST_MIPMAP_NEAREST,
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(uniforms.get("uTree"), 1);
    const parts = tableTexture(
      7,
      "uParts",
      new Uint32Array(scene.grid.parts),
      1,
      true,
    );
    gridTextures = [cellTexture, tree, parts.texture];
    gl.uniform3fv(uniforms.get("uSize"), size);
    gl.uniform1i(uniforms.get("uTop"), levels.length - 1);
    gl.uniform1i(uniforms.get("uWorld"), 0);
    resetTiming();
  }
  function createWorld(options = {}) {
    objects.dispose();
    objects = new ObjectStore(gl, uniforms);
    world?.dispose();
    for (const texture of gridTextures) gl.deleteTexture(texture);
    gridTextures = [];
    allocated = staticBytes;
    world = new WorldGPU(gl, uniforms, options);
    gl.uniform1i(uniforms.get("uWorld"), 1);
    resetTiming();
    return world;
  }
  /** 只绘制当前已发布的数据；每帧上传的实例变换也计入 GPU 时间。
   * @param {{position:number[],yaw:number,pitch:number}} camera
   * @param {{width:number,height:number,samples?:number,time?:number,debug?:number,hierarchy?:boolean,fragments?:boolean,synchronize?:boolean}} options
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
    const { yaw, pitch } = camera;
    gl.uniform2f(uniforms.get("uViewport"), width, height);
    gl.uniform3fv(
      uniforms.get("uCamera"),
      camera.position.map((v, i) => v - origin[i]),
    );
    gl.uniform3fv(uniforms.get("uForward"), [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ]);
    gl.uniform3fv(uniforms.get("uRight"), [Math.cos(yaw), 0, Math.sin(yaw)]);
    gl.uniform3fv(uniforms.get("uUp"), [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      Math.cos(yaw) * Math.sin(pitch),
    ]);
    gl.uniform1f(uniforms.get("uSpan"), 2 * Math.tan((65 * Math.PI) / 360));
    gl.uniform1i(uniforms.get("uSamples"), samples);
    gl.uniform1i(uniforms.get("uDebug"), debug);
    gl.uniform1i(uniforms.get("uHierarchy"), Number(hierarchy));
    gl.uniform1i(uniforms.get("uFragments"), Number(fragments));
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
  return {
    gl,
    uniforms,
    catalog,
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
      for (const texture of gridTextures) gl.deleteTexture(texture);
      gridTextures = [];
      objects.clear();
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
      for (const texture of [...textures, ...gridTextures])
        gl.deleteTexture(texture);
      resetTiming();
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}
