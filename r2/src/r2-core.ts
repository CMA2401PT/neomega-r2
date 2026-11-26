export * from "./core.ts";
export { compileMaterialPack, type MaterialInput } from "./materials/import.ts";
export { openMaterialPack } from "./materials/archive.ts";
import { createRenderer as createDevice, type RendererOptions as EngineOptions } from "./render/webgpu.ts";

declare const R2_SHADERS: Record<string, string>;
export type MaterialSource = { assets: string } | { readResource: (name: string) => Promise<Response> };

export type RendererOptions = EngineOptions & MaterialSource;

/** 着色器随核心发布；宿主提供当前版本的材质目录或归档读取器。 */
export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions) {
  if (!options?.readResource && !options?.assets) throw Error("请用 assets 或 readResource 指定渲染材质");
  const readResource = async (name: string) => {
    if (Object.hasOwn(R2_SHADERS, name)) return new Response(R2_SHADERS[name]);
    if (options.readResource) return options.readResource(name);
    const response = await fetch(new URL(name, new URL(options.assets!, document.baseURI)));
    if (!response.ok) throw Error("无法加载材质 " + name + "：" + response.status);
    return response;
  };
  return createDevice(canvas, { ...options, readResource });
}
