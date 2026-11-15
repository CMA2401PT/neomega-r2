/** 特效和 NBT 外观都通过类型注册；工厂只提供部件、贴图、包围盒与动画，不接触 WebGL。 */
export class ObjectRegistry {
  factories = new Map();
  /** @param {string} kind @param {import("../contracts.js").ObjectFactory} factory */
  register(kind, factory) {
    this.factories.set(kind, factory);
    return this;
  }
  /** @param {import("../contracts.js").ObjectDescriptor} descriptor */
  async create(descriptor) {
    const factory = this.factories.get(descriptor.kind);
    if (!factory) throw Error("没有注册对象类型：" + descriptor.kind);
    return factory(descriptor);
  }
}
