import { RegionDirectory, SIZE } from "./region-directory.ts";
import type { TextureSet } from "./textures.ts";
import { voxelColors } from "./voxels.ts";
import { ObjectStore } from "../objects/store.ts";

type Extent = [number, number, number];
const usage = () => GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING;
export class GPUWorld extends RegionDirectory {
  readonly info: GPUTexture;
  readonly tree: GPUTexture;
  pool: GPUBuffer;
  readonly device: GPUDevice;
  constructor(device: GPUDevice, capacityWords: number) {
    super({ capacityWords });
    this.device = device;
    this.info = device.createTexture({
      size: SIZE as Extent,
      dimension: "3d",
      format: "rgba32uint",
      usage: usage(),
    });
    this.tree = device.createTexture({
      size: SIZE as Extent,
      dimension: "3d",
      format: "r32uint",
      mipLevelCount: this.levels.length,
      usage: usage(),
    });
    this.pool = device.createBuffer({
      size: Math.min(capacityWords * 4, 65536),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.textureBytes -= capacityWords * 4 - this.pool.size;
  }
  protected uploadWords(start: number, words: Uint32Array<ArrayBuffer>) {
    // Grow the backing store as regions arrive. Allocator addresses stay stable.
    const end = (start + words.length) * 4;
    if (end > this.pool.size) {
      const old = this.pool;
      this.pool = this.device.createBuffer({
        size: Math.min(this.allocator.capacity * 4, 2 ** Math.ceil(Math.log2(end))),
        usage: old.usage,
      });
      const copy = this.device.createCommandEncoder();
      copy.copyBufferToBuffer(old, 0, this.pool, 0, old.size);
      this.device.queue.submit([copy.finish()]);
      this.textureBytes += this.pool.size - old.size;
      old.destroy();
    }
    this.device.queue.writeBuffer(this.pool, start * 4, words);
  }
  protected uploadDirectory(
    section: boolean,
    level: number,
    low: number[],
    size: number[],
    data: Uint32Array<ArrayBuffer>,
  ) {
    this.device.queue.writeTexture(
      { texture: section ? this.info : this.tree, mipLevel: level, origin: low as Extent },
      data,
      { bytesPerRow: size[0] * (section ? 16 : 4), rowsPerImage: size[1] },
      size as Extent,
    );
  }
  dispose() {
    this.info.destroy();
    this.tree.destroy();
    this.pool.destroy();
    this.regions.clear();
  }
}

export function objectTextures(device: GPUDevice) {
  const table = device.createTexture({ size: [1024, 48], format: "rgba32float", usage: usage() });
  const atlas = device.createTexture({
    size: [2048, 2048],
    format: "rgba8unorm",
    usage: usage() | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const store = new ObjectStore({
    image(x, y, width, height, pixels, decoded) {
      const dst = { texture: atlas, origin: { x, y } };
      if (decoded) device.queue.copyExternalImageToTexture({ source: decoded }, dst, [width, height]);
      else
        device.queue.writeTexture(dst, pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4 }, [
          width,
          height,
        ]);
    },
    rows(data, height) {
      device.queue.writeTexture({ texture: table }, data, { bytesPerRow: 1024 * 16 }, [1024, height]);
    },
    dispose() {
      table.destroy();
      atlas.destroy();
    },
  });
  return { store, table, atlas };
}

export function materialTextures(
  device: GPUDevice,
  { files, info, catalog }: TextureSet,
  references: ArrayBuffer,
) {
  const made: GPUTexture[] = [];
  function texture(
    format: GPUTextureFormat,
    levels: { size: number[]; data: Uint8Array<ArrayBuffer> }[],
    array = false,
  ) {
    const tex = device.createTexture({
      size: levels[0].size as Extent,
      format,
      mipLevelCount: levels.length,
      usage: usage(),
    });
    made.push(tex);
    levels.forEach(({ size, data }, mipLevel) =>
      device.queue.writeTexture(
        { texture: tex, mipLevel },
        data,
        { bytesPerRow: size[0] * (format.startsWith("rgba32") ? 16 : 4), rowsPerImage: size[1] },
        size as Extent,
      ),
    );
    return tex.createView({ dimension: array ? "2d-array" : "2d" });
  }
  function table(buffer: ArrayBuffer, format: GPUTextureFormat) {
    const height = Math.max(1, Math.ceil(buffer.byteLength / (2048 * 16))),
      data = new Uint8Array(height * 2048 * 16);
    data.set(new Uint8Array(buffer));
    return texture(format, [{ size: [2048, height], data }]);
  }
  function atlas(name: string) {
    return texture("rgba8unorm", [
      { size: [info.atlasWidth, info.atlasHeight], data: new Uint8Array(files.get(name)!) },
    ]);
  }
  function tiles(name: string, format: GPUTextureFormat) {
    const src = new Uint8Array(files.get(name)!),
      levels = [];
    const depth = Math.ceil(info.layers / 4);
    let offset = 0;
    for (let mip = 0; mip < info.levels; mip++) {
      const side = info.side >> mip,
        width = side * 2,
        data = new Uint8Array(width * width * depth * 4);
      for (let tile = 0; tile < info.layers; tile++) {
        const left = (tile & 1) * side,
          top = ((tile >> 1) & 1) * side;
        for (let row = 0; row < side; row++) {
          data.set(
            src.subarray(offset, offset + side * 4),
            4 * (left + width * (top + row + width * (tile >> 2))),
          );
          offset += side * 4;
        }
      }
      levels.push({ size: [width, width, depth], data });
    }
    return texture(format, levels, true);
  }

  try {
    const colors = voxelColors({
      info,
      catalog,
      fast: files.get("fast.bin")!,
      references,
      records: files.get("quad-records.bin")!,
      surfaces: files.get("surface-layers.bin")!,
      surfaceSpecular: files.get("surface-specular.bin")!,
      atlas: files.get("atlas-color.bin")!,
      atlasSpecular: files.get("atlas-specular.bin")!,
    });
    const views = [
      table(files.get("headers.bin")!, "rgba32uint"),
      table(files.get("fast.bin")!, "rgba32float"),
      table(references, "rgba32uint"),
      table(files.get("quad-records.bin")!, "rgba32float"),
      atlas("atlas-color.bin"),
      atlas("atlas-specular.bin"),
      tiles("surface-layers.bin", "rgba8unorm-srgb"),
      tiles("surface-specular.bin", "rgba8unorm"),
      atlas("atlas-normals.bin"),
      tiles("surface-normals.bin", "rgba8unorm"),
      table(colors.buffer as ArrayBuffer, "rgba32float"),
    ];
    return {
      views,
      bytes: made.reduce(
        (sum, t) =>
          sum +
          t.width *
            t.height *
            t.depthOrArrayLayers *
            (t.format.startsWith("rgba32") ? 16 : 4) *
            (t.mipLevelCount > 1 ? 4 / 3 : 1),
        0,
      ),
      dispose() {
        made.forEach((t) => t.destroy());
      },
    };
  } catch (e) {
    made.forEach((t) => t.destroy());
    throw e;
  }
}
