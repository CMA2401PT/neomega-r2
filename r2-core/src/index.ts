// R2 渲染核心的公开入口。
export {
  createRenderer,
  type Renderer,
  type CaptureSession,
  type RendererOptions,
  type LightingOptions,
  type RenderOptions,
  type CaptureOptions,
  type Tier,
  type PreviewTier,
} from "./render/renderer.ts";
export { loadTextureSet, type TextureSet, type TextureInfo } from "./render/textures.ts";
export { cameraBasis, cameraRay, cameraSpan, PERSPECTIVE_SPAN } from "./render/camera.ts";
export { ObjectRegistry } from "./objects/registry.ts";
export { enchantingBook } from "./effects/enchanting-book.ts";
export { regionKey, decodeRegion, modelOf, unpack } from "./scene/prepare.ts";
export {
  WorldSession,
  type DataSource,
  type WorldSink,
  type WantChange,
  type RegionCoord,
  type ObjectWant,
  type Focus,
  type SessionOptions,
  type SessionStats,
} from "./session/session.ts";
export { blockHash, AIR } from "./source/hash.ts";
export { MemoryWorld, memorySource, encodeRegion, type SectionBlocks } from "./source/memory.ts";
export type * from "./contracts.ts";
export type { WorkerRequest, WorkerResponse } from "./scene/worker.ts";
