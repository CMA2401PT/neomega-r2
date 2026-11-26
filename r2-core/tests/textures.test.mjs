import test from "node:test";
import assert from "node:assert/strict";
import { defaultAssets } from "../../assets-utils/scripts/default-assets.mjs";
import { loadTextureSet } from "../src/render/textures.ts";
import { materialTextures } from "../src/render/resources.ts";
import { prepareRegion } from "../src/scene/prepare.ts";

test("WebGPU 材质保留面贴图的格式、布局与 mip，并在释放时销毁所有纹理", async (t) => {
  const set = await loadTextureSet(async (name) => new Response(defaultAssets.readFile("assets/" + name)));
  const textures = [], writes = [];
  // Node 没有浏览器的 GPU 设备。记录生产代码提交的纹理描述和上传数据。
  const previous = Object.getOwnPropertyDescriptor(globalThis, "GPUTextureUsage");
  if (!previous) {
    globalThis.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };
    t.after(() => { delete globalThis.GPUTextureUsage; });
  }
  const device = {
    createTexture({ size: [width, height, depthOrArrayLayers], format, mipLevelCount }) {
      const texture = {
        width, height, depthOrArrayLayers, format, mipLevelCount, destroyed: false,
        createView() { return texture; },
        destroy() { this.destroyed = true; },
      };
      textures.push(texture);
      return texture;
    },
    queue: { writeTexture(target, data, layout, size) { writes.push({ ...target, data, size }); } },
  };
  const materials = materialTextures(device, set, set.files.get("quad-references.bin"));
  const { side, levels, layers } = set.info;
  const tiles = textures.filter((texture) => texture.mipLevelCount > 1);
  assert.deepEqual(tiles.map((t) => t.format), ["rgba8unorm-srgb", "rgba8unorm", "rgba8unorm"]);
  for (const [i, texture] of tiles.entries()) {
    const uploads = writes.filter((w) => w.texture === texture);
    assert.equal(uploads.length, levels);
    const source = new Uint8Array(set.files.get(["surface-layers.bin", "surface-specular.bin", "surface-normals.bin"][i]));
    let offset = 0;
    for (const { size, data, mipLevel } of uploads) {
      const w = side >> mipLevel;
      assert.deepEqual(size, [2 * w, 2 * w, Math.ceil(layers / 4)]);
      // 第一层中的第二张面贴图紧邻第一张，两者在来源文件中分别连续存放。
      assert.deepEqual(data.subarray(w * 4, w * 4 + 4), source.subarray(offset + w * w * 4, offset + w * w * 4 + 4));
      offset += layers * w * w * 4;
    }
  }
  materials.dispose();
  assert(textures.every((texture) => texture.destroyed));
});

test("同一份存档缓存遇到新透明孔时解除均匀合并，恢复原版后重新合并", () => {
  const regions = new Map([["0/0", { unknown: 0, sections: [{ position: [0, 0, 0], bits: 0, palette: new Uint32Array([1]), words: new Uint32Array() }] }]]);
  const catalog = { fragmentReach: 0, models: [{ kind: 0 }, { kind: 1 }] };
  const prepare = () => prepareRegion({ x: 0, z: 0, regions, catalog, objects: [] });
  assert.equal(prepare().headers[6], 1);
  catalog.models[1].kind = 3;
  assert.equal(prepare().headers[6], 0xffffffff);
  catalog.models[1].kind = 1;
  assert.equal(prepare().headers[6], 1);
});
