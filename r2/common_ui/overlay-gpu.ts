/// <reference types="@webgpu/types" />
import type { Stamp } from "./scene-overlay.js";

function parameters(
  stamp: Stamp,
  width: number,
  height: number,
  perspective: boolean,
): Float32Array<ArrayBuffer> {
  const [x, y, w, h] = stamp.rect;
  return new Float32Array([
    x / width,
    y / height,
    w / width,
    h / height,
    ...stamp.plane,
    stamp.test ? (perspective ? 2 : 1) : 0,
  ]);
}

// 共面选框与地形的交点由不同投影路径求得，给两端相同的格数容差。
const DEPTH_BIAS = 0.003;
const wgsl = `
struct Params { rect:vec4f, plane:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var ink:texture_2d<f32>;
@group(0) @binding(2) var scene:texture_2d<f32>;
@group(0) @binding(3) var smp:sampler;
struct V { @builtin(position) pos:vec4f, @location(0) uv:vec2f, @location(1) screen:vec2f }
@vertex fn vert(@builtin(vertex_index) i:u32)->V {
  let uv=vec2f(f32(i&1u),f32(i>>1u));
  let screen=p.rect.xy+uv*p.rect.zw;
  return V(vec4f(screen*vec2f(2,-2)+vec2f(-1,1),0,1),uv,screen);
}
@fragment fn frag(v:V)->@location(0) vec4f {
  let color=textureSampleLevel(ink,smp,v.uv,0);
  if(p.plane.w>0){
    let d=dot(p.plane.xyz,vec3f(v.screen,1));
    let z=select(d,1/d,p.plane.w==2);
    let size=vec2i(textureDimensions(scene));
    let hit=textureLoad(scene,clamp(vec2i(v.screen*vec2f(size)),vec2i(0),size-1),0).r;
    if(hit>=0 && z>hit+${DEPTH_BIAS}){discard;}
  }
  return color;
}`;

/** 在同一 WebGPU 设备的透明画布上绘制，浏览器把预乘透明度的结果叠到场景上。 */
export function gpuOverlay(device: GPUDevice, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "premultiplied" });
  const fragment = GPUShaderStage.FRAGMENT;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | fragment, buffer: {} },
      { binding: 1, visibility: fragment, texture: {} },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: fragment, sampler: {} },
    ],
  });
  const module = device.createShaderModule({ code: wgsl });
  const blend: GPUBlendComponent = { srcFactor: "one", dstFactor: "one-minus-src-alpha" };
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vert" },
    fragment: { module, entryPoint: "frag", targets: [{ format, blend: { color: blend, alpha: blend } }] },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  let entries: { texture: GPUTexture; params: GPUBuffer; group: GPUBindGroup }[] = [];
  let previous: Stamp[] | undefined, previousDepth: GPUTexture | undefined;
  function release() {
    for (const { texture, params } of entries) {
      texture.destroy();
      params.destroy();
    }
    entries = [];
  }
  return {
    draw(stamps: Stamp[], depth: GPUTexture | undefined, width: number, height: number, perspective: boolean) {
      if (stamps !== previous || depth !== previousDepth) {
        release();
        const scene = depth?.createView();
        for (const s of stamps) {
          const size = [s.image.width, s.image.height];
          const texture = device.createTexture({
            size,
            format: "rgba8unorm",
            usage:
              GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          device.queue.copyExternalImageToTexture(
            { source: s.image },
            { texture, premultipliedAlpha: true },
            size,
          );
          const params = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(params, 0, parameters(s, width, height, perspective));
          const ink = texture.createView();
          const group = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: params } },
              { binding: 1, resource: ink },
              // 置顶图标的着色分支不读取深度，复用图标视图来满足绑定布局。
              { binding: 2, resource: scene ?? ink },
              { binding: 3, resource: sampler },
            ],
          });
          entries.push({ texture, params, group });
        }
        previous = stamps;
        previousDepth = depth;
      }
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: [0, 0, 0, 0],
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      for (const { group } of entries) {
        pass.setBindGroup(0, group);
        pass.draw(4);
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    dispose() {
      release();
      ctx.unconfigure();
    },
  };
}
