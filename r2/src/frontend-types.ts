import type { Camera } from "./contracts.ts";
import type { DataSource } from "./session/session.ts";
import type { MaterialInput } from "./materials/import.ts";
import type { ObjectRegistry } from "./objects/registry.ts";

export type CameraPosition = Pick<Camera, "position"> & Partial<Omit<Camera, "position">>;
/** 场景由宿主提供；地图占用表可随场景切换。 */
export interface Scene {
  source: DataSource;
  name?: string;
  camera?: CameraPosition;
  chunks?: () => ArrayBuffer | Promise<ArrayBuffer>;
  ocean?: number;
}
export interface MountOptions extends Scene {
  actions?: HTMLElement;
  registry?: ObjectRegistry;
  useWebGPU?: boolean;
}
export interface Frontend {
  setScene(scene: Scene): Promise<void>;
  moveCamera(camera: CameraPosition): void;
  setMaterialPack(input: MaterialInput, limit?: number): Promise<void>;
  dispose(): void;
}
