export interface WordBlock {
  start: number;
  length: number;
}

/** 为流式区域分配连续的 uint32 地址；释放后合并相邻空闲段。
 * 地址 0 保留为空值，区域替换发布后才回收旧地址。
 */
export class WordAllocator {
  capacity: number;
  free: WordBlock[];
  used = 0;
  constructor(capacity: number) {
    this.capacity = capacity;
    this.free = [{ start: 1, length: capacity - 1 }];
  }
  allocate(length: number): WordBlock {
    const size = Math.ceil(length / 256) * 256,
      index = this.free.findIndex((span) => span.length >= size);
    if (index < 0) throw Error("r2region 数据超过显存预算，请降低远景视距");
    const span = this.free[index],
      block = { start: span.start, length: size };
    span.start += size;
    span.length -= size;
    if (!span.length) this.free.splice(index, 1);
    this.used += size;
    return block;
  }
  release(block: WordBlock): void {
    this.used -= block.length;
    this.free.push(block);
    this.free.sort((a, b) => a.start - b.start);
    for (let i = 1; i < this.free.length; ) {
      const a = this.free[i - 1],
        b = this.free[i];
      if (a.start + a.length === b.start) {
        a.length += b.length;
        this.free.splice(i, 1);
      } else i++;
    }
  }
}
