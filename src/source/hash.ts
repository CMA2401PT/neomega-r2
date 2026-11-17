/** Java 方块状态字符串换成 neomega-blocks 的 u32 哈希，与 Go 的 BlockToHash 一致。
 *
 * 状态写作 `minecraft:oak_fence ["east"="true","north"="true"]`：属性顺序不限，省略命名空间时补 `minecraft:`，
 * 没有属性时可以只写名字。值可以是带引号的字符串、`true`/`false` 或整数；Java 状态的值都是字符串。
 * 哈希按键排序后把 `{name, states}` 编码成小端 NBT，再取 FNV-1a 32 位。
 */
export function blockHash(state: string): number {
  const text = state.trim(),
    split = text.search(/[\s[]/),
    rawName = split < 0 ? text : text.slice(0, split),
    name = rawName.includes(":") ? rawName : "minecraft:" + rawName;
  if (name === "minecraft:unknown") return 0xfffffffe;
  const properties = split < 0 ? "" : text.slice(split).trim();
  if (properties && !(properties.startsWith("[") && properties.endsWith("]")))
    throw Error(`方块状态的属性需要写在方括号里：${state}`);
  const entries: Array<[string, string | boolean | number]> = [];
  const pattern = /\s*"([^"]*)"\s*=\s*("([^"]*)"|true|false|-?\d+)\s*(,|$)/y;
  const body = properties.slice(1, -1);
  pattern.lastIndex = 0;
  while (pattern.lastIndex < body.length) {
    const start = pattern.lastIndex,
      match = pattern.exec(body);
    if (!match) {
      if (!body.slice(start).trim()) break;
      throw Error(`无法解析方块状态：${state}`);
    }
    const [, key, raw, quoted] = match;
    entries.push([key, quoted !== undefined ? quoted : raw === "true" ? true : raw === "false" ? false : Number(raw)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = new Fnv();
  hash.byte(10).text(""); // 根复合标签，名字为空
  hash.byte(8).text("name").text(name);
  hash.byte(10).text("states");
  for (const [key, value] of entries) {
    if (typeof value === "string") hash.byte(8).text(key).text(value);
    else if (typeof value === "boolean") hash.byte(1).text(key).byte(Number(value));
    else hash.byte(3).text(key).int(value);
  }
  return hash.byte(0).byte(0).value;
}

const encoder = new TextEncoder();

/** 逐字节累计 FNV-1a 32；NBT 字符串是 u16 小端长度加 UTF-8。 */
class Fnv {
  value = 0x811c9dc5;
  byte(b: number): this {
    this.value = Math.imul(this.value ^ (b & 0xff), 0x01000193) >>> 0;
    return this;
  }
  int(v: number): this {
    for (let i = 0; i < 4; i++) this.byte(v >>> (i * 8));
    return this;
  }
  text(s: string): this {
    const bytes = encoder.encode(s);
    this.byte(bytes.length).byte(bytes.length >> 8);
    for (const b of bytes) this.byte(b);
    return this;
  }
}

/** 空气的哈希；内存世界里的 0 表示空气，编码时换成它。 */
export const AIR = blockHash("minecraft:air");
