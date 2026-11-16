// 从可编译的最小路径逐项加回功能，第一次失败或超时即停；不修改产品着色器。
// 依赖 Playwright。例：node experiment/shader-addback.cjs --timeout=3000
// --single-locate 对比统一返回的空间查询；--stage=5 单测一个阶段；--stage=9 测完整程序。
// --revision=efffe73 固定改写前的源码；省略时读取工作区。新源码已经统一返回。
// 超时只表示超过本次预算，不表示编译器最终会失败。此实验不测画质或运行帧率。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = true] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const timeout = Number(args.get("timeout") || 3000);
const pass = Number(args.get("pass") || 0);
const singleLocate = args.has("single-locate");
const revision = args.get("revision") || null;
const selected = args.has("stage") ? Number(args.get("stage")) : null;
if (!(timeout > 0) || ![0, 1].includes(pass) ||
    (selected !== null && (!Number.isInteger(selected) || selected < 0 || selected > 9))) {
  throw Error("需要 --timeout=正毫秒数、--pass=0或1、--stage=0至9");
}
const names = ["ray", "lookup", "traversal", "solid", "texture", "lighting",
  "models", "objects", "shadow", "full"];
const output = path.resolve(String(args.get("output") ||
  `shader-addback-${Date.now()}`));
const root = path.resolve(__dirname, "..");
function readShader(file) {
  return revision ? execFileSync("git", ["show", `${revision}:web/render/${file}`], {
    cwd: root, encoding: "utf8",
  }) : fs.readFileSync(path.join(root, "web/render", file), "utf8");
}
const original = readShader("ray.frag").replace("#include <objects>", readShader("objects.frag"));

/** 替换函数体，保留其他代码；输出的完整 GLSL 也会落盘，便于核对实验。 */
function replaceBody(source, name, replacement) {
  const match = new RegExp(`\\b${name}\\([^;{}]*\\)\\s*\\{`).exec(source);
  if (!match) throw Error(`未找到函数 ${name}`);
  const start = match.index + match[0].length;
  let end = start, depth = 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  if (depth) throw Error(`${name} 的括号不匹配`);
  return source.slice(0, start) + replacement + source.slice(end - 1);
}

/** 仅改变返回位置，仍保留层次、缓存、调色板和片段查询。 */
const locateSingleReturn = `
 level=0;cellLevel=false;parts=0u;
 ivec3 directory=(cell+uDirectoryOffset)>>4;
 if(cell>>4!=cachedSection){
  cachedSection=cell>>4;cachedBrick=-1;
  section=texelFetch(uSections,directory&ivec3(255,31,255),0);
  partsBase=section.x!=0u&&uFragments?worldWord(section.x+AUX_PARTS):0u;
 }
 uint result=0u;
 if(section.x==0u){
  result=section.y;
  if(uHierarchy){
   level=4;
   for(int l=1;l<=8;l++){
    if(texelFetch(uTree,(directory&ivec3(255,31,255))>>l,l).r!=section.y)break;
    level=l+4;
   }
  }
 }else{
  ivec3 local=cell&15;
  int brick=((local.x>>2)*4+(local.z>>2))*4+(local.y>>2);
  if(maskBit(section.zw,brick)){
   if(brick!=cachedBrick){
    cachedBrick=brick;uint at=section.x+uint(brick*2);
    cellMask=uvec2(worldWord(at),worldWord(at+1u));
    brickTag=worldWord(section.x+AUX_TAGS+uint(brick));
   }
   if(brickTag!=MIXED){level=uHierarchy?2:0;result=brickTag;}
   else if(maskBit(cellMask,((local.x&3)*4+(local.z&3))*4+(local.y&3))){
    cellLevel=true;
    uint index=localIndex(local),bits=section.y>>27,palette=0u;
    if(bits!=0u){
     uint per=32u/bits;
     palette=(worldWord((section.y&0x7ffffffu)+index/per)>>((index%per)*bits))&((1u<<bits)-1u);
    }
    if(partsBase!=0u)parts=worldWord(partsBase+index);
    result=worldWord(section.x+AUX_PALETTE+palette);
   }
  }else{level=uHierarchy?2:0;}
 }
 return result;
`;

function makeSource(stage) {
  let source = original.replace("#version 300 es", `#version 300 es\n#define RENDER_PASS ${pass}`);
  if (stage < 7) source = replaceBody(source, "intersectObject", "return;");
  if (stage < 6) source = replaceBody(source, "intersectModel", "return;");
  if (stage < 5) source = replaceBody(source, "contribute", `
    if(!touched){touched=true;firstDepth=t;firstNormal=m.geometric;}
    radiance+=throughput*rgb*alpha;throughput*=1.0-alpha;
  `);
  if (stage < 3) source = replaceBody(source, "cubeSurface", "return true;");
  else if (stage === 3) source = replaceBody(source, "cubeSurface", `
    vec4 color=table(uFast,int(fastOffset)+side*4+3);
    contribute(color.rgb,color.a,t,plainMaterial(axisNormal(side)),false);return true;
  `);
  if (singleLocate) source = replaceBody(source, "locate", locateSingleReturn);
  if (stage === 9) return source;
  const code = stage === 0 ? "outColor=vec4(ray,1);" : stage === 1 ? `
    int level;bool cellLevel;uint parts;
    uint id=locate(ivec3(eye),level,cellLevel,parts);
    outColor=vec4(float(id),float(level),float(parts),1);
  ` : `
    march(1e30,false);
    outColor=vec4(radiance+${stage === 8 ? "directLight(false)" : "directSum"}
      +vec3(float(steps)/128.0),1);
  `;
  // 输出 steps，防止优化器把无表面的遍历整个删掉；屏幕射线保留纹理微分。
  return source.slice(0, source.indexOf("vec3 tracePixel(")) + `
    void main(){
      vec2 uv=(gl_FragCoord.xy/uViewport-.5)*vec2(uViewport.x/uViewport.y,1)*uSpan;
      vec3 direction=uForward+uv.x*uRight+uv.y*uUp;
      rayLength=length(direction);ray=direction/rayLength;eye=uCamera;
      primaryRay=true;primaryTravel=0.0;setupLight();steps=0;faceTests=0;
      ${code}
    }
  `;
}

async function compile(source) {
  // 每个阶段使用独立浏览器进程，避免前一个超时的编译继续争抢 CPU。
  const server = await chromium.launchServer({
    executablePath: process.env.CHROME || (process.platform === "win32"
      ? `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`
      : undefined),
    headless: true,
    args: process.env.R2_ANGLE ? [`--use-angle=${process.env.R2_ANGLE}`] : [],
  });
  let watchdog;
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    const page = await browser.newPage();
    return await Promise.race([
      page.evaluate(async ({ source, timeout }) => {
        const gl = document.createElement("canvas").getContext("webgl2");
        if (!gl) throw Error("WebGL 2 不可用");
        const parallel = gl.getExtension("KHR_parallel_shader_compile");
        if (!parallel) throw Error("缺少异步编译扩展，无法安全执行限时实验");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown";
        const start = performance.now();
        const program = gl.createProgram(), shaders = [];
        for (const [type, text] of [
          [gl.VERTEX_SHADER, "#version 300 es\nvoid main(){gl_Position=vec4(0,0,0,1);}"],
          [gl.FRAGMENT_SHADER, source],
        ]) {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, text);gl.compileShader(shader);
          gl.attachShader(program, shader);shaders.push(shader);
        }
        gl.linkProgram(program);
        while (true) {
          const ms = performance.now() - start;
          if (gl.isContextLost()) return { gpu, ms, status: "context-lost" };
          if (gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) break;
          if (ms >= timeout) return { gpu, ms, status: "timeout" };
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (gl.isContextLost()) return { gpu, status: "context-lost" };
        const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
        if (gl.isContextLost()) return { gpu, status: "context-lost" };
        return {
          gpu, ms: performance.now() - start, status: linked ? "linked" : "failed",
          log: gl.getProgramInfoLog(program),
          shaders: shaders.map((shader) => gl.getShaderInfoLog(shader)),
        };
      }, { source, timeout }),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(Error("浏览器未响应编译计时器")), timeout + 15000);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    // 强制结束本实验拥有的进程树；不等待卡住的 GPU 编译自行退出。
    await server.kill();
  }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  const stages = selected === null ? names.map((_, i) => i) : [selected];
  for (const stage of stages) {
    const source = makeSource(stage), name = `${stage}-${names[stage]}`;
    fs.writeFileSync(path.join(output, `${name}.frag`), source);
    const result = { stage, name: names[stage], pass, singleLocate, revision, timeout,
      sourceSHA256: crypto.createHash("sha256").update(source).digest("hex"),
      ...await compile(source) };
    results.push(result);
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
    console.log(`${name}: ${result.status}, ${Math.round(result.ms || 0)} ms; ${result.gpu}`);
    if (result.status !== "linked") break;
  }
  console.log(`完整源码与日志：${output}`);
})().catch((error) => { console.error(error);process.exitCode = 1; });
