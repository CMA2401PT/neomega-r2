import type { ObjectDescriptor, ObjectFactory, ObjectRecipe } from "../contracts.ts";

/** 特效和 NBT 外观都通过类型注册；工厂只提供部件、贴图、包围盒与动画，不接触 GPU。 */
export class ObjectRegistry {
  factories = new Map<string, ObjectFactory>();
  register(kind: string, factory: ObjectFactory): this {
    this.factories.set(kind, factory);
    return this;
  }
  async create(descriptor: ObjectDescriptor): Promise<ObjectRecipe> {
    const factory = this.factories.get(descriptor.kind);
    if (!factory) throw Error("没有注册对象类型：" + descriptor.kind);
    return factory(descriptor);
  }
}
