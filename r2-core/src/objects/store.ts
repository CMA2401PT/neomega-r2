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
  name: string | Uint8Array;
}
interface StoredObject {
  region: string;
  descriptor: ObjectDescriptor;
  reference: ObjectReference;
  recipe: ObjectRecipe;
  image: AtlasImage;
  slots: Array<{ slot: number; id: number }>;
}

/** 包围盒用世界坐标，部件几何仍保留在对象自己的坐标系中。 */
function objectReference(descriptor: ObjectDescriptor, recipe: ObjectRecipe, ids: number[]): ObjectReference {
  return {
    key: descriptor.key,
    owner: descriptor.position,
    replace: !!descriptor.replace,
    bounds: recipe.bounds.map(p => p.map((v, i) => v + descriptor.position[i])),
    ids,
  };
}

/** 半开包围盒覆盖的格子不变时，移动只需要上传位姿。替换本格的对象还需比较它覆盖的本体。 */
function sameCells(a: ObjectReference, b: ObjectReference): boolean {
  return a.replace === b.replace &&
    (!a.replace || a.owner.every((v, i) => Math.floor(v) === Math.floor(b.owner[i]))) &&
    a.bounds[0].every((v, i) => Math.floor(v) === Math.floor(b.bounds[0][i])) &&
    a.bounds[1].every((v, i) => Math.ceil(v) === Math.ceil(b.bounds[1][i]));
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
export class ObjectStore {
  private uploads: ObjectUploads;
  objects = new Map<string, StoredObject>();
  regions = new Map<string, Set<string>>();
  images = new Map<string | Uint8Array, AtlasImage>();
  tiles = new Uint8Array(32 * 32);
  free = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i);
  generations = new Uint32Array(SLOTS);
  data = new Float32Array(SLOTS * STRIDE);
  high = 0;
  // 对象增删、移动或更换外观时递增。
  version = 0;
  /** 宿主可整体关闭对象绘制；undefined 视为开启。 */
  enabled: boolean | undefined;
  disposed = false;
  textureBytes: number;
  constructor(uploads: ObjectUploads) {
    this.uploads = uploads;
    this.textureBytes = this.data.byteLength + SIDE * SIDE * 4;
  }
  async image(source: ObjectTexture): Promise<AtlasImage> {
    const name = source.url ?? source.cacheKey ?? source.pixels!;
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
  /** 同一 key 保留身份。移动只更新位姿和覆盖到的格子，只有外观变化才重新申请部件。 */
  async setRegion(
    region: string,
    descriptors: ObjectDescriptor[],
    registry: ObjectRegistry,
    invalidate?: (reference: ObjectReference) => void,
    current: () => boolean = () => true,
  ): Promise<boolean> {
    const version = this.version;
    const members = new Set(this.regions.get(region));
    this.regions.set(region, members);
    const wanted = new Set(descriptors.map(d => d.key));
    for (const name of members)
      if (!wanted.has(name)) this.remove(name, invalidate);

    for (const descriptor of descriptors) {
      const old = this.objects.get(descriptor.key);
      if (old && old.descriptor.kind === descriptor.kind && Object.is(old.descriptor.data, descriptor.data)) {
        // 新区域的快照可能先到；转移归属后，旧区域的撤回只能删除它仍拥有的对象。
        if (old.region !== region) {
          this.regions.get(old.region)?.delete(descriptor.key);
          members.add(descriptor.key);
          old.region = region;
        }
        if (descriptor.position.every((v, i) => v === old.descriptor.position[i]) &&
            !!descriptor.replace === !!old.descriptor.replace) continue;
        const previous = old.reference;
        old.descriptor = { ...descriptor, position: [...descriptor.position] };
        old.reference = objectReference(old.descriptor, old.recipe, previous.ids);
        if (!sameCells(previous, old.reference)) {
          invalidate?.(previous);
          invalidate?.(old.reference);
        }
        this.version++;
        continue;
      }

      const snapshot: ObjectDescriptor = { ...descriptor, position: [...descriptor.position] };
      const recipe = await registry.create(snapshot);
      if (!current() || this.regions.get(region) !== members) return this.version !== version;
      const image = await this.image(recipe.texture);
      if (!current() || this.regions.get(region) !== members) {
        this.releaseImage(image);
        return this.version !== version;
      }
      // 加载贴图期间旧区域可能已卸载。提交时按仍存在的部件计算可用槽位。
      const installed = this.objects.get(snapshot.key);
      if (recipe.parts.length > this.free.length + (installed?.slots.length ?? 0)) {
        this.releaseImage(image);
        throw Error("特殊对象部件空间不足");
      }
      if (installed) this.remove(snapshot.key, invalidate);
      const slots = this.allocateParts(recipe, image);
      const reference = objectReference(snapshot, recipe, slots.map(part => part.id));
      this.objects.set(snapshot.key, { region, descriptor: snapshot, reference, recipe, image, slots });
      members.add(descriptor.key);
      invalidate?.(reference);
      this.version++;
    }
    return this.version !== version;
  }

  /** 将局部几何和图集坐标写入部件槽，格子中的引用只持有带代数的句柄。 */
  private allocateParts(recipe: ObjectRecipe, image: AtlasImage): StoredObject["slots"] {
    const slots: StoredObject["slots"] = [];
    for (const part of recipe.parts) {
      const slot = this.free.pop()!;
      const generation = ++this.generations[slot];
      slots.push({
        slot,
        id: (0x80000000 | (generation << 12) | slot) >>> 0,
      });
      this.high = Math.max(this.high, slot + 1);
      const at = slot * STRIDE;
      this.data.set([...part.minimum, generation], at + 16);
      this.data.set([...part.maximum, part.unlitFaces ?? 0], at + 20);
      for (let face = 0; face < 6; face++) {
        const uv = part.faces[face];
        this.data.set(
          [(image.x * TILE + uv[0]) / SIDE, (image.y * TILE + uv[1]) / SIDE, uv[2] / SIDE, uv[3] / SIDE],
          at + 24 + face * 4,
        );
      }
    }
    return slots;
  }

  remove(name: string, invalidate?: (reference: ObjectReference) => void): void {
    const object = this.objects.get(name);
    if (!object) return;
    this.regions.get(object.region)?.delete(name);
    for (const { slot } of object.slots) {
      this.data[slot * STRIDE + 19] = 0;
      this.free.push(slot);
    }
    this.releaseImage(object.image);
    this.objects.delete(name);
    invalidate?.(object.reference);
    this.version++;
  }
  private releaseImage(image: AtlasImage): void {
    if (--image.refs === 0) {
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++) this.tiles[image.x + x + 32 * (image.y + y)] = 0;
      this.images.delete(image.name);
    }
  }
  /** 撤下此区域仍拥有的对象，同时通知所有覆盖过的区域刷新候选。 */
  removeRegion(key: string, invalidate?: (reference: ObjectReference) => void): boolean {
    const version = this.version;
    for (const name of this.regions.get(key) ?? []) this.remove(name, invalidate);
    this.regions.delete(key);
    return this.version !== version;
  }

  references(animatedOnly = false): ObjectReference[] {
    return [...this.objects.values()]
      .filter(({ recipe }) => !animatedOnly || recipe.animated !== false)
      .map(object => object.reference);
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
