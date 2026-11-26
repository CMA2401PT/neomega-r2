import test from "node:test";
import assert from "node:assert/strict";
import { defaultAssets } from "../scripts/default-assets.mjs";
import { loadTextureSet, decodeTextures, readTextureStream } from "../src/render/textures.ts";
import { materialTextures } from "../src/render/webgpu-resources.ts";
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

test("二进制快照按四字节边界解码，目录与图片来自同一响应", async () => {
  const encoder = new TextEncoder();
  const catalog = encoder.encode(JSON.stringify({ models: [{ kind: 3 }] }));
  const entries = [{ name: "catalog.json", length: catalog.length }, { name: "surface-normals.bin", length: 4 }];
  let header = JSON.stringify({ info: { side: 64, levels: 7 }, files: entries });
  while (encoder.encode(header).length % 4) header += " ";
  const json = encoder.encode(header), offset = 4 + json.length;
  const buffer = new ArrayBuffer(offset + Math.ceil(catalog.length / 4) * 4 + 4), bytes = new Uint8Array(buffer);
  new DataView(buffer).setUint32(0, json.length, true);
  bytes.set(json, 4); bytes.set(catalog, offset); bytes.set([32, 192, 77, 19], buffer.byteLength - 4);
  const set = decodeTextures(buffer);
  assert.equal(set.info.levels, 7);
  assert.equal(set.catalog.models[0].kind, 3);
  assert.deepEqual([...new Uint8Array(set.files.get("surface-normals.bin"))], [32, 192, 77, 19]);
  // 刻意跨越长度字段、文件边界和填充字节，覆盖网络分段与快照边界不同的情况。
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
      controller.close();
    },
  });
  assert.deepEqual(await readTextureStream(stream), set);
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
