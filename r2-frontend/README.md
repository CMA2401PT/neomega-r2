# neOmega R2 Frontend (`neomega-r2-frontend`)

`r2-frontend` 构建在 [r2-core](../r2-core/README.md) 之上，提供两层递进的高层能力：

1. **合成与后处理管线 (`neomega-r2-frontend/compositor`)**：在**单张 `<canvas>`** 上接收 `r2-core` 输出的 RGB 与深度纹理，按需串联 **3×3 双边降噪** → **WebSR 2× 超分** → **基于深度图的外部 2D/3D 标记图层混合（DepthOverlay）** → **上屏 / PNG 编码导出**。
2. **共享查看界面 (`neomega-r2-frontend` / `neomega-r2-frontend/ui`)**：包含相机飞行控制、全屏正交地图与区块占用概览、坐标跳转、参数组管理、设置抽屉、渲染信息与材质包切换。支持两种集成方式：
   - **开箱即用 `mount()`**：发布脚本为单文件 `r2-frontend.js` 注入选定的材质，通过隔离 `iframe` 直接挂载完整播放器（适合单页 HTML）。
   - **宿主内联挂载 `mountLayout()` + `createView()`**：在宿主页面内挂载标准布局与插槽（Viewer、离线播放器、Demo 共用）。

## 运行本地演示

首次运行时，在 neomega-r2 根目录安装依赖并生成浏览器材质。

```sh
npm ci
python3 assets-utils/resourcegen/generate.py --java 26.3 --topic browser-materials
npm run demo
```

之后运行 `npm run demo` 即可。启动命令从当前源码构建页面，并读取本地生成的材质。

打开 <http://127.0.0.1:2415/>，拖动视角，用 WASD 移动、空格上升、Shift 下降；底栏可切换内置测试场景。打开 <http://127.0.0.1:2415/?scene=special> 可直接查看陶罐、旗帜和告示牌。打开 <http://127.0.0.1:2415/?scene=frames> 可以围绕同一个支撑方块观察六个朝向的空展示框，单击框体查看实体 SNBT。带物品的场景并排放置了海晶灯、钻石剑和橡木楼梯。[打开物品展示框](http://127.0.0.1:2415/?scene=frame_items)。其他示例页：

- 内存世界单页接入：<http://127.0.0.1:2415/release/standalone.html>（源码 [examples/standalone.html](examples/standalone.html)）
- 按需 `DataSource` 接入：<http://127.0.0.1:2415/release/datasource.html>（源码 [examples/datasource.html](examples/datasource.html)）
- 离屏核心 RGB + 深度 + 拾取：<http://127.0.0.1:2415/release/color-depth.html>（源码 [../r2-core/examples/color-depth.html](../r2-core/examples/color-depth.html)）

## 方式一：单页 HTML 直接使用 `mount()`

```html
<!doctype html>
<meta charset="utf-8">
<style>body { margin: 0 } #world { height: 100dvh }</style>
<div id="world"></div>
<button id="home">返回起点</button>
<script type="module">
  import { mount, MemoryWorld, memorySource } from "./r2-frontend.js";

  const world = new MemoryWorld();
  world.fill([0, 0, 0], [31, 0, 31], 'minecraft:grass_block ["snowy"="false"]');
  const camera = { position: [16, 8, 32], yaw: 0, pitch: -0.45 };
  const home = document.querySelector("#home");
  const view = await mount(document.querySelector("#world"), {
    source: memorySource(world),
    camera,
    actions: home,
    chunks: () => world.chunkIndex(),
    helpHTML: "<h3>场景操作</h3><p>点击返回起点可重置相机。</p>",
  });
  home.onclick = () => view.moveCamera(camera);
</script>
```

- `view.setScene({ source, camera, name, chunks, ocean })` 可切换数据源，`view.setMaterialPack(file)` / `setMaterialPack(null)` 切换材质，`view.dispose()` 销毁并归还宿主 DOM 按钮。
- `view.overlay` 管理与场景深度交互的标记（`marker`、`polygon`、`line`、`blockOutline`、`blockFace`），默认与核心输出的深度图比较遮挡，设置 `alwaysVisible: true` 时置顶绘制。

## 方式二：只使用合成与后处理管线 (`compositor`)

如果不想使用预设 HUD，只想把 `r2-core` 的离屏画面与自己的 2D 选框/标记混合并做降噪和超分，可直接导入 `neomega-r2-frontend/compositor`：

```ts
import { createRenderer } from "neomega-r2-core";
import { createCompositor, SceneMarks } from "neomega-r2-frontend/compositor";

const renderer = await createRenderer({ assets: "/assets/", depthOutput: true });
const compositor = createCompositor(renderer.device, document.querySelector("canvas")!);
const marks = new SceneMarks();
marks.blockOutline([0, 0, -4], { stroke: "#ffffff", strokeWidth: 2 });

// 渲染核心离屏生成 RGB 与 Depth
await renderer.render(camera, { width: 640, height: 360, depthOutput: true, synchronize: true });

// 合成器在同一张 canvas 上串联 降噪 → WebSR → 深度测试混合标记 → 上屏
if (renderer.frame) {
  const stamps = marks.stamps(camera, innerWidth, innerHeight, devicePixelRatio, false, 640 / 360);
  compositor.present(renderer.frame, {
    denoise: "light",
    superResolution: "cnn-s",
    displaySize: { width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) },
    overlay: { stamps, cssWidth: innerWidth, cssHeight: innerHeight, perspective: camera.ortho === undefined },
  });
}

// 导出高分辨率 PNG
const blob = await compositor.renderToPNG(renderer.frame!, {
  denoise: "light",
  superResolution: "cnn-s",
  saveSuperResolution2x: true,
});
```

## 方式三：宿主内联挂载 UI (`ui`)

适合桌面查看器或离线播放器等需要在同一文档内注入按钮、对话框和自定义数据源逻辑的宿主：

1. 引入 `/r2/style.css`，在页面放置可选 `<template id="leading-actions|actions|settings-extra|help-extra">`。
2. 调用 `mountLayout()` 挂载布局与插槽，调用 `createStartup()` 创建启动提示。
3. 使用 `createRenderer(...)` 与 `createView({ renderer, camera, settings, startup, scene, ... })` 驱动帧循环。

参考实现见 [demo/main.ts](demo/main.ts) 与 [apps/neomega-viewer-r2/web/app.ts](../../apps/neomega-viewer-r2/web/app.ts)。

## 点击查看近景 SNBT

使用 `mount()` 时，查看器会记录当前近景的原始快照。自行组装标准界面时，调用 `createViewerWorld(renderer, source)` 创建可查看原文的世界，将返回的世界交给 `view.frame(now, world)`。查看器在点击时按所属格坐标查方块，按实例 ID 查实体，然后在 HTML 面板显示原文。近景区域卸载时也释放对应记录。

近景数据如何提交，以及陶罐、旗帜、告示牌和展示框如何呈现，见 [Minecraft 世界接口](../r2-mc/README.md)。

## 宿主选择材质

通过 npm 包直接调用 `mount` 时，传入 `readResource(name)` 和 `loadRecipe(signal)`。前者供渲染器按文件名读取纹理与模型，后者只在用户切换材质时读取配套的合成配方。WebSR 模型参数随前端编译。

```ts
import { mount } from "neomega-r2-frontend";
import { openMaterialPack } from "neomega-r2-materials";

const pack = await fetch("./default-materials.zip");
if (!pack.ok) throw Error("默认材质加载失败");
await mount(container, {
  source,
  readResource: openMaterialPack(new Uint8Array(await pack.arrayBuffer())),
  async loadRecipe(signal) {
    const response = await fetch("./material-info.zip", { signal });
    if (!response.ok) throw Error("材质配方加载失败");
    return new Uint8Array(await response.arrayBuffer());
  },
});
```

包内构建输出可注入资源的 `dist/index.js`，并把内联 UI 的脚本和样式写入 `dist/web/`。Go 应用通过[发布脚本](../scripts/release-browser/README.md)组合各包的网页产物，然后用自己的 `go:embed` 提供静态文件。
