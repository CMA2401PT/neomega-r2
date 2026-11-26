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

interface TextureHeader {
  info: TextureInfo;
  files: Array<{ name: string; length: number }>;
}

/** 边接收边将快照拆进最终的文件缓冲，大材质包无需分配整份响应的连续内存。 */
export async function readTextureStream(stream: ReadableStream<Uint8Array>): Promise<TextureSet> {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  async function readBytes(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (!chunk.length) {
        const next = await reader.read();
        if (next.done) throw Error("材质数据传输中断");
        chunk = next.value;
      }
      const count = Math.min(length - offset, chunk.length);
      bytes.set(chunk.subarray(0, count), offset);
      chunk = chunk.subarray(count);
      offset += count;
    }
    return bytes;
  }
  try {
    const decoder = new TextDecoder();
    const size = new DataView((await readBytes(4)).buffer).getUint32(0, true);
    const header: TextureHeader = JSON.parse(decoder.decode(await readBytes(size)));
    const files = new Map<string, ArrayBuffer>();
    for (const { name, length } of header.files) {
      files.set(name, (await readBytes(length)).buffer);
      await readBytes((4 - length % 4) % 4);
    }
    return { info: header.info, files, catalog: JSON.parse(decoder.decode(files.get("catalog.json")!)) };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** 一次响应包含图片及派生表，读取结束后才允许替换 GPU 资源。 */
export function decodeTextures(buffer: ArrayBuffer): TextureSet {
  const length = new DataView(buffer).getUint32(0, true),
    decoder = new TextDecoder(),
    header: TextureHeader = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, length))),
    files = new Map<string, ArrayBuffer>();
  let offset = 4 + length;
  for (const { name, length } of header.files) {
    files.set(name, buffer.slice(offset, offset + length));
    offset += Math.ceil(length / 4) * 4;
  }
  return { info: header.info, files, catalog: JSON.parse(decoder.decode(files.get("catalog.json")!)) };
}

export async function loadTextureSet(readResource:(name:string)=>Promise<Response>) {
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
  return {files,info,catalog,states};
}
