import { unzipSync } from "fflate";
import { buildTextures } from "./build.ts";
import type { MaterialDirectory } from "./import.ts";
import { unpackMaterials } from "./archive.ts";
import type { PackFiles } from "./tiles.ts";

/** 单次换包在独立线程完成，结束后释放解码图片、合成基表与中间层。 */
self.onmessage = async ({
  data,
}: MessageEvent<{ recipe: Uint8Array; input: File | MaterialDirectory | null; limit: number }>) => {
  try {
    const { input, limit } = data;
    let pack: PackFiles = {};
    if (input && "entries" in input) {
      for (const { file, path } of input.entries) pack[path] = new Uint8Array(await file.arrayBuffer());
    } else if (input) {
      pack = unzipSync(new Uint8Array(await input.arrayBuffer()), {
        filter: (entry) => /\.(png|json|mcmeta)$/i.test(entry.name),
      });
    }
    const set = buildTextures(unpackMaterials(data.recipe), pack, limit);
    self.postMessage({ set }, { transfer: [...set.files.values()] });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
