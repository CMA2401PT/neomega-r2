/// <reference types="@webgpu/types" />
/** 输出画面可用的 2× 超分模型。 */
export type SuperResolution = "off" | "cnn-xs" | "cnn-s";
export type AccumulationFilter = "off" | "light" | "medium" | "high";

/** 固定取周围一圈像素。档位越高，参与平均的色差范围和平均色的占比越大。 */
export const filterParameters = {
  light: { colorSigma: 4, blend: 0.65 },
  medium: { colorSigma: 8, blend: 0.82 },
  high: { colorSigma: 16, blend: 1 },
} as const;

const shader = `
@vertex fn vert(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0, 1);
}
@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var<uniform> filterParams: vec2f;
@fragment fn denoise(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let center = textureLoad(img, p, 0).rgb;
  let edge = vec2i(textureDimensions(img)) - 1;
  var sum = center;
  var total = 1.;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) { continue; }
      let color = textureLoad(img, clamp(p + vec2i(x, y), vec2i(0), edge), 0).rgb;
      let delta = (color - center) * (255. / filterParams.x);
      let weight = exp(-.5 * (f32(x * x + y * y) / (.85 * .85) + dot(delta, delta) / 3.));
      sum += color * weight;
      total += weight;
    }
  }
  return vec4f(mix(center, sum / total, filterParams.y), 1.);
}`;

export function createDenoisePass(device: GPUDevice) {
  const module = device.createShaderModule({ label: "R2 Denoise", code: shader });
  const pipeline = device.createRenderPipeline({
    label: "R2 Denoise",
    layout: "auto",
    vertex: { module, entryPoint: "vert" },
    fragment: { module, entryPoint: "denoise", targets: [{ format: "rgba8unorm" }] },
  });
  const params = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let output: GPUTexture | undefined;
  let outputView: GPUTextureView | undefined;
  const binds = new WeakMap<GPUTexture, GPUBindGroup>();
  let lastSource: GPUTexture | undefined;
  let lastRevision = -1;
  let lastLevel: AccumulationFilter = "off";

  return {
    get bytes() {
      return output ? output.width * output.height * 4 : 0;
    },
    apply(enc: GPUCommandEncoder, source: GPUTexture, revision: number, level: AccumulationFilter): GPUTexture {
      if (level === "off") return source;
      if (!output || output.width !== source.width || output.height !== source.height) {
        output?.destroy();
        output = device.createTexture({
          label: "R2 Denoise Output",
          size: [source.width, source.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        });
        outputView = output.createView();
        lastRevision = -1;
      }
      if (lastLevel !== level) {
        const { colorSigma, blend } = filterParameters[level];
        device.queue.writeBuffer(params, 0, new Float32Array([colorSigma, blend]));
        lastLevel = level;
        lastRevision = -1;
      }
      if (lastSource !== source || lastRevision !== revision) {
        let bind = binds.get(source);
        if (!bind) {
          bind = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: source.createView() },
              { binding: 1, resource: { buffer: params } },
            ],
          });
          binds.set(source, bind);
        }
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: outputView!, loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        lastSource = source;
        lastRevision = revision;
      }
      return output;
    },
    dispose() {
      output?.destroy();
      output = undefined;
      outputView = undefined;
      params.destroy();
    },
  };
}
