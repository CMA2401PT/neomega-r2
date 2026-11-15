/** 把通用对象候选登记到小型实验格子，规则与流式区域的目标格归属一致。 */
export function attachGridObjects(grid, cells, objects) {
  const parts = [...grid.parts],
    output = cells.slice(),
    lists = new Map();
  for (const object of objects) {
    const [low, high] = object.bounds;
    for (let z = Math.floor(low[2]); z < Math.ceil(high[2]); z++)
      for (let y = Math.floor(low[1]); y < Math.ceil(high[1]); y++)
        for (let x = Math.floor(low[0]); x < Math.ceil(high[0]); x++) {
          if (
            x < 0 ||
            y < 0 ||
            z < 0 ||
            x >= grid.size[0] ||
            y >= grid.size[1] ||
            z >= grid.size[2]
          )
            continue;
          const at = (x + grid.size[0] * (y + grid.size[1] * z)) * 2;
          if (!lists.has(at)) {
            const start = output[at + 1];
            lists.set(
              at,
              start ? parts.slice(start + 1, start + 1 + parts[start]) : [],
            );
          }
          lists.get(at).push(...object.ids);
        }
  }
  for (const [at, ids] of lists) {
    output[at + 1] = parts.length;
    parts.push(ids.length, ...ids);
  }
  return { cells: output, grid: { ...grid, parts } };
}
