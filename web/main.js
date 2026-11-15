// 页面直接使用 WebGL 2；没有 three.js，也不导入旧 viewer 的绘制或区块处理模块。
const canvas = /** @type {HTMLCanvasElement} */ (
  document.querySelector("#view")
);
const gl = canvas.getContext("webgl2", {
  antialias: false,
  preserveDrawingBuffer: true,
});
if (!gl) throw Error("需要 WebGL 2");
const params = new URLSearchParams(location.search);
const status = document.querySelector("#status");
const sceneSelect = /** @type {HTMLSelectElement} */ (
  document.querySelector("#scene")
);
sceneSelect.value = params.get("scene") || "showcase";
const vertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
let fragment = await (await fetch("/ray.frag")).text();
const specialMode = params.get("scene") === "special";
let special;
if (params.has("flat")) fragment = fragment.replace("if(c.y==0.0)", "if(true)");
if (specialMode) {
  const source = await (await fetch("/special.frag")).text();
  fragment = fragment
    .replace("float leaveNode(", source + "\nfloat leaveNode(")
    .replace(
      "  if(hit.alpha>0.0)",
      "  intersectDynamic(cell,max(t,afterHit),end,hit);\n  if(hit.alpha>0.0)",
    );
}
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
gl.bindVertexArray(gl.createVertexArray());
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
  "uDynamicEnabled",
  "uDynamicCells",
  "uDynamic",
  "uBook",
  "uBanner",
  "uFragments",
  "uWorld",
  "uWorldData",
  "uSections",
  "uSamples",
])
  uniforms.set(name, gl.getUniformLocation(program, name));
const started = performance.now();
const [headerBuffer, fastBuffer, triangleBuffer, referenceBuffer, statistics] =
  await Promise.all([
    fetch("/assets/headers.bin").then((r) => r.arrayBuffer()),
    fetch("/assets/fast.bin").then((r) => r.arrayBuffer()),
    fetch("/assets/triangles.bin").then((r) => r.arrayBuffer()),
    fetch("/assets/triangle-ids.bin").then((r) => r.arrayBuffer()),
    fetch("/api/models").then((r) => r.json()),
  ]);
const headers = new Uint32Array(headerBuffer);
let allocated = 0;
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
tableTexture(8, "uTriangleIDs", new Uint32Array(referenceBuffer), 1, true);
tableTexture(2, "uModels", headers, 4, true);
tableTexture(3, "uTriangles", new Float32Array(triangleBuffer), 4, false);
tableTexture(4, "uFast", new Float32Array(fastBuffer), 4, false);
/** @param {number} unit @param {string} name @param {string} url @param {boolean} linear */
async function imageTexture(unit, name, url, linear) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const texture = gl.createTexture();
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
  imageTexture(5, "uAtlas", "/assets/atlas.png", false),
  imageTexture(6, "uMips", "/assets/surfaces.png", true),
]);
const staticBytes = allocated,
  assetMS = performance.now() - started;
let scene,
  cells,
  cellTexture,
  treeTexture,
  partTable,
  position = [0, 0, 0],
  yaw = 0,
  pitch = 0;
let running = true;
const frameTimes = [],
  completedTimes = [];
const times = [],
  queries = [];
const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
function resetTiming() {
  for (const q of queries) gl.deleteQuery(q);
  queries.length = 0;
  times.length = 0;
  frameTimes.length = 0;
  completedTimes.length = 0;
}
/** 层次只合并空气及相同完整立方体；复杂模型和附加裁片必须下钻到格子。
 * @param {number[]} size
 * @param {Uint32Array} cells
 */
function makeHierarchy(size, cells) {
  const first = new Uint32Array(cells.length / 2);
  for (let i = 0; i < first.length; i++) {
    const id = cells[i * 2];
    first[i] =
      !special?.cells[i] &&
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
                    x * 2 + dx + size[0] * (y * 2 + dy + size[1] * (z * 2 + dz))
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
/** @param {string} name */
async function loadScene(name) {
  if (name === "special" && !specialMode) {
    location.search = "?scene=special";
    return;
  }
  if (specialMode && name !== "special") {
    location.search = "?scene=" + name;
    return;
  }
  if (name === "world") return loadWorld();
  gl.uniform1i(uniforms.get("uWorld"), 0);
  running = false;
  resetTiming();
  const start = performance.now();
  [scene, cells] = await Promise.all([
    fetch("/api/scene?name=" + name).then((r) => r.json()),
    fetch("/api/cells?name=" + name)
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint32Array(b)),
  ]);
  if (cellTexture) gl.deleteTexture(cellTexture);
  if (treeTexture) gl.deleteTexture(treeTexture);
  if (partTable) gl.deleteTexture(partTable.texture);
  allocated = staticBytes;
  const size = scene.grid.size;
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
  gl.uniform1i(uniforms.get("uCells"), 0);
  allocated += cells.byteLength;
  if (specialMode) {
    const { createSpecial } = await import("/special.js");
    special?.dispose();
    special = createSpecial(gl, uniforms, size, imageTexture);
    allocated += special.bytes;
  }
  const levels = makeHierarchy(size, cells);
  treeTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, treeTexture);
  gl.texStorage3D(gl.TEXTURE_3D, levels.length, gl.R32UI, ...size);
  levels.forEach((level, i) => {
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      i,
      0,
      0,
      0,
      ...level.size,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      level.data,
    );
    allocated += level.data.byteLength;
  });
  gl.texParameteri(
    gl.TEXTURE_3D,
    gl.TEXTURE_MIN_FILTER,
    gl.NEAREST_MIPMAP_NEAREST,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uTree"), 1);
  partTable = tableTexture(
    7,
    "uParts",
    new Uint32Array(scene.grid.parts),
    1,
    true,
  );
  gl.uniform3fv(uniforms.get("uSize"), size);
  gl.uniform1i(uniforms.get("uTop"), levels.length - 1);
  position = [...scene.camera];
  const d = scene.target.map((v, i) => v - position[i]),
    length = Math.hypot(...d);
  yaw = Math.atan2(d[0], -d[2]);
  pitch = Math.asin(d[1] / length);
  scene.uploadMS = performance.now() - start;
  running = true;
}
let worldInfoTexture, worldDataTable;
// 独立后台线程准备当前观察窗口；近景按原 viewer 的圆形半径和竖直范围选取。
/** @param {number[]} center 世界坐标中的窗口中心。 */
async function loadWorld(center = [1280, 271, 1280]) {
  running = false;
  resetTiming();
  const start = performance.now();
  const worker = new Worker("/world-worker.js", { type: "module" });
  const data = await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.error) {
        worker.terminate();
        reject(Error(data.error));
      } else if (data.ready) {
        worker.terminate();
        resolve(data);
      } else
        status.textContent = `新天堂：${data.progress.regions}/144 个远景区域\n传输 ${(data.progress.bytes / 1024 ** 2).toFixed(1)} MiB · 近景 ${data.progress.nearSections} / 远景 ${data.progress.farSections} 个非空 section`;
    };
    worker.onerror = reject;
    worker.postMessage({ center, farOnly: params.has("farOnly") });
  });
  const upload = performance.now();
  if (treeTexture) gl.deleteTexture(treeTexture);
  if (cellTexture) gl.deleteTexture(cellTexture);
  if (partTable) gl.deleteTexture(partTable.texture);
  if (worldInfoTexture) gl.deleteTexture(worldInfoTexture);
  if (worldDataTable) gl.deleteTexture(worldDataTable.texture);
  allocated = staticBytes;
  worldInfoTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE10);
  gl.bindTexture(gl.TEXTURE_3D, worldInfoTexture);
  gl.texImage3D(
    gl.TEXTURE_3D,
    0,
    gl.RGBA32UI,
    128,
    32,
    128,
    0,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    data.info,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uSections"), 10);
  allocated += data.info.byteLength;
  worldDataTable = tableTexture(11, "uWorldData", data.words, 1, true, 4096);
  treeTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, treeTexture);
  gl.texStorage3D(gl.TEXTURE_3D, data.levels.length, gl.R32UI, 128, 32, 128);
  for (let i = 0; i < data.levels.length; i++) {
    const level = data.levels[i];
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      i,
      0,
      0,
      0,
      ...level.size,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      level.data,
    );
    allocated += level.data.byteLength;
  }
  gl.texParameteri(
    gl.TEXTURE_3D,
    gl.TEXTURE_MIN_FILTER,
    gl.NEAREST_MIPMAP_NEAREST,
  );
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uTree"), 1);
  gl.uniform1i(uniforms.get("uWorld"), 1);
  gl.uniform3fv(uniforms.get("uSize"), [1536, 512, 1536]);
  data.stats.uploadMS = performance.now() - upload;
  data.stats.wallMS = performance.now() - start;
  scene = {
    world: true,
    origin: data.origin,
    stats: data.stats,
    nonAir: 0,
    fragmentReferences: data.stats.fragmentReferences,
    buildMS: data.stats.serverMS,
    uploadMS: data.stats.uploadMS,
  };
  position = center.map((v, i) => v - data.origin[i]);
  yaw = -0.7;
  pitch = -0.32;
  running = true;
  last = performance.now();
}
// 未使用的采样器也指定独立纹理单元，保证静态与世界模式共享同一个程序。
gl.uniform1i(uniforms.get("uSections"), 10);
gl.uniform1i(uniforms.get("uWorldData"), 11);
gl.uniform1i(uniforms.get("uCells"), 0);
gl.uniform1i(uniforms.get("uParts"), 7);
document.querySelector("#recenter").onclick = () =>
  loadWorld(position.map((v, i) => v + (scene.origin?.[i] || 0)));
document
  .querySelector("#viewpoint")
  .addEventListener("change", async (event) => {
    const views = {
      aerial: [
        [1280, 271, 1280],
        [1120, 185, 1080],
      ],
      ground: [
        [1280, 78, 1280],
        [1210, 70, 1200],
      ],
      architecture: [
        [1180, 85, 1160],
        [1110, 72, 1090],
      ],
    };
    const select = event.target;
    if (!select.value) return;
    if (specialMode) {
      location.search = "?scene=world";
      return;
    }
    const [eye, target] = views[select.value];
    sceneSelect.value = "world";
    await loadWorld(eye);
    globalThis.r2.setCamera(eye, target);
    select.value = "";
  });
const keys = new Set();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!canvas.hasPointerCapture(e.pointerId)) return;
  yaw += e.movementX * 0.004;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.004));
  resetTiming();
});
canvas.addEventListener("pointerup", (e) =>
  canvas.releasePointerCapture(e.pointerId),
);
sceneSelect.addEventListener("change", () => loadScene(sceneSelect.value));
for (const id of ["debug", "hierarchy", "fragments", "resolution", "samples"])
  document.querySelector("#" + id).addEventListener("change", resetTiming);
let last = performance.now(),
  lastStatus = 0,
  frame = 0;
/** 基准读取固定相机的计时，不把模型资源加载计入逐帧 GPU 时间。 */
function render(now) {
  if (!running) {
    requestAnimationFrame(render);
    return;
  }
  if (frame > 0) {
    frameTimes.push(now - last);
    if (frameTimes.length > 240) frameTimes.shift();
  }
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const forward = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ],
    right = [Math.cos(yaw), 0, Math.sin(yaw)],
    up = [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      Math.cos(yaw) * Math.sin(pitch),
    ];
  const speed = dt * (keys.has("shift") ? 25 : 8);
  for (let i = 0; i < 3; i++)
    position[i] +=
      speed *
      ((Number(keys.has("w")) - Number(keys.has("s"))) * forward[i] +
        (Number(keys.has("d")) - Number(keys.has("a"))) * right[i]);
  position[1] += speed * (Number(keys.has("e")) - Number(keys.has("q")));
  const scale =
    document.querySelector("#resolution").value === "device"
      ? devicePixelRatio
      : Number(document.querySelector("#resolution").value);
  const width = Math.round(innerWidth * scale),
    height = Math.round(innerHeight * scale);
  gl.uniform1i(
    uniforms.get("uSamples"),
    Number(document.querySelector("#samples").value),
  );
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    resetTiming();
  }
  gl.viewport(0, 0, width, height);
  gl.uniform2f(uniforms.get("uViewport"), width, height);
  gl.uniform3fv(uniforms.get("uCamera"), position);
  gl.uniform3fv(uniforms.get("uRight"), right);
  gl.uniform3fv(uniforms.get("uUp"), up);
  gl.uniform3fv(uniforms.get("uForward"), forward);
  gl.uniform1f(uniforms.get("uSpan"), 2 * Math.tan((65 * Math.PI) / 360));
  gl.uniform1i(
    uniforms.get("uDebug"),
    Number(document.querySelector("#debug").value),
  );
  gl.uniform1i(
    uniforms.get("uHierarchy"),
    document.querySelector("#hierarchy").checked ? 1 : 0,
  );
  gl.uniform1i(
    uniforms.get("uFragments"),
    document.querySelector("#fragments").checked ? 1 : 0,
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
  const syncStart = performance.now();
  const query = timer && queries.length < 8 ? gl.createQuery() : null;
  if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
  gl.uniform1i(
    uniforms.get("uDynamicEnabled"),
    globalThis.r2?.specialEnabled === false ? 0 : 1,
  );
  special?.update(globalThis.r2?.fixedTime ?? now / 1000);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (query) {
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    queries.push(query);
  }
  if (globalThis.r2?.synchronize) {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    completedTimes.push(performance.now() - syncStart);
    if (completedTimes.length > 240) completedTimes.shift();
  }
  frame++;
  if (now - lastStatus > 300) {
    const ordered = [...times].sort((a, b) => a - b),
      median = ordered[Math.floor(ordered.length / 2)];
    status.textContent =
      `${width}×${height} 实际像素 · 每像素 ${document.querySelector("#samples").value} 条射线\n` +
      (scene.world
        ? `近景半径 8：${scene.stats.nearSections} 个 section · 远景：${scene.stats.farSections} 个 section\n远景覆盖 1536×1536×512 · 传输 ${(scene.stats.bytes / 1024 ** 2).toFixed(1)} MiB\n读取及下载 ${scene.stats.downloadMS.toFixed(0)} ms · Worker ${scene.stats.prepareMS.toFixed(0)} ms · 上传 ${scene.stats.uploadMS.toFixed(0)} ms\n`
        : `${scene.nonAir} 个非空气格 · ${scene.fragmentReferences} 个预裁片引用\nGo 构建 ${scene.buildMS.toFixed(2)} ms · 下载及上传 ${scene.uploadMS.toFixed(1)} ms\n`) +
      `GPU 纹理 ${(allocated / 1024 ** 2).toFixed(1)} MiB · GPU ${median?.toFixed(2) ?? "…"} ms\n世界位置 ${position.map((v, i) => (v + (scene.origin?.[i] || 0)).toFixed(1)).join(", ")}`;
    lastStatus = now;
  }
  requestAnimationFrame(render);
}
await loadScene(sceneSelect.value);
// 研究页面提供固定输入的读回入口，供自动化验收使用。
globalThis.r2 = {
  gl,
  loadScene,
  loadWorld,
  setCamera(eye, target, reset = true) {
    position = eye.map((v, i) => v - (scene.origin?.[i] || 0));
    const d = target.map((v, i) => v - eye[i]);
    yaw = Math.atan2(d[0], -d[2]);
    pitch = Math.asin(d[1] / Math.hypot(...d));
    if (reset) resetTiming();
  },
  resetTiming,
  get state() {
    return {
      scene,
      statistics,
      assetMS,
      allocated,
      frame,
      frameTimes: [...frameTimes],
      completedTimes: [...completedTimes],
      resolution: [canvas.width, canvas.height],
      times: [...times],
      position: [...position],
    };
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
};
requestAnimationFrame(render);
