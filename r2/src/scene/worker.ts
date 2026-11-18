import { decodeRegion, prepareRegion } from "./prepare.ts";
import type {
  Catalog,
  ObjectReference,
  PreparationCatalog,
  PreparedRegion,
  SourceRegion,
} from "../contracts.ts";

/** 主线程发给准备线程的消息。 */
export type WorkerRequest =
  | { type: "init"; catalog: Catalog; states: Uint32Array }
  | {
      type: "textures";
      catalog: Catalog;
      regions: Array<{ x: number; z: number }>;
      objects: ObjectReference[];
    }
  | { type: "put"; key: string; request: number; buffer: ArrayBuffer }
  | { type: "drop"; keys: string[] }
  | { type: "prepare"; request: number; x: number; z: number; objects: ObjectReference[] };

/** 准备线程的回复。 */
export type WorkerResponse =
  | { type: "initialized" }
  | { type: "textures"; results: PreparedRegion[] }
  | { type: "stored"; key: string; request: number }
  | { type: "prepared"; request: number; result: PreparedRegion }
  | { type: "error"; request?: number; key?: string; error: string };

// 只依赖 DOM 类型库；线程全局对象只用到这两项。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};
let catalogPromise: Promise<PreparationCatalog & Catalog>;
let states: Uint32Array = new Uint32Array();
const regions = new Map<string, SourceRegion>();
const transfers = (result: PreparedRegion) => [
  result.words.buffer as ArrayBuffer,
  result.headers.buffer as ArrayBuffer,
  result.relocations.buffer as ArrayBuffer,
];
scope.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      states = data.states;
      catalogPromise = Promise.resolve(data.catalog).then((catalog) => ({
        ...catalog,
        fragmentReach: Math.max(
          0,
          ...catalog.models.flatMap((m) =>
            (m.fragments || []).flatMap((p) => p.offset.map(Math.abs)),
          ),
        ),
      }));
      await catalogPromise;
      scope.postMessage({ type: "initialized" });
      return;
    }
    if (data.type === "textures") {
      const previous = await catalogPromise;
      const catalog = { ...data.catalog, fragmentReach: previous.fragmentReach };
      catalogPromise = Promise.resolve(catalog);
      const results = data.regions.map(({ x, z }) =>
        prepareRegion({ x, z, regions, catalog, objects: data.objects }),
      );
      scope.postMessage({ type: "textures", results }, results.flatMap(transfers));
      return;
    }
    if (data.type === "put") {
      regions.set(data.key, decodeRegion(data.buffer, states));
      scope.postMessage({ type: "stored", key: data.key, request: data.request });
      return;
    }
    if (data.type === "drop") {
      for (const key of data.keys) regions.delete(key);
      return;
    }
    if (data.type === "prepare") {
      const catalog = await catalogPromise,
        result = prepareRegion({ ...data, regions, catalog });
      scope.postMessage({ type: "prepared", request: data.request, result }, transfers(result));
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      request: "request" in data ? data.request : undefined,
      key: "key" in data ? data.key : undefined,
      error: String((error as Error)?.stack || error),
    });
  }
};
