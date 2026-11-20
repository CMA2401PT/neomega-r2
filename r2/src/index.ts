// R2 渲染核心的公开入口；宿主只从这里导入。
export {
  createRenderer,
  type RendererOptions,
  type LightingOptions,
  type AccumulationFilter,
  type DrawOptions,
  type PhotoOptions,
  type Tier,
  type PreviewTier,
} from "./render/renderer.ts";
export { decodeTextures, readTextureStream, type TextureSet, type TextureInfo } from "./render/textures.ts";
export { cameraBasis, cameraRay, PERSPECTIVE_SPAN } from "./render/camera.ts";
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

import type { createRenderer } from "./render/renderer.ts";
export type Renderer = Awaited<ReturnType<typeof createRenderer>>;
export {
  r2linkSource,
  encodeMessage,
  decodeMessage,
  R2LINK_VERSION,
  type R2LinkSource,
  type R2LinkOptions,
  type R2LinkState,
  type R2LinkWelcome,
  type R2LinkScene,
  type R2LinkCamera,
} from "./source/r2link.ts";
