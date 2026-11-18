import type { Catalog } from "../contracts.ts";
import { voxelColors } from "./voxels.ts";

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
type Uniforms = Map<string, WebGLUniformLocation | null>;
const binaryNames = [
  "headers.bin", "fast.bin", "quad-records.bin",
  "surface-layers.bin", "surface-normals.bin", "surface-specular.bin",
  "atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin",
];

/** 一次响应包含图片及派生表，读取结束后才允许替换 GPU 资源。 */
export function decodeTextures(buffer: ArrayBuffer): TextureSet {
  const length = new DataView(buffer).getUint32(0, true),
    decoder = new TextDecoder(),
    header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, length))),
    files = new Map<string, ArrayBuffer>();
  let offset = 4 + length;
  for (const { name, length } of header.files as Array<{ name: string; length: number }>) {
    files.set(name, buffer.slice(offset, offset + length));
    offset += Math.ceil(length / 4) * 4;
  }
  return { info: header.info, files, catalog: JSON.parse(decoder.decode(files.get("catalog.json")!)) };
}

/** 共享表和三通道贴图使用固定纹理单元；所有上传集中在这里。 */
export async function createTextures(
  gl: WebGL2RenderingContext,
  uniforms: Uniforms,
  assets: string,
  readResource = (name: string) => fetch(assets + name),
) {
  const program = gl.getParameter(gl.CURRENT_PROGRAM);
  for (const name of ["uSurfaceNormals", "uSurfaceSpecular", "uAtlasNormals", "uAtlasSpecular"])
    uniforms.set(name, gl.getUniformLocation(program, name));
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
  const handles = new Map<string, WebGLTexture>();
  let bytes = 0, referenceBytes = 0;
  function texture(unit: number, target: number, name: string): void {
    gl.deleteTexture(handles.get(name) ?? null);
    const handle = gl.createTexture();
    handles.set(name, handle);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, handle);
    gl.uniform1i(uniforms.get(name) ?? null, unit);
  }
  function table(unit: number, name: string, buffer: ArrayBuffer | undefined, integer: boolean): void {
    if (!buffer) throw Error("材质数据缺少 " + name);
    const Input = integer ? Uint32Array : Float32Array,
      width = 2048, height = Math.max(1, Math.ceil(buffer.byteLength / 16 / width)),
      data = new Input(width * height * 4);
    data.set(new Input(buffer));
    texture(unit, gl.TEXTURE_2D, name);
    gl.texImage2D(gl.TEXTURE_2D, 0, integer ? gl.RGBA32UI : gl.RGBA32F,
      width, height, 0, integer ? gl.RGBA_INTEGER : gl.RGBA,
      integer ? gl.UNSIGNED_INT : gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    bytes += data.byteLength;
  }
  function install(set: TextureSet): void {
    bytes = referenceBytes;
    table(2, "uModels", set.files.get("headers.bin"), true);
    table(3, "uQuadRecords", set.files.get("quad-records.bin"), false);
    table(4, "uFast", set.files.get("fast.bin"), false);
    const { side, levels, layers, atlasWidth, atlasHeight } = set.info;
    for (const [unit, name, file, color] of [
      [6, "uSurfaces", "surface-layers.bin", true],
      [7, "uSurfaceNormals", "surface-normals.bin", false],
      [9, "uSurfaceSpecular", "surface-specular.bin", false],
    ] as const) {
      texture(unit, gl.TEXTURE_2D_ARRAY, name);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, color ? gl.SRGB8_ALPHA8 : gl.RGBA8, side, side, layers);
      const data = new Uint8Array(set.files.get(file)!);
      let offset = 0;
      for (let level = 0; level < levels; level++) {
        const size = side >> level, length = size * size * 4 * layers;
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, 0, size, size, layers,
          gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(offset, offset + length));
        offset += length;
      }
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      bytes += data.byteLength;
    }
    // 字节上传绕过浏览器图片解码的色彩管理；图集颜色仍由着色器转线性。
    for (const [unit, name, file] of [
      [5, "uAtlas", "atlas-color.bin"],
      [0, "uAtlasNormals", "atlas-normals.bin"],
      [14, "uAtlasSpecular", "atlas-specular.bin"],
    ] as const) {
      texture(unit, gl.TEXTURE_2D, name);
      const data = new Uint8Array(set.files.get(file)!);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlasWidth, atlasHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bytes += data.byteLength;
    }
    Object.assign(catalog, set.catalog);
    // 体素档的代表色随材质包一起换。
    table(18, "uVoxels", voxelColors({
      catalog: set.catalog,
      info: set.info,
      fast: set.files.get("fast.bin")!,
      references: files.get("quad-references.bin")!,
      records: set.files.get("quad-records.bin")!,
      surfaces: set.files.get("surface-layers.bin")!,
      surfaceSpecular: set.files.get("surface-specular.bin")!,
      atlas: set.files.get("atlas-color.bin")!,
      atlasSpecular: set.files.get("atlas-specular.bin")!,
    }).buffer, false);
  }
  table(8, "uQuadReferences", files.get("quad-references.bin"), true);
  referenceBytes = bytes;
  install({ info, files, catalog });
  return {
    catalog, states, install,
    get bytes() { return bytes; },
    dispose() { for (const handle of handles.values()) gl.deleteTexture(handle); },
  };
}
