export const vertex = `
@vertex fn vert(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0, 1);
}`;

const post = `
@group(0) @binding(3) var<uniform> display:vec4f;
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var glow: texture_2d<f32>;
@group(0) @binding(2) var linearClamp: sampler;
fn texel(p: vec2i) -> vec3f {
  let s = textureLoad(img, min(p,vec2i(textureDimensions(img))-1), 0);
  return min(s.rgb/max(s.a,.00001),vec3f(50));
}
@fragment fn prefilter(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy)*2;
  return vec4f((texel(p)+texel(p+vec2i(1,0))+texel(p+vec2i(0,1))+texel(p+1))*.25,1);
}
@fragment fn mip(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dst = max(vec2u(1),textureDimensions(glow)/2);
  return textureSampleLevel(glow,linearClamp,pos.xy/vec2f(dst),0);
}
@fragment fn composite(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = textureLoad(img,vec2i(pos.xy),0);
  let uv = pos.xy/vec2f(textureDimensions(img));
  var bloom = vec3f(0);
  for(var i=1;i<=6;i++) {
    let l=min(i,i32(textureNumLevels(glow))-1);
    let d = .5/vec2f(textureDimensions(glow,l));
    bloom += textureSampleLevel(glow,linearClamp,uv-d,f32(l)).rgb
           + textureSampleLevel(glow,linearClamp,uv+d,f32(l)).rgb
           + textureSampleLevel(glow,linearClamp,uv+vec2f(d.x,-d.y),f32(l)).rgb
           + textureSampleLevel(glow,linearClamp,uv+vec2f(-d.x,d.y),f32(l)).rgb;
  }
  if(display.y>0.){return vec4f(s.rgb/max(s.a,.00001),1.);}
  let x=mix(s.rgb/max(s.a,.00001),bloom/24.,.075)*display.x;
  let c = clamp(x*(2.51*x+.03)/(x*(2.43*x+.59)+.14),vec3f(0),vec3f(1));
  return vec4f(select(c*12.92,1.055*pow(c,vec3f(1./2.4))-.055,c>vec3f(.0031308)),1);
}`;

export async function displayPipelines(device: GPUDevice, vertexModule: GPUShaderModule) {
  const module = device.createShaderModule({ code: post });
  const make = (entryPoint: string, format: GPUTextureFormat) =>
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: vertexModule, entryPoint: "vert" },
      fragment: { module, entryPoint, targets: [{ format }] },
    });
  const [pre, mip, show] = await Promise.all([
    make("prefilter", "rgba16float"),
    make("mip", "rgba16float"),
    make("composite", "rgba8unorm"),
  ]);
  return {
    pre,
    mip,
    show,
    sampler: device.createSampler({ minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" }),
  };
}

export function group(device: GPUDevice, layout: GPUBindGroupLayout, pairs: [number, GPUBindingResource][]) {
  return device.createBindGroup({
    layout,
    entries: pairs.map(([binding, resource]) => ({ binding, resource })),
  });
}

export function frameFilm(
  device: GPUDevice,
  fx: Awaited<ReturnType<typeof displayPipelines>>,
  historyLayout: GPUBindGroupLayout,
  width: number,
  height: number,
  unusedDepth: GPUTextureView,
) {
  const textures: GPUTexture[] = [];
  function target(format: GPUTextureFormat, size: number[], levels = 1) {
    const t = device.createTexture({
      format,
      size,
      mipLevelCount: levels,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING |
        (format === "rgba32float" || format === "r32float" ? GPUTextureUsage.STORAGE_BINDING : 0),
    });
    textures.push(t);
    return t;
  }
  const size = [Math.max(1, width >> 1), Math.max(1, height >> 1)],
    levels = 1 + Math.floor(Math.log2(Math.max(...size)));
  const bloom = target("rgba16float", size, levels),
    output = target("rgba8unorm", [width, height]);
  const display = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const mips = Array.from({ length: levels }, (_, i) =>
    bloom.createView({ baseMipLevel: i, mipLevelCount: 1 }),
  );
  const downs = mips.slice(0, -1).map((v) =>
    group(device, fx.mip.getBindGroupLayout(0), [
      [1, v],
      [2, fx.sampler],
    ]),
  );
  let depth: GPUTexture | null = null;
  const images = [0, 1].map(() => target("rgba32float", [width, height]).createView());
  const frames = images.map((hdr, i) => ({
    hdr,
    width,
    height,
    history: group(device, historyLayout, [[0, images[1 - i]], [1, unusedDepth]]),
    pre: group(device, fx.pre.getBindGroupLayout(0), [[0, hdr]]),
    show: group(device, fx.show.getBindGroupLayout(0), [
      [0, hdr],
      [1, bloom.createView()],
      [2, fx.sampler],
      [3, { buffer: display }],
    ]),
  }));
  const outputView = output.createView();
  let last = 1;

  function pass(
    enc: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bind: GPUBindGroup,
    view: GPUTextureView,
    queries?: GPUQuerySet | null,
  ) {
    const p = enc.beginRenderPass({
      ...(queries ? { timestampWrites: { querySet: queries, endOfPassWriteIndex: 1 } } : {}),
      colorAttachments: [{ view, loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" }],
    });
    p.setPipeline(pipeline);
    p.setBindGroup(0, bind);
    p.draw(3);
    p.end();
  }

  return {
    width,
    height,
    get color() { return output; },
    get depth() { return depth; },
    /** 第一次需要深度时补上纹理，颜色和累积仍沿用原有资源。 */
    enableDepth() {
      if (depth) return;
      const texture = target("r32float", [width, height]);
      const view = texture.createView();
      frames.forEach((frame, i) => {
        frame.history = group(device, historyLayout, [[0, images[1 - i]], [1, view]]);
      });
      depth = texture;
    },
    get bytes() {
      return width * height * (36 + (depth ? 4 : 0)) + (size[0] * size[1] * 8 * 4) / 3;
    },
    next() {
      last = 1 - last;
      return frames[last];
    },
    composite(enc: GPUCommandEncoder, exposure: number, raw: boolean, queries?: GPUQuerySet | null) {
      device.queue.writeBuffer(display, 0, new Float32Array([exposure, +raw, 0, 0]));
      pass(enc, fx.pre, frames[last].pre, mips[0]);
      downs.forEach((g, i) => pass(enc, fx.mip, g, mips[i + 1]));
      pass(enc, fx.show, frames[last].show, outputView, queries);
    },
    dispose() {
      textures.forEach((t) => t.destroy());
      display.destroy();
    },
  };
}

/** 从左上角起始按行紧密读回 GPU 纹理像素。大幅纹理按设备缓冲上限分批读取。 */
export async function readTexture(device: GPUDevice, texture: GPUTexture, bytes: number) {
  const row = texture.width * bytes, pitch = Math.ceil(row / 256) * 256;
  const batch = Math.min(texture.height, Math.floor(device.limits.maxBufferSize / pitch));
  const batches: { buffer: GPUBuffer; first: number; height: number }[] = [];
  const packed = new Uint8Array(row * texture.height);
  try {
    const enc = device.createCommandEncoder();
    for (let first = 0; first < texture.height; first += batch) {
      const height = Math.min(batch, texture.height - first);
      const buffer = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      batches.push({ buffer, first, height });
      enc.copyTextureToBuffer({ texture, origin: [0, first] }, { buffer, bytesPerRow: pitch }, [texture.width, height]);
    }
    device.queue.submit([enc.finish()]);
    for (const { buffer, first, height } of batches) {
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      for (let y = 0; y < height; y++) {
        packed.set(data.subarray(y * pitch, y * pitch + row), (first + y) * row);
      }
      buffer.unmap();
    }
    return packed;
  } finally {
    for (const { buffer } of batches) buffer.destroy();
  }
}
