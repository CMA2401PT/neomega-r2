# neOmega R2 Frontend (`neomega-r2-frontend`)

`r2-frontend` 构建在 [r2-core](../r2-core/README.md) 之上，提供两层递进的高层能力：

1. **合成与后处理管线 (`neomega-r2-frontend/compositor`)**：在**单张 `<canvas>`** 上接收 `r2-core` 输出的 RGB 与深度纹理，按需串联 **3×3 双边降噪** → **WebSR 2× 超分** → **基于深度图的外部 2D/3D 标记图层混合（DepthOverlay）** → **上屏 / PNG 编码导出**。
2. **共享查看界面 (`neomega-r2-frontend` / `neomega-r2-frontend/ui`)**：包含相机飞行控制、全屏正交地图与区块占用概览、坐标跳转、参数组管理、设置抽屉、渲染信息与材质包切换。支持两种集成方式：
   - **开箱即用 `mount()`**：单文件 `r2-frontend.js` 内嵌默认材质与着色器，通过隔离 `iframe` 直接挂载完整播放器（适合单页 HTML）。
   - **宿主内联挂载 `mountLayout()` + `createView()`**：在宿主页面内挂载标准布局与插槽（Viewer、离线播放器、Demo 共用）。

## 运行本地演示

在 `neomega-r2` 仓库根目录运行：

```sh
npm ci
npm run demo
```

打开 <http://127.0.0.1:2415/>，拖动视角，用 WASD 移动、空格上升、Shift 下降；底栏可切换内置测试场景。其他示例页：
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

## Go 嵌入与构建产物说明

执行 `npm run build` 后会产出两类用途完全隔离的产物：

- **`dist/web/`**（通过 [embed.go](embed.go) 嵌入 Go 宿主）：包含外链 `./r2-core.js` 与 `./r2-materials.js` 的精简 `r2-frontend.js`、`r2-core.js`、`r2-link.js`、`r2-materials.js`、`style.css` 与按需读取的 `material-info.zip`，**不重复内嵌默认材质包或双份脚本**。
- **`dist/release/`**：面向独立静态站点的单文件自包含 `r2-frontend.js` 与 HTML 示例，不进入 Go 二进制。
