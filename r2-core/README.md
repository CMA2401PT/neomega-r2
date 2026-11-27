# neOmega R2 Core (`neomega-r2-core`)

`r2-core` 是 R2 的**纯离屏 WebGPU 射线渲染核心**与**世界会话层**，**零运行时第三方依赖**。它隐藏了循环体素目录、层次空域跳跃、跨格片段、光线反弹与动态对象求交等全部渲染细节，只向调用方暴露一组清晰的核心能力：

1. **离屏帧输出（RGB + Depth）**：调用 `renderer.render(camera, options)`，产出左上角原点的 `rgba8unorm` 颜色纹理 `renderer.frame.color` 与可选 `r32float` 深度纹理 `renderer.frame.depth`（或通过 `pixels()` / `depthPixels()` 读回数组）。
2. **射线拾取（`pick`）**：查询指定像素命中的方块坐标与面法线。启用对象拾取后，还能取得命中对象的稳定标识。
3. **离屏多采样抓取（`createCapture`）**：以超采样网格与多轮反弹逐块累积高质量画面，输出同样遵循 `FrameOutput` 契约，供上层降噪、超分或保存为 PNG。
4. **世界会话与基础数据源**：`WorldSession`、`DataSource`、`MemoryWorld` 与 `ObjectRegistry`。

`r2-core` **不绑定 `<canvas>`，不包含降噪、WebSR 超分、2D/3D 图层叠加、PNG 编码、UI，也不包含 R2Link 网络协议或材质包 ZIP 编译**——远端数据源见 [r2-link](../r2-link/README.md)，材质包解压与编译见 [assets-utils](../assets-utils/README.md)，合成后处理与 UI 见 [r2-frontend](../r2-frontend/README.md)。

## 离屏渲染与读取 RGB / 深度图

创建渲染器时不传入 `<canvas>`，只需通过 `assets`（指向解压后的资源目录 URL）或 `readResource`（例如配合 `r2-materials.js` 的 `openMaterialPack` 读取 `default-materials.zip`）指定模型和贴图。开启 `depthOutput: true` 后，每次预览渲染都会同时写出颜色纹理与深度纹理。

```js
import { createRenderer } from "./r2-core.js";
import { openMaterialPack } from "./r2-materials.js";

const pack = await fetch("./default-materials.zip");
const renderer = await createRenderer({
  readResource: openMaterialPack(new Uint8Array(await pack.arrayBuffer())),
  depthOutput: true,
});

const camera = { position: [0, 8, 0], yaw: 0, pitch: -0.2 };
await renderer.render(camera, { width: 640, height: 360, ocean: 0, synchronize: true });

// 同一 GPU 设备上可直接读取纹理句柄，用于后续合成或深度混合：
const { color, depth, width, height, revision } = renderer.frame;

// 也可以直接读回 CPU 数组，两份数组均从左上角开始逐行排列：
const [rgba, depthValues] = await Promise.all([renderer.pixels(), renderer.depthPixels()]);
const x = 320, y = 180;
const i = y * width + x;
const rgb = rgba.subarray(4 * i, 4 * i + 3);
const distance = depthValues[i]; // 沿相机正前方的距离（格），天空为 -1

// 查询指定像素命中的方块坐标与表面法线（穿透解析海面）：
const hit = await renderer.pick(camera, { width, height, x, y });
```

完整可运行示例见 [examples/color-depth.html](examples/color-depth.html)（启动 `npm run demo` 后访问 `http://127.0.0.1:2415/release/color-depth.html`）。

### 输出约定

- **坐标原点**：`renderer.frame.color`、`renderer.frame.depth`、`pixels()`、`depthPixels()` 与 `pick()` 全部统一使用**左上角原点**，行 0 位于画面顶部。
- **深度值**：`r32float` 单通道浮点，记录首个可见表面沿相机 `forward` 方向的距离（单位为方块），天空为 `-1`。贴图完全透明的孔洞会继续向后求交；玻璃与水面记录各自首次命中的表面深度。
- **按需深度**：如果只需在特定帧输出深度，可在单次 `render(camera, { ..., depthOutput: true })` 中开启；静止累积帧（`accumulate: true`）沿用最近一次预览帧的深度。
- **渲染档位**：`tier` 支持 `"voxel"`（纯色体素）、`"basic"`（完整模型与贴图）、`"shading"`（默认，含硬阴影、雾、水面波纹反射与 labPBR）以及 `"accumulation"`（软阴影、间接光反弹、可选薄雾与云影）。运行中切换前调用 `await renderer.compile(tier)`。

## 世界会话与数据源

`WorldSession` 负责将 `DataSource` 接入渲染器：每帧用 `focus(position, { nearRadius, farRadius, nearPosition? })` 指定近景活动对象与远景静态方块范围（`farRadius` 向上取 8 区块的整数倍，即 128 格宽的 `r2region`），后台线程完成邻接与跨格片段准备后，由 `publish()` 每帧增量发布到 GPU。

```js
import { createRenderer, MemoryWorld, memorySource, ObjectRegistry, WorldSession } from "./r2-core.js";

const renderer = await createRenderer({ assets: "./assets/" });
const world = new MemoryWorld();
world.fill([0, 0, 0], [15, 0, 15], "minecraft:stone");
world.set(8, 1, 8, "minecraft:glass");

const session = new WorldSession(renderer, memorySource(world), {
  registry: new ObjectRegistry(),
});

session.focus([8, 6, 20], { nearRadius: 4, farRadius: 8 });
session.publish();
renderer.render({ position: [8, 6, 20], yaw: 0, pitch: -0.4 }, { width: 1280, height: 720 });
```

热替换材质包时调用 `await session.setTextures(set)`（`set` 由 `neomega-r2-materials` 的 `compileMaterialPack` 生成）。

### 区域编码与活动对象

- 自定义数据源可使用 `encodeRegion` 与 `blockHash` 编码 16×16×16 子区块（XZY 排列），实现见 [src/source/memory.ts](src/source/memory.ts) 与 [src/source/hash.ts](src/source/hash.ts)。

对象用场景内唯一的 `key` 标识，可以放在带小数的世界坐标上。数据源按对象原点所在的近景区域提交。静态网格由准备线程按三角面登记到相交的格子。动画盒体使用覆盖整个动画的包围盒登记。射线从其他格子击中部件时，也能找回同一个对象。现有的[Minecraft 特殊方块](../r2-mc/src/special-blocks/)同样通过这个接口绘制。

用 `ObjectRegistry.register(kind, factory)` 注册对象的局部几何、贴图和位姿。在 `MemoryWorld` 中，调用 `world.addObject(descriptor)` 后用 `world.commit()` 发布。移动时沿用 `key`、`kind` 和 `data`，只改 `position`。默认按 `data` 是否为同一个值判断外观变化。如果数据源每次重新解析参数，可以提供 `appearanceKey`，只有影响局部几何或材质的参数变化时才改变它。移除时调用 `world.removeObject(key)` 并再次发布。自定义数据源通过 `sink.objects(x, z, descriptors)` 提交区域快照，跨区域移动时需要更新新旧两个区域。

工厂可以返回 `{ texture, mesh }` 来绘制静态表面。顶点位置相对对象原点，支持小数和跨格。每个三角形引用三个顶点，UV 坐标以贴图左上角为原点，单位是像素。若两个面在同一个空间位置采用不同 UV，可以各自定义顶点。下面的三角形可以和已有会话使用同一个注册表：

```js
registry.register("slope", () => ({
  texture: { width: 1, height: 1, pixels: Uint8Array.of(255, 160, 40, 255) },
  mesh: {
    vertices: [
      { position: [0, 0, 0], uv: [0, 0] },
      { position: [2.5, 0, 0], uv: [1, 0] },
      { position: [0, 1.5, 1], uv: [0, 1] },
    ],
    triangles: [{ indices: [0, 1, 2] }],
  },
}));
world.addObject({ key: "slope-1", kind: "slope", position: [127.5, 2, 4] });
world.commit();
```

每个目标区域内，一张三角面只写一份几何记录。格子保存面记录的地址。GPU 遍历到该格时只在当前射线区间内求交，命中后插值 UV 并检查透明像素。修改网格位置或外观会重新准备涉及的区域。

用 `renderer.pick(camera, { width, height, x, y, objects: true })` 拾取对象。命中对象时，`hit.objectKey` 是提交时的标识，`hit.position` 是对象原点所在格。命中地形时，`hit.position` 是所属方块坐标。

## 构建与测试

```sh
npm -w r2-core run build
npm -w r2-core run check
npm -w r2-core test
```
