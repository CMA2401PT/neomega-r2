// 两个 2× CNN 的网络结构和权重来自 WebSR。此处直接消费 R2 的 GPU 纹理。
import type { SuperResolution } from "./options.ts";

type Model = Exclude<SuperResolution, "off">;
declare const R2_WEBSR_MODELS: Record<Model, { offsets: number[]; data: string }>;
const tileSize = 128;

// 每个图块额外读取覆盖卷积感受野的边缘，最后只写中心。中间特征的显存与整张照片的尺寸无关。
const shader = `
struct Tile { origin: vec2i, stage: u32, weights: u32, size: vec2u }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var outputImage: texture_storage_2d_array<rgba8unorm,write>;
@group(0) @binding(2) var<storage,read> w: array<vec4f>;
@group(0) @binding(3) var<storage,read_write> features: array<vec4f>;
@group(0) @binding(4) var<uniform> tile: Tile;
override groups: u32 = 4u;
override halo: u32 = 7u;

fn matrix(i: u32) -> mat4x4f { return mat4x4f(w[i], w[i+1], w[i+2], w[i+3]); }
fn address(stage: u32, p: vec2u, g: u32) -> u32 {
  return ((stage * tile.size.y + p.y) * tile.size.x + p.x) * groups + g;
}
fn inside(p: vec2i, size: vec2u) -> bool {
  return all(p >= vec2i(0)) && all(p < vec2i(size));
}
fn feature(stage: u32, p: vec2i, g: u32) -> vec4f {
  if (!inside(p,tile.size)) { return vec4f(0); }
  return features[address(stage, vec2u(p), g)];
}
fn offset(k: u32) -> vec2i { return vec2i(i32(k/3u)-1,i32(k%3u)-1); }

@compute @workgroup_size(8,8)
fn stem(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= tile.size)) { return; }
  let p = tile.origin + vec2i(id.xy);
  for (var g=0u; g<groups; g++) {
    let base = tile.weights + g*37u;
    var v = w[base];
    if (inside(p, textureDimensions(source))) {
      for (var k=0u; k<9u; k++) {
        let q = p+offset(k);
        v += matrix(base+1u+4u*k) * textureLoad(source,q,0);
      }
    } else { v = vec4f(0); }
    features[address(0,id.xy,g)] = v;
  }
}

// XS 使用逐通道的 3×3 卷积。S 用正负激活分别卷积，并保留七层特征供最后的投影读取。
@compute @workgroup_size(8,8)
fn convolution(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= tile.size)) { return; }
  let p = vec2i(id.xy);
  for (var g=0u; g<groups; g++) {
    var v = vec4f(0);
    if (inside(tile.origin+p,textureDimensions(source))) {
      if (halo == 2u) {
        v = w[tile.weights+g];
        for (var k=0u; k<9u; k++) {
          let pix = feature(0,p+offset(k),g);
          let i = tile.weights+4u+4u*k+g;
          v += w[i]*max(pix,vec4f(0)) + w[i+36u]*max(-pix,vec4f(0));
        }
      } else {
        let base = tile.weights + g*(1u+72u*groups);
        v = w[base];
        for (var k=0u; k<9u; k++) {
          for (var ch=0u; ch<groups; ch++) {
            let pix = feature(tile.stage-1u,p+offset(k),ch);
            let i = base+1u+4u*(ch*9u+k);
            v += matrix(i)*max(pix,vec4f(0)) + matrix(i+36u*groups)*max(-pix,vec4f(0));
          }
        }
      }
    }
    features[address(tile.stage,id.xy,g)] = v;
  }
}

fn cubic(x: f32) -> f32 {
  let t=abs(x);
  if (t<=1.0) {return (1.5*t-2.5)*t*t+1.0;}
  return ((-0.5*t+2.5)*t-4.0)*t+2.0;
}
fn baseColor(low: vec2i, sub: vec2u) -> vec3f {
  let delta=(vec2f(sub)-0.5)*0.5;
  let base=low+vec2i(floor(delta));
  let f=fract(delta);
  let hi=vec2i(textureDimensions(source))-1;
  var sum=vec3f(0);
  // XS 的残差叠加到双线性底图，S 叠加到 Catmull-Rom 双三次底图。
  let first=select(-1,0,halo==2u);
  let last=select(2,1,halo==2u);
  for(var y=first;y<=last;y++){
    for(var x=first;x<=last;x++){
      let d=abs(vec2f(f32(x),f32(y))-f);
      let weight=select(cubic(d.x)*cubic(d.y),(1.0-d.x)*(1.0-d.y),halo==2u);
      let q=base+vec2i(x,y);
      let size=hi+1;
      let coord=select(clamp(q,vec2i(0),hi),(q+size)%size,halo==2u);
      sum+=weight*textureLoad(source,coord,0).rgb;
    }
  }
  return sum;
}
@compute @workgroup_size(8,8)
fn reconstruct(@builtin(global_invocation_id) id: vec3u) {
  let p=id.xy+halo;
  if (any(id.xy >= tile.size - 2u*halo)) { return; }
  let low=tile.origin+vec2i(p);
  if (!inside(low,textureDimensions(source))) {return;}
  var rgb: array<vec4f,3>;
  for(var c=0u;c<3u;c++) {
    if(halo==2u) {
      rgb[c]=w[tile.weights+c];
      for(var g=0u;g<4u;g++) {
        let v=features[address(1u,p,g)];
        let i=tile.weights+4u+4u*(c*4u+g);
        rgb[c]+=matrix(i)*max(v,vec4f(0))+matrix(i+64u)*max(-v,vec4f(0));
      }
    } else {
      let base=tile.weights+c*(1u+56u*groups);
      rgb[c]=w[base];
      for(var stage=0u;stage<7u;stage++) {
        for(var g=0u;g<groups;g++) {
          let v=features[address(stage,p,g)];
          let i=base+1u+4u*(stage*groups*2u+g);
          rgb[c]+=matrix(i)*max(v,vec4f(0))+matrix(i+4u*groups)*max(-v,vec4f(0));
        }
      }
    }
  }
  // 四个通道分别重建原图一个像素对应的 2×2 子像素。超过设备单张纹理上限时按象限分层。
  let layerSize = vec2i(textureDimensions(outputImage));
  let layersX = (i32(textureDimensions(source).x)*2 + layerSize.x-1) / layerSize.x;
  for (var lane=0u; lane<4u; lane++) {
    let sub = vec2u(lane%2u,lane/2u);
    let color = baseColor(low,sub) + vec3f(rgb[0][lane],rgb[1][lane],rgb[2][lane]);
    let pos = low*2 + vec2i(sub);
    let layer = pos / layerSize;
    textureStore(outputImage,pos % layerSize,layer.y*layersX+layer.x,vec4f(color,1));
  }
}`;

// 正常画幅直接使用一层。巨幅照片可以分成两列或两行，缩放时仍按连续的两倍图取样。
const resizeShader = `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var outputImage: texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(2) var<uniform> layers: vec2u;
// 按目标像素覆盖范围取平均。放大时一格宽的核等价于双线性插值，缩小时覆盖整个来源足迹。
@compute @workgroup_size(8,8)
fn resize(@builtin(global_invocation_id) id: vec3u) {
  let dst = textureDimensions(outputImage);
  if (any(id.xy >= dst)) { return; }
  let layerSize = textureDimensions(source);
  let src = layerSize * layers;
  let ratio = vec2f(src) / vec2f(dst);
  let center = (vec2f(id.xy) + 0.5) * ratio;
  let span = max(ratio, vec2f(1));
  let lo = center - 0.5 * span;
  let hi = center + 0.5 * span;
  var sum = vec3f(0);
  for (var y = i32(floor(lo.y)); y < i32(ceil(hi.y)); y++) {
    for (var x = i32(floor(lo.x)); x < i32(ceil(hi.x)); x++) {
      let p = vec2i(x,y);
      let overlap = min(hi,vec2f(p+1)) - max(lo,vec2f(p));
      let q = vec2u(clamp(p,vec2i(0),vec2i(src)-1));
      let layer = q / layerSize;
      sum += textureLoad(source,q % layerSize,layer.y*layers.x+layer.x,0).rgb * overlap.x * overlap.y;
    }
  }
  textureStore(outputImage,id.xy,vec4f(sum/(span.x*span.y),1));
}`;

function createPipelines(device: GPUDevice, model: Model) {
  const visibility = GPUShaderStage.COMPUTE;
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility, texture: {} },
    { binding: 1, visibility, storageTexture: { format: "rgba8unorm", viewDimension: "2d-array" } },
    { binding: 2, visibility, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility, buffer: { type: "storage" } },
    { binding: 4, visibility, buffer: { type: "uniform", hasDynamicOffset: true } },
  ] });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const module = device.createShaderModule({ label: "WebSR", code: shader });
  const groups = model === "cnn-s" ? 2 : 4, halo = model === "cnn-xs" ? 2 : 7;
  const pipelines = ["stem", "convolution", "reconstruct"].map(entryPoint => device.createComputePipeline({
    label: `WebSR ${model} ${entryPoint}`, layout: pipelineLayout,
    compute: { module, entryPoint, constants: { groups, halo } },
  }));
  const resize = device.createComputePipeline({
    label: "WebSR 输出尺寸缩放", layout: "auto", compute: { module: device.createShaderModule({ code: resizeShader }), entryPoint: "resize" },
  });
  return { layout, pipelines, groups, halo, resize };
}
const caches = new WeakMap<GPUDevice, Map<Model, ReturnType<typeof createPipelines>>>();

/** 直接从 width × height 原图重建两倍图。多个输出尺寸可共用这一次推理。 */
export function createWebSR(device: GPUDevice, model: Model, width: number, height: number) {
  let cache = caches.get(device);
  if (!cache) caches.set(device, cache = new Map());
  let network = cache.get(model);
  if (!network) cache.set(model, network = createPipelines(device, model));
  const { layout, pipelines, groups, halo, resize } = network;
  const { offsets, data } = R2_WEBSR_MODELS[model];
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const weights = device.createBuffer({ size: bytes.length, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(weights, 0, bytes);
  const tileWidth = Math.min(tileSize, width), tileHeight = Math.min(tileSize, height);
  const cols = Math.ceil(width / tileWidth), rows = Math.ceil(height / tileHeight);
  const paddedWidth = tileWidth + 2 * halo, paddedHeight = tileHeight + 2 * halo;
  // 每层保留每像素 groups 个 vec4，最后一层直接写输出纹理。
  const scratch = device.createBuffer({
    size: paddedWidth * paddedHeight * groups * 16 * (offsets.length - 1),
    usage: GPUBufferUsage.STORAGE,
  });
  const stride = Math.max(32, device.limits.minUniformBufferOffsetAlignment);
  const params = new Int32Array(cols * rows * offsets.length * stride / 4);
  const tiles: { width: number; height: number }[] = [];
  let cursor = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const widthHere = Math.min(tileWidth, width - x * tileWidth);
      const heightHere = Math.min(tileHeight, height - y * tileHeight);
      tiles.push({ width: widthHere, height: heightHere });
      for (const [stage, offset] of offsets.entries()) {
        params.set([x * tileWidth - halo, y * tileHeight - halo, stage, offset, widthHere + 2 * halo, heightHere + 2 * halo], cursor);
        cursor += stride / 4;
      }
    }
  }
  const uniforms = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniforms, 0, params);
  const limit = device.limits.maxTextureDimension2D;
  const layersX = 2 * width > limit ? 2 : 1, layersY = 2 * height > limit ? 2 : 1;
  const output = device.createTexture({
    label: "WebSR 2× 原图",
    size: [2 * width / layersX, 2 * height / layersY, layersX * layersY],
    format: "rgba8unorm",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const fullView = output.createView({ dimension: "2d-array" });
  const layerCounts = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(layerCounts, 0, new Uint32Array([layersX, layersY]));
  const bindings = new WeakMap<GPUTexture, GPUBindGroup>();
  let resized: GPUTexture | undefined, resizeBind: GPUBindGroup, resizeCurrent = false;
  return {
    model,
    get bytes() {
      return weights.size + scratch.size + uniforms.size + layerCounts.size + width * height * 16 +
        (resized ? resized.width * resized.height * 4 : 0);
    },
    /** 新样本才运行神经网络。恰好输出 2× 原图时直接交付 GPU 纹理。 */
    image(enc: GPUCommandEncoder, input: GPUTexture, newSample: boolean,
      size: { width: number; height: number }, queries?: GPUQuerySet | null): GPUTexture {
      const fullSize = size.width === 2 * width && size.height === 2 * height;
      const timestamps = queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {};
      let pass: GPUComputePassEncoder | undefined;
      if (newSample) {
        let bind = bindings.get(input);
        if (!bind) {
          bind = device.createBindGroup({ layout, entries: [
            { binding: 0, resource: input.createView() }, { binding: 1, resource: fullView },
            { binding: 2, resource: { buffer: weights } }, { binding: 3, resource: { buffer: scratch } },
            { binding: 4, resource: { buffer: uniforms, size: 24 } },
          ] });
          bindings.set(input, bind);
        }
        pass = enc.beginComputePass({ label: "WebSR " + model, ...timestamps });
        let at = 0;
        for (const tile of tiles) {
          for (let stage = 0; stage < offsets.length; stage++) {
            const last = stage === offsets.length - 1;
            const border = last ? 0 : 2 * halo;
            pass.setPipeline(pipelines[last ? 2 : stage === 0 ? 0 : 1]);
            pass.setBindGroup(0, bind, [at]);
            pass.dispatchWorkgroups(Math.ceil((tile.width + border) / 8), Math.ceil((tile.height + border) / 8));
            at += stride;
          }
        }
        resizeCurrent = false;
      }
      if (fullSize) {
        pass?.end();
        return output;
      }
      if (!resized || resized.width !== size.width || resized.height !== size.height) {
        resized?.destroy();
        resized = device.createTexture({
          label: "WebSR 适配输出尺寸", size, format: "rgba8unorm",
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        resizeBind = device.createBindGroup({ layout: resize.getBindGroupLayout(0), entries: [
          { binding: 0, resource: fullView }, { binding: 1, resource: resized.createView() },
          { binding: 2, resource: { buffer: layerCounts } },
        ] });
        resizeCurrent = false;
      }
      if (!resizeCurrent) {
        pass ??= enc.beginComputePass({ label: "适配超分输出尺寸", ...timestamps });
        pass.setPipeline(resize);
        pass.setBindGroup(0, resizeBind);
        pass.dispatchWorkgroups(Math.ceil(size.width / 8), Math.ceil(size.height / 8));
        resizeCurrent = true;
      }
      pass?.end();
      return resized;
    },
    dispose() {
      resized?.destroy();
      output.destroy();
      layerCounts.destroy();
      uniforms.destroy();
      scratch.destroy();
      weights.destroy();
    },
  };
}
