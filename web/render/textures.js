/** @typedef {{side:number,levels:number,layers:number,atlasWidth:number,atlasHeight:number}} TextureInfo */
/** @typedef {{kind:number,offset:number,count:number,group:number,fragments?:Array<{offset:number[],model:number}>}} Model */
/** @typedef {{models:Model[],states:Record<string,number>,statistics:Record<string,number>,unsupported:string[]}} Catalog */
/** @typedef {{info:TextureInfo,files:Map<string,ArrayBuffer>,catalog:Catalog}} TextureSet */
const binaryNames = [
  "headers.bin", "fast.bin", "quad-records.bin",
  "surface-layers.bin", "surface-normals.bin", "surface-specular.bin",
  "atlas-color.bin", "atlas-normals.bin", "atlas-specular.bin",
];

/** 一次响应包含图片及派生表，读取结束后才允许替换 GPU 资源。
 * @param {ArrayBuffer} buffer @returns {TextureSet}
 */
export function decodeTextures(buffer) {
  const length = new DataView(buffer).getUint32(0, true),
    decoder = new TextDecoder(),
    header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, length))),
    files = new Map();
  let offset = 4 + length;
  for (const { name, length } of header.files) {
    files.set(name, buffer.slice(offset, offset + length));
    offset += Math.ceil(length / 4) * 4;
  }
  return { info: header.info, files, catalog: JSON.parse(decoder.decode(files.get("catalog.json"))) };
}

/** 共享表和三通道贴图使用固定纹理单元；所有上传集中在这里。
 * @param {WebGL2RenderingContext} gl
 * @param {Map<string,WebGLUniformLocation|null>} uniforms
 * @param {string} assets
 */
export async function createTextures(gl, uniforms, assets) {
  const program = gl.getParameter(gl.CURRENT_PROGRAM);
  for (const name of ["uSurfaceNormals", "uSurfaceSpecular", "uAtlasNormals", "uAtlasSpecular"])
    uniforms.set(name, gl.getUniformLocation(program, name));
  const files = new Map(await Promise.all(
    [...binaryNames, "quad-references.bin"].map(async (name) =>
      [name, await (await fetch(assets + name)).arrayBuffer()],
    ),
  ));
  const [info, catalog] = await Promise.all(
    ["textures-info.json", "catalog.json"].map(async (name) => (await fetch(assets + name)).json()),
  );
  const handles = new Map();
  let bytes = 0, referenceBytes = 0;
  /** @param {number} unit @param {number} target @param {string} name */
  function texture(unit, target, name) {
    gl.deleteTexture(handles.get(name));
    const handle = gl.createTexture();
    handles.set(name, handle);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, handle);
    gl.uniform1i(uniforms.get(name), unit);
  }
  /** @param {number} unit @param {string} name @param {ArrayBuffer} buffer @param {boolean} integer */
  function table(unit, name, buffer, integer) {
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
  /** @param {TextureSet} set */
  function install(set) {
    bytes = referenceBytes;
    table(2, "uModels", set.files.get("headers.bin"), true);
    table(3, "uQuadRecords", set.files.get("quad-records.bin"), false);
    table(4, "uFast", set.files.get("fast.bin"), false);
    const { side, levels, layers, atlasWidth, atlasHeight } = set.info;
    for (const [unit, name, file, color] of [
      [6, "uSurfaces", "surface-layers.bin", true],
      [7, "uSurfaceNormals", "surface-normals.bin", false],
      [9, "uSurfaceSpecular", "surface-specular.bin", false],
    ]) {
      texture(unit, gl.TEXTURE_2D_ARRAY, name);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, color ? gl.SRGB8_ALPHA8 : gl.RGBA8, side, side, layers);
      const data = new Uint8Array(set.files.get(file));
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
    ]) {
      texture(unit, gl.TEXTURE_2D, name);
      const data = new Uint8Array(set.files.get(file));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlasWidth, atlasHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bytes += data.byteLength;
    }
    Object.assign(catalog, set.catalog);
  }
  table(8, "uQuadReferences", files.get("quad-references.bin"), true);
  referenceBytes = bytes;
  install({ info, files, catalog });
  return {
    catalog, install,
    get bytes() { return bytes; },
    dispose() { for (const handle of handles.values()) gl.deleteTexture(handle); },
  };
}
