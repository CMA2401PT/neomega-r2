import type { Camera, ObjectRegistry } from "neomega-r2-core";
import type { MinecraftSource } from "neomega-r2-mc";
import type { MaterialInput } from "neomega-r2-materials";
import type { SceneOverlay } from "../../layers/overlay-types.ts";

export type CameraPosition = Pick<Camera, "position"> & Partial<Omit<Camera, "position">>;
/** 场景由宿主提供；地图占用表可随场景切换。 */
export interface Scene {
  source: MinecraftSource;
  name?: string;
  camera?: CameraPosition;
  chunks?: () => ArrayBuffer | Promise<ArrayBuffer>;
  ocean?: number;
}
export interface MountOptions extends Scene {
  /** 从宿主选择的材质包读取一个渲染文件。 */
  readResource: (name: string) => Promise<Response>;
  /** 用户换材质时才加载同版本的合成配方。 */
  loadRecipe: (signal: AbortSignal) => Promise<Uint8Array>;
  actions?: HTMLElement;
  /** 宿主编写的帮助 HTML，显示在通用操作说明与“关于 neOmega R2”之间。 */
  helpHTML?: string;
  registry?: ObjectRegistry;
}
export interface Frontend {
  readonly overlay: SceneOverlay;
  setScene(scene: Scene): Promise<void>;
  moveCamera(camera: CameraPosition): void;
  setMaterialPack(input: MaterialInput, limit?: number): Promise<void>;
  dispose(): void;
}
