/// <reference types="@webgpu/types" />
import type { LayerView, SceneLayer } from "../compositor/scene-layer.ts";
import { sceneOcclusion } from "./scene-depth.ts";
import type { SceneMarks, Stamp } from "./scene-overlay.ts";

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

const wgsl = `
${sceneOcclusion}
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
    if(occluded(scene, v.screen, z)){discard;}
  }
  return color;
}`;

/** 在主合成通道内按深度测试与预乘透明度绘制 2D 标记图层。 */
export function createMarkLayer(device: GPUDevice, format: GPUTextureFormat, marks: SceneMarks): SceneLayer & { dispose(): void } {
  const fragment = GPUShaderStage.FRAGMENT;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | fragment, buffer: {} },
      { binding: 1, visibility: fragment, texture: {} },
      { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: fragment, sampler: {} },
    ],
  });
  const module = device.createShaderModule({ label: "R2 DepthOverlay", code: wgsl });
  const blend: GPUBlendComponent = { srcFactor: "one", dstFactor: "one-minus-src-alpha" };
  const pipeline = device.createRenderPipeline({
    label: "R2 DepthOverlay",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vert" },
    fragment: { module, entryPoint: "frag", targets: [{ format, blend: { color: blend, alpha: blend } }] },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const emptyDepth = device.createTexture({
    label: "R2 Empty Depth",
    size: [1, 1],
    format: "r32float",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  device.queue.writeTexture({ texture: emptyDepth }, new Float32Array([-1]), { bytesPerRow: 4 }, [1, 1]);
  const emptyDepthView = emptyDepth.createView();

  let entries: { texture: GPUTexture; params: GPUBuffer; group: GPUBindGroup }[] = [];
  let projection = "";
  let previousDepth: GPUTextureView | null | undefined;

  function release() {
    for (const { texture, params } of entries) {
      texture.destroy();
      params.destroy();
    }
    entries = [];
  }

  return {
    get revision() { return marks.version; },
    get needsSceneDepth() { return marks.needsDepth; },
    draw(pass: GPURenderPassEncoder, view: LayerView) {
      const { camera, cssWidth, cssHeight, aspect, sceneDepth } = view;
      const ratio = Math.min(devicePixelRatio, device.limits.maxTextureDimension2D / Math.max(cssWidth, cssHeight));
      const key = JSON.stringify([camera, marks.version, cssWidth, cssHeight, aspect, ratio]);
      if (projection !== key || previousDepth !== sceneDepth) {
        release();
        const stamps = marks.stamps(camera, cssWidth, cssHeight, ratio, !sceneDepth, aspect);
        for (const s of stamps) {
          const size = [s.image.width, s.image.height];
          const texture = device.createTexture({
            size,
            format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
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
          device.queue.writeBuffer(params, 0, parameters(s, cssWidth, cssHeight, camera.ortho === undefined));
          const group = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: params } },
              { binding: 1, resource: texture.createView() },
              { binding: 2, resource: sceneDepth ?? emptyDepthView },
              { binding: 3, resource: sampler },
            ],
          });
          entries.push({ texture, params, group });
        }
        projection = key;
        previousDepth = sceneDepth;
      }
      if (!entries.length) return;
      pass.setPipeline(pipeline);
      for (const { group } of entries) {
        pass.setBindGroup(0, group);
        pass.draw(4);
      }
    },
    dispose() {
      release();
      emptyDepth.destroy();
      previousDepth = undefined;
    },
  };
}
