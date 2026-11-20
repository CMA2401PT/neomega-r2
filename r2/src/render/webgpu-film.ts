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
}
// 在最终显示色中比较颜色。半径为一像素，RGB 均方色差的尺度是 8 位色的 4 级。
@fragment fn denoise(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let center = textureLoad(img,p,0).rgb;
  let edge = vec2i(textureDimensions(img))-1;
  var sum = center;
  var total = 1.;
  for(var y=-1;y<=1;y++) {
    for(var x=-1;x<=1;x++) {
      if(x==0 && y==0){continue;}
      let color = textureLoad(img,clamp(p+vec2i(x,y),vec2i(0),edge),0).rgb;
      let delta = (color-center)*(255./4.);
      let weight = exp(-.5*(f32(x*x+y*y)/(.85*.85)+dot(delta,delta)/3.));
      sum += color*weight;
      total += weight;
    }
  }
  return vec4f(mix(center,sum/total,.65),1.);
}`;

export async function displayPipelines(device: GPUDevice, vertexModule: GPUShaderModule) {
  const module = device.createShaderModule({ code: post });
  const make = (entryPoint: string, format: GPUTextureFormat) =>
    device.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: vertexModule, entryPoint: "vert" },
      fragment: { module, entryPoint, targets: [{ format }] },
    });
  const [pre, mip, show, denoise] = await Promise.all([
    make("prefilter", "rgba16float"),
    make("mip", "rgba16float"),
    make("composite", "rgba8unorm"),
    make("denoise", "rgba8unorm"),
  ]);
  return {
    pre,
    mip,
    show,
    denoise,
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
        (format === "rgba32float" ? GPUTextureUsage.STORAGE_BINDING : 0),
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
  const images = [0, 1].map(() => target("rgba32float", [width, height]).createView());
  const frames = images.map((hdr, i) => ({
    hdr,
    width,
    height,
    history: group(device, historyLayout, [[0, images[1 - i]]]),
    pre: group(device, fx.pre.getBindGroupLayout(0), [[0, hdr]]),
    show: group(device, fx.show.getBindGroupLayout(0), [
      [0, hdr],
      [1, bloom.createView()],
      [2, fx.sampler],
      [3, { buffer: display }],
    ]),
  }));
  // 保留最近一轮完整的显示原图，分块拍照期间也能切换降噪并保存同一轮照片。
  const outputView = output.createView();
  let filtered: { texture: GPUTexture; view: GPUTextureView; bind: GPUBindGroup } | undefined;
  let filteredCurrent = false;
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

  /** 从最近完成的原图取得显示画面，同一轮的屏幕和 PNG 可复用滤波结果。 */
  function displayImage(enc: GPUCommandEncoder, denoise: boolean, queries?: GPUQuerySet | null): GPUTexture {
    if (!denoise) return output;
    if (!filtered) {
      const texture = target("rgba8unorm", [width, height]);
      filtered = {
        texture,
        view: texture.createView(),
        bind: group(device, fx.denoise.getBindGroupLayout(0), [[0, outputView]]),
      };
    }
    if (!filteredCurrent) {
      pass(enc, fx.denoise, filtered.bind, filtered.view, queries);
      filteredCurrent = true;
    }
    return filtered.texture;
  }

  return {
    width,
    height,
    displayImage,
    get bytes() {
      return width * height * (filtered ? 40 : 36) + (size[0] * size[1] * 8 * 4) / 3;
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
      filteredCurrent = false;
    },
    dispose() {
      textures.forEach((t) => t.destroy());
      display.destroy();
    },
  };
}
export async function readTexture(device: GPUDevice, texture: GPUTexture, bytes: number) {
  const pitch = Math.ceil((texture.width * bytes) / 256) * 256;
  const buffer = device.createBuffer({
    size: pitch * texture.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [texture.width, texture.height]);
    device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buffer.getMappedRange()),
      row = texture.width * bytes,
      packed = new Uint8Array(row * texture.height);
    for (let y = 0; y < texture.height; y++) packed.set(data.subarray(y * pitch, y * pitch + row), y * row);
    return packed;
  } finally {
    buffer.destroy();
  }
}
