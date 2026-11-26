import { unzipSync } from "fflate";
import type { PackFiles } from "./tiles.ts";

/** 两个 R2 归档都在 assets/ 下按相同文件名保存，可交给不同的材质版本使用。 */
export function unpackMaterials(bytes: Uint8Array): PackFiles {
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([path, data]) => [path.slice("assets/".length), data]),
  );
}

/** 将调用者选择的默认材质包接到 createRenderer 的 readResource 参数。 */
export function openMaterialPack(bytes: Uint8Array): (name: string) => Promise<Response> {
  const files = unpackMaterials(bytes);
  return async (name) => {
    if (!files[name]) throw Error("材质包缺少 " + name);
    return new Response(new Blob([files[name] as Uint8Array<ArrayBuffer>]));
  };
}
