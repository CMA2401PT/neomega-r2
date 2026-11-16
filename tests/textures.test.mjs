import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTextures, decodeTextures } from "../web/render/textures.js";
import { prepareRegion } from "../web/scene/prepare.js";

test("贴图上传保留六张图的格式、布局与 mip，并释放被替换的纹理", async () => {
  const calls = [], live = new Set();
  let serial = 0;
  const gl = new Proxy({
    createTexture() { const id = ++serial; live.add(id); return id; },
    deleteTexture(id) { live.delete(id); },
    getParameter() { return "program"; },
    getUniformLocation(program, name) { return null; },
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === key.toUpperCase()) return key === "TEXTURE0" ? 0 : key;
      return (...args) => calls.push([key, ...args]);
    },
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const data = await readFile(new URL("../assets/" + url, import.meta.url));
    return { arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), json: async () => JSON.parse(data) };
  };
  try {
    const uniforms = new Map(), textures = await createTextures(gl, uniforms, "");
    const arrays = calls.filter(([name]) => name === "texStorage3D");
    assert.deepEqual(arrays.map((c) => c.slice(2)), [
      [5, "SRGB8_ALPHA8", 16, 16, 563],
      [5, "RGBA8", 16, 16, 563],
      [5, "RGBA8", 16, 16, 563],
    ]);
    assert.equal(calls.filter(([name]) => name === "texSubImage3D").length, 15);
    const normals = calls.filter(([name]) => name === "texSubImage3D")[5].at(-1);
    assert.deepEqual([...normals.slice(0, 4)], [128, 128, 255, 255]);
    assert.equal(live.size, 10);
    const byteCount = textures.bytes;
    const files = new Map();
    for (const name of ["headers.bin", "fast.bin", "quad-records.bin", "surface-layers.bin", "surface-normals.bin", "surface-specular.bin", "atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin"])
      files.set(name, await (await fetch(name)).arrayBuffer());
    textures.install({ files, info: await (await fetch("textures-info.json")).json(), catalog: textures.catalog });
    assert.equal(live.size, 10);
    assert.equal(textures.bytes, byteCount);
    assert(!calls.some(([name, unit]) => name === "activeTexture" && unit === 15));
    textures.dispose();
    assert.equal(live.size, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("二进制快照按四字节边界解码，目录与图片来自同一响应", () => {
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
