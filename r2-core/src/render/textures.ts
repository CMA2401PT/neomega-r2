import type { Catalog } from "../contracts.ts";

export interface TextureInfo {
  side: number;
  levels: number;
  layers: number;
  atlasWidth: number;
  atlasHeight: number;
}
export type { Catalog, Model } from "../contracts.ts";
export interface TextureSet {
  info: TextureInfo;
  files: Map<string, ArrayBuffer>;
  catalog: Catalog;
}
const binaryNames = [
  "headers.bin", "fast.bin", "quad-records.bin",
  "surface-layers.bin", "surface-normals.bin", "surface-specular.bin",
  "atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin",
];

export async function loadTextureSet(readResource: (name: string) => Promise<Response>) {
  const files = new Map(await Promise.all(
    [...binaryNames, "quad-references.bin"].map(async (name) =>
      [name, await (await readResource(name)).arrayBuffer()] as const,
    ),
  ));
  const [info, catalog] = (await Promise.all(
    ["textures-info.json", "catalog.json"].map(async (name) => (await readResource(name)).json()),
  )) as [TextureInfo, Catalog];
  // 方块哈希到模型的表与材质无关，换材质包时保留。
  const states = new Uint32Array(await (await readResource("states.bin")).arrayBuffer());
  return { files, info, catalog, states };
}
