import type { TextureSet } from "neomega-r2-core";

declare const R2_MATERIAL_WORKER: string | undefined;

/** 目录文件要连同相对路径传给 Worker；同名贴图可能属于不同命名空间。 */
export interface MaterialDirectory {
  name: string;
  entries: { path: string; file: File }[];
}
export type MaterialInput = File | File[] | MaterialDirectory | null;

/** 浏览器选择的目录可以直接传给合成器，保存选择时也可用这个结构保留目录层次。 */
export function materialDirectory(files: File[]): MaterialDirectory {
  return {
    name: files[0].webkitRelativePath.split("/")[0],
    entries: files
      .filter((file) => /\.(png|json|mcmeta)$/i.test(file.name))
      .map((file) => ({
        path: file.webkitRelativePath.split("/").slice(1).join("/"),
        file,
      })),
  };
}

/** 用调用者提供的合成信息包与 ZIP 或目录生成整套替换材质。null 表示重新合成原版。 */
export async function compileMaterialPack(
  recipe: Uint8Array,
  input: MaterialInput,
  limit = 128,
  signal?: AbortSignal,
): Promise<TextureSet> {
  signal?.throwIfAborted();
  let codeURL: string | undefined;
  let worker: Worker;
  if (typeof R2_MATERIAL_WORKER !== "undefined") {
    codeURL = URL.createObjectURL(new Blob([R2_MATERIAL_WORKER], { type: "text/javascript" }));
    worker = new Worker(codeURL);
  } else {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  }
  let abort: (() => void) | undefined;
  try {
    return await new Promise<TextureSet>((resolve, reject) => {
      abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onerror = (e) => reject(Error(e.message));
      worker.onmessage = ({ data }) => (data.error ? reject(Error(data.error)) : resolve(data.set));
      worker.postMessage({ input: Array.isArray(input) ? materialDirectory(input) : input, limit, recipe });
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    worker.terminate();
    if (codeURL) URL.revokeObjectURL(codeURL);
  }
}
