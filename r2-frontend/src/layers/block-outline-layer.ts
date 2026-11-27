import { cameraBasis, cameraSpan } from "neomega-r2-core";
import type { LayerView, SceneLayer } from "../compositor/scene-layer.ts";
import type { OverlayItem, OverlayStyle } from "./overlay-types.ts";
import { blockOutlineShader } from "./block-outline-shader.ts";

interface BlockOutlineLayer extends SceneLayer {
  readonly size: number;
  blockOutline(position: readonly number[], style?: OverlayStyle): OverlayItem;
  clear(): void;
  dispose(): void;
}

/** 内容变化时批量上传方块实例。转动相机只更新投影参数，十二条边共用一次绘制。 */
export function createBlockOutlineLayer(device: GPUDevice, format: GPUTextureFormat): BlockOutlineLayer {
  const module = device.createShaderModule({ label: "R2 Block Outlines", code: blockOutlineShader });
  const blend: GPUBlendComponent = { srcFactor: "one", dstFactor: "one-minus-src-alpha" };
  const stride = 48;
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
  ] });
  const pipeline = device.createRenderPipeline({
    label: "R2 Block Outlines",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vert", buffers: [{
      arrayStride: stride, stepMode: "instance",
      attributes: [0, 1, 2].map(i => ({ shaderLocation: i, offset: i * 16, format: "float32x4" })),
    }] },
    fragment: { module, entryPoint: "frag", targets: [{ format, blend: { color: blend, alpha: blend } }] },
  });
  const uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const empty = device.createTexture({ size: [1, 1], format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING });
  const emptyView = empty.createView();
  const binds = new WeakMap<GPUTextureView, GPUBindGroup>();
  const tested = new Set<Float32Array>(), top = new Set<Float32Array>();
  const colors = new Map<string, number[]>();
  let colorContext: OffscreenCanvasRenderingContext2D | null = null;
  let revision = 0, uploaded = -1;
  let instances: GPUBuffer | undefined;

  /** 浏览器解析 CSS 颜色，只有首次遇到该颜色时读取一个像素。 */
  function rgba(css: string): number[] {
    let color = colors.get(css);
    if (!color) {
      colorContext ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = "#fff";
      colorContext.fillStyle = css;
      colorContext.fillRect(0, 0, 1, 1);
      color = Array.from(colorContext.getImageData(0, 0, 1, 1).data, channel => channel / 255);
      colors.set(css, color);
    }
    return color;
  }

  return {
    get revision() { return revision; },
    get size() { return tested.size + top.size; },
    get needsSceneDepth() { return tested.size > 0; },
    blockOutline(position, { stroke = "#fff", strokeWidth = 2, alwaysVisible = false } = {}) {
      // 分开存高位和余数，在大坐标处也能保留相机与格角间的小数距离。
      const high = position.map(Math.fround);
      const values = new Float32Array([...high, strokeWidth, ...position.map((value, axis) => value - high[axis]),
        Number(!alwaysVisible), ...rgba(stroke)]);
      const group = alwaysVisible ? top : tested;
      if (strokeWidth !== 0) { group.add(values); revision++; }
      return {
        remove() {
          if (!group.delete(values)) return;
          revision++;
          if (tested.size + top.size === 0) {
            instances?.destroy();
            instances = undefined;
          }
        },
      };
    },
    draw(pass: GPURenderPassEncoder, view: LayerView) {
      const count = tested.size + top.size;
      const first = view.sceneDepth ? 0 : tested.size;
      if (count === first) return;
      if (uploaded !== revision) {
        const data = new Float32Array(count * stride / 4);
        let offset = 0;
        for (const group of [tested, top]) for (const entry of group) {
          data.set(entry, offset);
          offset += entry.length;
        }
        if (!instances || instances.size < data.byteLength) {
          instances?.destroy();
          instances = device.createBuffer({ label: "R2 Outline Instances", size: 2 ** Math.ceil(Math.log2(data.byteLength)),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        }
        device.queue.writeBuffer(instances, 0, data);
        uploaded = revision;
      }
      const { camera, cssWidth, cssHeight, outputWidth, outputHeight } = view;
      const { right, up, forward } = cameraBasis(camera);
      const span = cameraSpan(camera);
      const high = camera.position.map(Math.fround);
      const params = new Float32Array([...high, 0, ...camera.position.map((value, axis) => value - high[axis]), 0,
        ...right, 1 / (span * view.aspect), ...up, 1 / span, ...forward, Number(camera.ortho === undefined),
        cssWidth, cssHeight, outputWidth, outputHeight]);
      device.queue.writeBuffer(uniform, 0, params);
      const depth = view.sceneDepth ?? emptyView;
      let group = binds.get(depth);
      if (!group) {
        group = device.createBindGroup({ layout, entries: [
          { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: depth },
        ] });
        binds.set(depth, group);
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, instances!);
      pass.draw(12 * 6, count - first, 0, first);
    },
    clear() {
      tested.clear();
      top.clear();
      colors.clear();
      revision++;
      instances?.destroy();
      instances = undefined;
    },
    dispose() {
      this.clear();
      uniform.destroy();
      empty.destroy();
    },
  };
}
