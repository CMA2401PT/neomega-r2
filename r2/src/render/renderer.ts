import { createWebGLRenderer } from "./webgl.ts";
import { createWebGPURenderer } from "./webgpu.ts";
import type { RendererOptions } from "./options.ts";
export type * from "./options.ts";
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions & { useWebGPU: false },
): ReturnType<typeof createWebGLRenderer>;
export function createRenderer(
  canvas: HTMLCanvasElement,
  options?: RendererOptions,
): Promise<
  Awaited<ReturnType<typeof createWebGLRenderer>> | Awaited<ReturnType<typeof createWebGPURenderer>>
>;
export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
  return options.useWebGPU === false
    ? createWebGLRenderer(canvas, options)
    : createWebGPURenderer(canvas, options);
}
