import { WordAllocator } from "./allocator.js";
const MIXED = 0xffffffff,
  SIZE = [128, 32, 128],
  mod = (v, n) => ((v % n) + n) % n;

/** 世界目录使用循环坐标，移动窗口只更新边界区域，不搬动已有格子数据。 */
export class WorldGPU {
  constructor(gl, uniforms, { capacityWords = 64 * 1024 * 1024 } = {}) {
    this.gl = gl;
    this.uniforms = uniforms;
    this.origin = [0, -64, 0];
    this.size = [1536, 512, 1536];
    this.regions = new Map();
    this.allocator = new WordAllocator(capacityWords);
    this.sections = new Uint32Array(128 * 32 * 128 * 4);
    this.levels = [];
    let size = [...SIZE];
    while (true) {
      this.levels.push({
        size,
        data: new Uint32Array(size[0] * size[1] * size[2]),
      });
      if (size.every((v) => v === 1)) break;
      size = size.map((v) => Math.max(1, v / 2));
    }
    this.info = gl.createTexture();
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_3D, this.info);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA32UI, ...SIZE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tree = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.tree);
    gl.texStorage3D(gl.TEXTURE_3D, this.levels.length, gl.R32UI, ...SIZE);
    gl.texParameteri(
      gl.TEXTURE_3D,
      gl.TEXTURE_MIN_FILTER,
      gl.NEAREST_MIPMAP_NEAREST,
    );
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.pool = gl.createTexture();
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.pool);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      gl.R32UI,
      4096,
      Math.ceil(capacityWords / 4096),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.textureBytes =
      capacityWords * 4 +
      this.sections.byteLength +
      this.levels.reduce((sum, l) => sum + l.data.byteLength, 0);
    this.bind();
  }
  setWindow(origin, size) {
    this.origin = [...origin];
    this.size = [...size];
  }
  bind() {
    const { gl, uniforms: u } = this;
    for (const [unit, target, texture, name] of [
      [1, gl.TEXTURE_3D, this.tree, "uTree"],
      [10, gl.TEXTURE_3D, this.info, "uSections"],
      [11, gl.TEXTURE_2D, this.pool, "uWorldData"],
    ]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, texture);
      gl.uniform1i(u.get(name), unit);
    }
    gl.uniform3fv(u.get("uSize"), this.size);
    gl.uniform3iv(u.get("uDirectoryOffset"), [
      mod(this.origin[0], 2048),
      0,
      mod(this.origin[2], 2048),
    ]);
    gl.uniform1i(u.get("uTop"), 7);
  }
  /** 同一帧内先上传新地址，再发布目录，最后释放旧地址，避免看到一半的新区域。 */
  /** @param {import("../contracts.js").PreparedRegion} region */
  install(region) {
    const { gl } = this,
      key = region.key,
      old = this.regions.get(key),
      block = this.allocator.allocate(region.words.length),
      words = region.words;
    for (const index of region.relocations) words[index] += block.start;
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.pool);
    let offset = 0;
    while (offset < words.length) {
      const address = block.start + offset,
        x = address % 4096,
        y = Math.floor(address / 4096),
        width = x
          ? Math.min(4096 - x, words.length - offset)
          : Math.min(4096, words.length - offset),
        height =
          width === 4096
            ? Math.max(1, Math.floor((words.length - offset) / 4096))
            : 1,
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
    this.writeRegion(region, block.start);
    this.regions.set(key, {
      block,
      stats: region.stats,
      x: region.x,
      z: region.z,
    });
    if (old) this.allocator.release(old.block);
  }
  remove(key) {
    const region = this.regions.get(key);
    if (!region) return;
    this.writeRegion(
      {
        x: region.x,
        z: region.z,
        headers: new Uint32Array(),
        coarse: new Uint32Array(),
      },
      0,
    );
    this.regions.delete(key);
    this.allocator.release(region.block);
  }
  writeRegion(region, base) {
    const x = mod(region.x * 8, 128),
      z = mod(region.z * 8, 128),
      info = new Uint32Array(8 * 32 * 8 * 4),
      tags = new Uint32Array(8 * 32 * 8);
    // headers 按 [区内 section 编号, 压缩字地址, 调色板地址, 位宽, 层次地址] 排列。
    for (let i = 0; i < region.headers.length; i += 5) {
      const index = region.headers[i];
      info.set(
        [
          region.headers[i + 1] + base,
          region.headers[i + 2] + base,
          region.headers[i + 3],
          region.headers[i + 4] ? region.headers[i + 4] + base : 0,
        ],
        index * 4,
      );
      tags[index] = region.coarse[i / 5];
    }
    for (let dz = 0; dz < 8; dz++)
      for (let y = 0; y < 32; y++)
        for (let dx = 0; dx < 8; dx++) {
          const source = dx + 8 * (y + 32 * dz),
            target = x + dx + 128 * (y + 32 * (z + dz));
          this.sections.set(
            info.subarray(source * 4, source * 4 + 4),
            target * 4,
          );
          this.levels[0].data[target] = tags[source];
        }
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_3D, this.info);
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      x,
      0,
      z,
      8,
      32,
      8,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      info,
    );
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.tree);
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      x,
      0,
      z,
      8,
      32,
      8,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      tags,
    );
    let low = [x, 0, z],
      high = [x + 8, 32, z + 8];
    for (let l = 1; l < this.levels.length; l++) {
      low = low.map((v) => Math.floor(v / 2));
      high = high.map((v) => Math.ceil(v / 2));
      const prev = this.levels[l - 1],
        next = this.levels[l],
        extent = high.map((v, i) => v - low[i]),
        data = new Uint32Array(extent[0] * extent[1] * extent[2]);
      for (let z = low[2]; z < high[2]; z++)
        for (let y = low[1]; y < high[1]; y++)
          for (let x = low[0]; x < high[0]; x++) {
            let value =
              prev.data[x * 2 + prev.size[0] * (y * 2 + prev.size[1] * z * 2)];
            for (let dz = 0; dz < Math.min(2, prev.size[2]); dz++)
              for (let dy = 0; dy < Math.min(2, prev.size[1]); dy++)
                for (let dx = 0; dx < Math.min(2, prev.size[0]); dx++)
                  if (
                    prev.data[
                      x * 2 +
                        dx +
                        prev.size[0] *
                          (y * 2 + dy + prev.size[1] * (z * 2 + dz))
                    ] !== value
                  )
                    value = MIXED;
            next.data[x + next.size[0] * (y + next.size[1] * z)] = value;
            data[
              x - low[0] + extent[0] * (y - low[1] + extent[1] * (z - low[2]))
            ] = value;
          }
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        l,
        ...low,
        ...extent,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        data,
      );
    }
  }
  dispose() {
    for (const texture of [this.info, this.tree, this.pool])
      this.gl.deleteTexture(texture);
    this.regions.clear();
  }
}
