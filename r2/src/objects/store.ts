import type { ObjectDescriptor, ObjectRecipe, ObjectReference, ObjectTexture } from "../contracts.ts";
import type { ObjectRegistry } from "./registry.ts";

interface AtlasImage {
  x: number;
  y: number;
  w: number;
  h: number;
  width: number;
  height: number;
  refs: number;
  name: string;
}
interface StoredObject {
  descriptor: ObjectDescriptor;
  recipe: ObjectRecipe;
  image: AtlasImage;
  slots: Array<{ slot: number; id: number }>;
}

const SIDE = 2048,
  TILE = 64,
  SLOTS = 4096,
  STRIDE = 48;
/** 管理活动部件与私有贴图；候选格只保存实例句柄，句柄代数避免卸载后的旧引用指向新对象。 */
export interface ObjectUploads {
  image(
    x: number,
    y: number,
    width: number,
    height: number,
    pixels: Uint8Array | undefined,
    decoded: HTMLImageElement | undefined,
  ): void;
  rows(data: Float32Array<ArrayBuffer>, height: number): void;
  dispose(): void;
}
function glUploads(
  gl: WebGL2RenderingContext,
  uniforms: Map<string, WebGLUniformLocation | null>,
): ObjectUploads {
  const table = gl.createTexture();
  gl.activeTexture(gl.TEXTURE12);
  gl.bindTexture(gl.TEXTURE_2D, table);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1024, (SLOTS * 12) / 1024);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uObjectData") ?? null, 12);
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE13);
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SIDE, SIDE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(uniforms.get("uObjectAtlas") ?? null, 13);
  return {
    image(x, y, width, height, pixels, decoded) {
      gl.activeTexture(gl.TEXTURE13);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (decoded) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, decoded);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels!);
    },
    rows(data, height) {
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, table);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, height, gl.RGBA, gl.FLOAT, data);
    },
    dispose() {
      gl.deleteTexture(table);
      gl.deleteTexture(atlas);
    },
  };
}
export class ObjectStore {
  private uploads: ObjectUploads;
  objects = new Map<string, StoredObject>();
  regions = new Map<string, Set<string>>();
  images = new Map<string, AtlasImage>();
  tiles = new Uint8Array(32 * 32);
  free = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i);
  generations = new Uint32Array(SLOTS);
  data = new Float32Array(SLOTS * STRIDE);
  high = 0;
  // 对象增删时加一；动画本身不改变它。
  version = 0;
  /** 宿主可整体关闭对象绘制；undefined 视为开启。 */
  enabled: boolean | undefined;
  disposed = false;
  textureBytes: number;
  constructor(uploads: ObjectUploads);
  constructor(gl: WebGL2RenderingContext, uniforms: Map<string, WebGLUniformLocation | null>);
  constructor(
    target: ObjectUploads | WebGL2RenderingContext,
    uniforms?: Map<string, WebGLUniformLocation | null>,
  ) {
    this.uploads = "rows" in target ? target : glUploads(target, uniforms!);
    this.textureBytes = this.data.byteLength + SIDE * SIDE * 4;
  }
  async image(source: ObjectTexture, key: string): Promise<AtlasImage> {
    const name = source.url || key;
    let cached = this.images.get(name);
    if (cached) {
      cached.refs++;
      return cached;
    }
    let decoded: HTMLImageElement | undefined;
    if (source.url) {
      decoded = new Image();
      decoded.src = source.url;
      await decoded.decode();
      if (this.disposed) throw new DOMException("对象来源已关闭", "AbortError");
    }
    const width = source.width || decoded!.width,
      height = source.height || decoded!.height,
      w = Math.ceil(width / TILE),
      h = Math.ceil(height / TILE);
    let found: { x: number; y: number; w: number; h: number } | null = null;
    for (let y = 0; y <= 32 - h && !found; y++)
      for (let x = 0; x <= 32 - w && !found; x++) {
        let free = true;
        for (let dy = 0; dy < h; dy++)
          for (let dx = 0; dx < w; dx++) if (this.tiles[x + dx + 32 * (y + dy)]) free = false;
        if (free) found = { x, y, w, h };
      }
    if (!found) throw Error("特殊对象贴图空间不足");
    const { x, y } = found;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.tiles[x + dx + 32 * (y + dy)] = 1;
    this.uploads.image(x * TILE, y * TILE, width, height, source.pixels, decoded);
    cached = { ...found, width, height, refs: 1, name };
    this.images.set(name, cached);
    return cached;
  }
  /** 更新拥有者区域的实例，返回候选是否改变；无变化时宿主不必重建静态区域。 */
  async setRegion(key: string, descriptors: ObjectDescriptor[], registry: ObjectRegistry): Promise<boolean> {
    const previous = this.regions.get(key) || new Set<string>(),
      next = new Set<string>();
    for (const descriptor of descriptors) {
      next.add(descriptor.key);
      if (this.objects.has(descriptor.key)) continue;
      const recipe = await registry.create(descriptor);
      if (this.disposed) throw new DOMException("对象来源已关闭", "AbortError");
      const image = await this.image(recipe.texture, descriptor.key),
        slots: StoredObject["slots"] = [];
      for (const part of recipe.parts) {
        const slot = this.free.pop();
        if (slot === undefined) throw Error("特殊对象部件空间不足");
        const generation = ++this.generations[slot];
        slots.push({
          slot,
          id: (0x80000000 | (generation << 12) | slot) >>> 0,
        });
        this.high = Math.max(this.high, slot + 1);
        const at = slot * STRIDE;
        this.data.set([...part.minimum, generation], at + 16);
        this.data.set([...part.maximum, 0], at + 20);
        for (let face = 0; face < 6; face++) {
          const uv = part.faces[face];
          this.data.set(
            [(image.x * TILE + uv[0]) / SIDE, (image.y * TILE + uv[1]) / SIDE, uv[2] / SIDE, uv[3] / SIDE],
            at + 24 + face * 4,
          );
        }
      }
      this.objects.set(descriptor.key, { descriptor, recipe, image, slots });
      this.version++;
    }
    for (const name of previous) if (!next.has(name)) this.remove(name);
    this.regions.set(key, next);
    return previous.size !== next.size || [...previous].some((name) => !next.has(name));
  }
  remove(name: string): void {
    const object = this.objects.get(name);
    if (!object) return;
    for (const { slot } of object.slots) {
      this.data[slot * STRIDE + 19] = 0;
      this.free.push(slot);
    }
    const image = object.image;
    if (--image.refs === 0) {
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) this.tiles[image.x + x + 32 * (image.y + y)] = 0;
      this.images.delete(image.name);
    }
    this.objects.delete(name);
    this.version++;
  }
  removeRegion(key: string): boolean {
    const changed = (this.regions.get(key)?.size || 0) > 0;
    for (const name of this.regions.get(key) || []) this.remove(name);
    this.regions.delete(key);
    return changed;
  }
  references(): ObjectReference[] {
    return [...this.objects.values()].map(({ descriptor, recipe, slots }) => ({
      key: descriptor.key,
      owner: descriptor.position,
      replace: descriptor.replace || false,
      bounds: recipe.bounds.map((p) => p.map((v, i) => v + descriptor.position[i])),
      ids: slots.map((v) => v.id),
    }));
  }
  update(time: number, origin: number[]): void {
    for (const { descriptor, recipe, slots } of this.objects.values())
      for (let i = 0; i < slots.length; i++) {
        const { axes, position, scale = 1 } = recipe.pose(time, i),
          shift = position.map((v, a) => v + descriptor.position[a] - origin[a]),
          at = slots[i].slot * STRIDE;
        for (let column = 0; column < 3; column++)
          this.data.set(
            [axes[0][column] / scale, axes[1][column] / scale, axes[2][column] / scale, 0],
            at + column * 4,
          );
        this.data.set(
          axes.map((axis) => -axis.reduce((sum, v, a) => sum + v * shift[a], 0) / scale).concat(1),
          at + 12,
        );
      }
    if (this.high) {
      const height = Math.ceil((this.high * 12) / 1024);
      this.uploads.rows(this.data.subarray(0, 1024 * height * 4), height);
    }
  }
  clear(): void {
    for (const name of [...this.objects.keys()]) this.remove(name);
    this.regions.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
    this.uploads.dispose();
  }
}
