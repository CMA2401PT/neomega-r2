/// <reference types="@webgpu/types" />
import type { FrameOutput } from "neomega-r2-core";
import { createDenoisePass, type AccumulationFilter, type SuperResolution } from "./denoise.ts";
import type { LayerCamera, SceneLayer } from "./scene-layer.ts";
import { readTexture, rgbaToPNG } from "./readback.ts";
import { createWebSR } from "./websr.ts";

export interface PresentOptions {
  denoise?: AccumulationFilter;
  superResolution?: SuperResolution;
  displaySize?: { width: number; height: number };
  layers?: LayerCamera & { readonly items: readonly SceneLayer[] };
}

export interface ExportPNGOptions {
  denoise?: AccumulationFilter;
  superResolution?: SuperResolution;
  saveSuperResolution2x?: boolean;
}

const blitShader = `
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vert(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4f(p * 2.0 - 1.0, 0.0, 1.0), vec2f(p.x, 1.0 - p.y));
}
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn frag(v: V) -> @location(0) vec4f {
  return textureSampleLevel(img, smp, v.uv, 0.0);
}`;

/** 创建单画布后处理与深度混合合成器：串联降噪、WebSR 超分、深度测试叠加层与 PNG 导出。 */
export function createCompositor(device: GPUDevice, canvas: HTMLCanvasElement) {
  const format: GPUTextureFormat = "rgba8unorm";
  const ctx = canvas.getContext("webgpu");
  if (!ctx) throw Error("无法创建 WebGPU 画布");
  ctx.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
  });

  const denoisePass = createDenoisePass(device);
  const depthViews = new WeakMap<GPUTexture, GPUTextureView>();
  const blitModule = device.createShaderModule({ label: "R2 Blit", code: blitShader });
  const blitPipeline = device.createRenderPipeline({
    label: "R2 Blit",
    layout: "auto",
    vertex: { module: blitModule, entryPoint: "vert" },
    fragment: { module: blitModule, entryPoint: "frag", targets: [{ format }] },
  });
  const blitSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const blitBinds = new WeakMap<GPUTexture, GPUBindGroup>();

  let sr: ReturnType<typeof createWebSR> | undefined;
  let upscaledSource: GPUTexture | undefined;
  let upscaledKey = "";
  let lastPresented = "";
  let lastLayers: readonly SceneLayer[] = [];
  let lastColor: GPUTexture | undefined;
  let lastDepth: GPUTexture | null = null;

  function processFrame(
    enc: GPUCommandEncoder,
    frame: FrameOutput,
    denoise: AccumulationFilter,
    model: SuperResolution,
    targetSize: { width: number; height: number },
  ): GPUTexture {
    const filtered = denoisePass.apply(enc, frame.color, frame.revision, denoise);
    if (model === "off") {
      sr?.dispose();
      sr = undefined;
      upscaledSource = undefined;
      upscaledKey = "";
      return filtered;
    }
    if (!sr || sr.model !== model || sr.width !== frame.width || sr.height !== frame.height) {
      sr?.dispose();
      sr = createWebSR(device, model, frame.width, frame.height);
      upscaledSource = undefined;
      upscaledKey = "";
    }
    const key = `${frame.revision}:${denoise}`;
    const result = sr.image(enc, filtered, upscaledSource !== frame.color || upscaledKey !== key, targetSize);
    upscaledSource = frame.color;
    upscaledKey = key;
    return result;
  }

  function blitBind(texture: GPUTexture): GPUBindGroup {
    let bind = blitBinds.get(texture);
    if (!bind) {
      bind = device.createBindGroup({
        layout: blitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: "2d", baseArrayLayer: 0, arrayLayerCount: 1 }) },
          { binding: 1, resource: blitSampler },
        ],
      });
      blitBinds.set(texture, bind);
    }
    return bind;
  }

  return {
    format,
    get bytes() {
      return denoisePass.bytes + (sr?.bytes ?? 0);
    },
    present(frame: FrameOutput, options: PresentOptions = {}): boolean {
      const denoise = options.denoise ?? "off";
      const model = options.superResolution ?? "off";
      const layers = options.layers?.items.length ? options.layers : undefined;
      const targetSize = options.displaySize && (model !== "off" || layers)
        ? options.displaySize
        : { width: frame.width, height: frame.height };

      const key = JSON.stringify([
        frame.revision,
        frame.width,
        frame.height,
        denoise,
        model,
        targetSize.width,
        targetSize.height,
        layers && [layers.camera, layers.aspect, layers.cssWidth, layers.cssHeight, layers.items.map(layer => layer.revision)],
      ]);
      const items = layers?.items ?? [];
      if (key === lastPresented && frame.color === lastColor && frame.depth === lastDepth &&
          items.length === lastLayers.length && items.every((layer, i) => layer === lastLayers[i])) return false;
      lastPresented = key;
      lastLayers = [...items];
      lastColor = frame.color;
      lastDepth = frame.depth;

      if (canvas.width !== targetSize.width || canvas.height !== targetSize.height) {
        canvas.width = targetSize.width;
        canvas.height = targetSize.height;
      }

      const enc = device.createCommandEncoder();
      const image = processFrame(enc, frame, denoise, model, targetSize);
      const backbuffer = ctx!.getCurrentTexture();

      if (!layers && image.width === targetSize.width && image.height === targetSize.height) {
        enc.copyTextureToTexture({ texture: image }, { texture: backbuffer }, [targetSize.width, targetSize.height]);
      } else {
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view: backbuffer.createView(),
            loadOp: "clear",
            clearValue: [0, 0, 0, 1],
            storeOp: "store",
          }],
        });
        pass.setPipeline(blitPipeline);
        pass.setBindGroup(0, blitBind(image));
        pass.draw(3);
        if (layers) {
          let sceneDepth = frame.depth && depthViews.get(frame.depth);
          if (!sceneDepth && frame.depth) {
            sceneDepth = frame.depth.createView();
            depthViews.set(frame.depth, sceneDepth);
          }
          const view = { camera: layers.camera, aspect: layers.aspect, cssWidth: layers.cssWidth,
            cssHeight: layers.cssHeight, outputWidth: targetSize.width, outputHeight: targetSize.height,
            sceneDepth: sceneDepth ?? null };
          for (const layer of items) layer.draw(pass, view);
        }
        pass.end();
      }

      device.queue.submit([enc.finish()]);
      return true;
    },
    async renderToPNG(frame: FrameOutput, options: ExportPNGOptions = {}): Promise<Blob> {
      const denoise = options.denoise ?? "off";
      const model = options.superResolution ?? "off";
      const scale = model !== "off" && options.saveSuperResolution2x ? 2 : 1;
      const size = { width: frame.width * scale, height: frame.height * scale };
      if (Math.max(size.width, size.height) > device.limits.maxTextureDimension2D) {
        throw Error("PNG 的边长超过设备上限，请降低输出尺寸或关闭「保存 2× 超分原图」。");
      }
      const enc = device.createCommandEncoder();
      const image = processFrame(enc, frame, denoise, model, size);
      device.queue.submit([enc.finish()]);
      const rgba = await readTexture(device, image, 4);
      return rgbaToPNG(rgba, size.width, size.height);
    },
    dispose() {
      lastPresented = "";
      lastLayers = [];
      lastColor = undefined;
      lastDepth = null;
      upscaledSource = undefined;
      upscaledKey = "";
      sr?.dispose();
      sr = undefined;
      denoisePass.dispose();
      ctx!.unconfigure();
    },
  };
}

export type Compositor = ReturnType<typeof createCompositor>;
