import { WordAllocator, type WordBlock } from "./allocator.ts";
import type { PreparedRegion, RegionStatistics } from "../contracts.ts";

type Uniforms = Map<string, WebGLUniformLocation | null>;
interface InstalledRegion {
  block: WordBlock;
  stats: RegionStatistics;
  x: number;
  z: number;
}
const MIXED = 0xffffffff,
  // 目录覆盖 256×32×256 个 section，即 4096×512×4096 方块，可容纳半径 96 区块的窗口与对齐余量。
  SIZE = [256, 32, 256],
  mod = (v: number, n: number) => ((v % n) + n) % n;

/** 世界目录使用循环坐标，移动窗口只更新边界区域，不搬动已有格子数据。 */
export class WorldGPU {
  gl: WebGL2RenderingContext;
  uniforms: Uniforms;
  origin: number[];
  size: number[];
  regions: Map<string, InstalledRegion>;
  version: number;
  allocator: WordAllocator;
  sections: Uint32Array;
  levels: Array<{ size: number[]; data: Uint32Array }>;
  info: WebGLTexture;
  tree: WebGLTexture;
  pool: WebGLTexture;
  textureBytes: number;
  constructor(
    gl: WebGL2RenderingContext,
    uniforms: Uniforms,
    { capacityWords = 64 * 1024 * 1024 }: { capacityWords?: number } = {},
  ) {
    this.gl = gl;
    this.uniforms = uniforms;
    this.origin = [0, -64, 0];
    this.size = [1536, 512, 1536];
    this.regions = new Map();
    // 每次目录或窗口变化加一，宿主据此判断静止画面是否需要重画。
    this.version = 0;
    this.allocator = new WordAllocator(capacityWords);
    this.sections = new Uint32Array(SIZE[0] * SIZE[1] * SIZE[2] * 4);
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
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA32UI, SIZE[0], SIZE[1], SIZE[2]);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tree = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.tree);
    gl.texStorage3D(gl.TEXTURE_3D, this.levels.length, gl.R32UI, SIZE[0], SIZE[1], SIZE[2]);
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
  setWindow(origin: number[], size: number[]): void {
    this.origin = [...origin];
    this.size = [...size];
    this.version++;
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
  /** 同一帧内先上传新地址，再发布目录，最后释放旧地址，避免看到一半的新区域。 */
  install(region: PreparedRegion): void {
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
    this.version++;
  }
  remove(key: string): void {
    const region = this.regions.get(key);
    if (!region) return;
    this.writeRegion(
      {
        x: region.x,
        z: region.z,
        headers: new Uint32Array(),
      },
      0,
    );
    this.regions.delete(key);
    this.allocator.release(region.block);
    this.version++;
  }
  writeRegion(region: { x: number; z: number; headers: Uint32Array }, base: number): void {
    const x = mod(region.x * 8, SIZE[0]),
      z = mod(region.z * 8, SIZE[2]),
      info = new Uint32Array(8 * 32 * 8 * 4),
      tags = new Uint32Array(8 * 32 * 8);
    // 目录项为 [附加块地址, 压缩字地址 | 位宽 << 27, 小块掩码低位, 高位]；均匀 section 为 [0, 编号, 0, 0]。
    // 射线进入 section 时只读这一项，就能判断空小块并找到调色板。
    for (let i = 0; i < region.headers.length; i += 7) {
      const h = region.headers,
        index = h[i];
      info.set(
        h[i + 1]
          ? [h[i + 1] + base, ((h[i + 2] + base) | (h[i + 3] << 27)) >>> 0, h[i + 4], h[i + 5]]
          : [0, h[i + 6], 0, 0],
        index * 4,
      );
      tags[index] = h[i + 6];
    }
    for (let dz = 0; dz < 8; dz++)
      for (let y = 0; y < 32; y++)
        for (let dx = 0; dx < 8; dx++) {
          const source = dx + 8 * (y + 32 * dz),
            target = x + dx + SIZE[0] * (y + SIZE[1] * (z + dz));
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
        low[0], low[1], low[2],
        extent[0], extent[1], extent[2],
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        data,
      );
    }
  }
  dispose(): void {
    for (const texture of [this.info, this.tree, this.pool])
      this.gl.deleteTexture(texture);
    this.regions.clear();
  }
}
