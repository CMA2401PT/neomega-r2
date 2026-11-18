import { RegionDirectory, SIZE, mod } from "./region-directory.ts";
type Uniforms = Map<string, WebGLUniformLocation | null>;
export class WorldGPU extends RegionDirectory {
  gl: WebGL2RenderingContext;
  uniforms: Uniforms;
  info: WebGLTexture;
  tree: WebGLTexture;
  pool: WebGLTexture;
  constructor(gl: WebGL2RenderingContext, uniforms: Uniforms, { capacityWords = 64 * 1024 * 1024 } = {}) {
    super({ capacityWords });
    this.gl = gl;
    this.uniforms = uniforms;
    this.info = gl.createTexture();
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_3D, this.info);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA32UI, SIZE[0], SIZE[1], SIZE[2]);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tree = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.tree);
    gl.texStorage3D(gl.TEXTURE_3D, this.levels.length, gl.R32UI, SIZE[0], SIZE[1], SIZE[2]);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.pool = gl.createTexture();
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.pool);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, 4096, Math.ceil(capacityWords / 4096));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.bind();
  }
  bind(): void {
    const { gl, uniforms: u } = this;
    for (const [unit, target, texture, name] of [
      [1, gl.TEXTURE_3D, this.tree, "uTree"],
      [10, gl.TEXTURE_3D, this.info, "uSections"],
      [11, gl.TEXTURE_2D, this.pool, "uWorldData"],
    ] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, texture);
      gl.uniform1i(u.get(name) ?? null, unit);
    }
    gl.uniform3fv(u.get("uSize") ?? null, this.size);
    gl.uniform3iv(u.get("uDirectoryOffset") ?? null, [
      mod(this.origin[0], SIZE[0] * 16),
      0,
      mod(this.origin[2], SIZE[2] * 16),
    ]);
  }
  protected uploadWords(start: number, words: Uint32Array) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.pool);
    let offset = 0;
    while (offset < words.length) {
      const address = start + offset,
        x = address % 4096,
        y = Math.floor(address / 4096),
        width = x ? Math.min(4096 - x, words.length - offset) : Math.min(4096, words.length - offset),
        height = width === 4096 ? Math.max(1, Math.floor((words.length - offset) / 4096)) : 1,
        count = width * height;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x,
        y,
        width,
        height,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        words.subarray(offset, offset + count),
      );
      offset += count;
    }
  }
  protected uploadDirectory(
    section: boolean,
    level: number,
    low: number[],
    size: number[],
    data: Uint32Array,
  ) {
    const gl = this.gl;
    gl.activeTexture(section ? gl.TEXTURE10 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, section ? this.info : this.tree);
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      level,
      low[0],
      low[1],
      low[2],
      size[0],
      size[1],
      size[2],
      section ? gl.RGBA_INTEGER : gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      data,
    );
  }
  dispose(): void {
    for (const texture of [this.info, this.tree, this.pool]) this.gl.deleteTexture(texture);
    this.regions.clear();
  }
}
