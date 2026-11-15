const SIDE = 2048,
  TILE = 64,
  SLOTS = 4096,
  STRIDE = 48;
/** 管理活动部件与私有贴图；候选格只保存实例句柄，句柄代数避免卸载后的旧引用指向新对象。 */
export class ObjectStore {
  /** @param {WebGL2RenderingContext} gl @param {Map<string,WebGLUniformLocation>} uniforms */
  constructor(gl, uniforms) {
    this.gl = gl;
    this.objects = new Map();
    this.regions = new Map();
    this.images = new Map();
    this.tiles = new Uint8Array(32 * 32);
    this.free = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i);
    this.generations = new Uint32Array(SLOTS);
    this.data = new Float32Array(SLOTS * STRIDE);
    this.high = 0;
    this.table = gl.createTexture();
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, this.table);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1024, (SLOTS * 12) / 1024);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(uniforms.get("uObjectData"), 12);
    this.atlas = gl.createTexture();
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, SIDE, SIDE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(uniforms.get("uObjectAtlas"), 13);
    this.textureBytes = this.data.byteLength + SIDE * SIDE * 4;
  }
  async image(source, key) {
    const name = source.url || key;
    let cached = this.images.get(name);
    if (cached) {
      cached.refs++;
      return cached;
    }
    let image = source.pixels;
    if (source.url) {
      image = new Image();
      image.src = source.url;
      await image.decode();
      if (this.disposed) throw new DOMException("对象来源已关闭", "AbortError");
    }
    const width = source.width || image.width,
      height = source.height || image.height,
      w = Math.ceil(width / TILE),
      h = Math.ceil(height / TILE);
    let found = null;
    for (let y = 0; y <= 32 - h && !found; y++)
      for (let x = 0; x <= 32 - w && !found; x++) {
        let free = true;
        for (let dy = 0; dy < h; dy++)
          for (let dx = 0; dx < w; dx++)
            if (this.tiles[x + dx + 32 * (y + dy)]) free = false;
        if (free) found = { x, y, w, h };
      }
    if (!found) throw Error("特殊对象贴图空间不足");
    const { x, y } = found;
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) this.tiles[x + dx + 32 * (y + dy)] = 1;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE13);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (source.url)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x * TILE,
        y * TILE,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
    else
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x * TILE,
        y * TILE,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
    cached = { ...found, width, height, refs: 1, name };
    this.images.set(name, cached);
    return cached;
  }
  /** 每个拥有者区域独立增删实例，跨格候选交给场景准备器分发。 */
  /** @param {string} key @param {import("../contracts.js").ObjectDescriptor[]} descriptors @param {import("./registry.js").ObjectRegistry} registry */
  async setRegion(key, descriptors, registry) {
    const previous = this.regions.get(key) || new Set(),
      next = new Set();
    for (const descriptor of descriptors) {
      next.add(descriptor.key);
      if (this.objects.has(descriptor.key)) continue;
      const recipe = await registry.create(descriptor);
      if (this.disposed) throw new DOMException("对象来源已关闭", "AbortError");
      const image = await this.image(recipe.texture, descriptor.key),
        slots = [];
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
            [
              (image.x * TILE + uv[0]) / SIDE,
              (image.y * TILE + uv[1]) / SIDE,
              uv[2] / SIDE,
              uv[3] / SIDE,
            ],
            at + 24 + face * 4,
          );
        }
      }
      this.objects.set(descriptor.key, { descriptor, recipe, image, slots });
    }
    for (const name of previous) if (!next.has(name)) this.remove(name);
    this.regions.set(key, next);
    return this.references();
  }
  remove(name) {
    const object = this.objects.get(name);
    if (!object) return;
    for (const { slot } of object.slots) {
      this.data[slot * STRIDE + 19] = 0;
      this.free.push(slot);
    }
    const image = object.image;
    if (--image.refs === 0) {
      for (let y = 0; y < image.h; y++)
        for (let x = 0; x < image.w; x++)
          this.tiles[image.x + x + 32 * (image.y + y)] = 0;
      this.images.delete(image.name);
    }
    this.objects.delete(name);
  }
  removeRegion(key) {
    for (const name of this.regions.get(key) || []) this.remove(name);
    this.regions.delete(key);
  }
  /** @returns {import("../contracts.js").ObjectReference[]} */
  references() {
    return [...this.objects.values()].map(({ descriptor, recipe, slots }) => ({
      key: descriptor.key,
      owner: descriptor.position,
      replace: descriptor.replace || false,
      bounds: recipe.bounds.map((p) =>
        p.map((v, i) => v + descriptor.position[i]),
      ),
      ids: slots.map((v) => v.id),
    }));
  }
  update(time, origin) {
    for (const { descriptor, recipe, slots } of this.objects.values())
      for (let i = 0; i < slots.length; i++) {
        const { axes, position, scale = 1 } = recipe.pose(time, i),
          shift = position.map(
            (v, a) => v + descriptor.position[a] - origin[a],
          ),
          at = slots[i].slot * STRIDE;
        for (let column = 0; column < 3; column++)
          this.data.set(
            [
              axes[0][column] / scale,
              axes[1][column] / scale,
              axes[2][column] / scale,
              0,
            ],
            at + column * 4,
          );
        this.data.set(
          axes
            .map(
              (axis) =>
                -axis.reduce((sum, v, a) => sum + v * shift[a], 0) / scale,
            )
            .concat(1),
          at + 12,
        );
      }
    if (this.high) {
      const gl = this.gl,
        height = Math.ceil((this.high * 12) / 1024);
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, this.table);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        1024,
        height,
        gl.RGBA,
        gl.FLOAT,
        this.data.subarray(0, 1024 * height * 4),
      );
    }
  }
  clear() {
    for (const name of [...this.objects.keys()]) this.remove(name);
    this.regions.clear();
  }
  dispose() {
    this.disposed = true;
    this.clear();
    this.gl.deleteTexture(this.table);
    this.gl.deleteTexture(this.atlas);
  }
}
