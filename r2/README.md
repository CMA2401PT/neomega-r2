# neOmega R2 · 支持远景与光影的 Minecraft 射线渲染器

R2 是在浏览器里绘制 Minecraft 方块世界的射线渲染器。它从相机沿每个像素的视线寻找可见表面，途中可以一步跨过整片空区域，因此绘制远景时需要检查的格子更少，可视区域也能更大。同一套射线查询还能从表面向其他方向追踪，这让光影效果更容易实现。例如，朝太阳追踪可以判断方块是否落在阴影里，沿水面的反射方向追踪就能找到水中映出的景物。

本目录附带一个在内存中生成世界的演示页，可以直接体验飞行、地图和拍照。要浏览自己的 Java 存档，请使用 [neOmega Viewer R2](https://github.com/CMA2401PT/neomega-viewer-r2)。

## 运行演示

准备 Node.js 22.18 或更高版本，在本 README 所在目录运行以下命令。

```sh
npm ci
npm run demo
```

打开[本地演示页](http://127.0.0.1:2415/)，拖动视角，用 WASD 移动、空格上升、Shift 下降。底栏可以切换场景，例如选择“附魔书与独立旗面”查看活动部件。演示使用仓库自带的模型和贴图，只需启动上述静态服务。

默认使用 WebGPU。如果浏览器需要使用 WebGL 2，打开 [WebGL 2 演示页](http://127.0.0.1:2415/?backend=webgl)。

## 接入自己的页面

运行 `npm run build` 后，将整个 `dist/` 作为静态目录提供给浏览器。演示页把它挂在 `/r2/`，把[默认模型与贴图](../assets-utils/assets/)挂在 `/assets/`。沿用这两个路径，就可以在含有 `<canvas>` 的页面中用模块脚本绘制一块石台和一个玻璃方块。

```js
import { createRenderer, MemoryWorld, memorySource, ObjectRegistry, WorldSession } from "/r2/index.js";

const canvas = document.querySelector("canvas");
const renderer = await createRenderer(canvas, { assets: "/assets/" });

const world = new MemoryWorld();
world.fill([0, 0, 0], [15, 0, 15], "minecraft:stone");
world.set(8, 1, 8, "minecraft:glass");

// 这个世界只有静态方块，活动对象的外观注册表可以留空。
const session = new WorldSession(renderer, memorySource(world), {
  registry: new ObjectRegistry(),
});
const camera = { position: [8, 6, 20], yaw: 0, pitch: -0.4 };

function frame() {
  session.focus(camera.position, { nearRadius: 4, farRadius: 8 });
  session.publish();
  renderer.draw(camera, { width: canvas.width, height: canvas.height });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

### 世界会话与数据源

示例中的 `WorldSession` 把数据源接到渲染器。每帧先用 `focus` 指定相机周围需要哪些区块，其中 `nearRadius` 控制活动对象的范围，`farRadius` 控制静态方块的范围，两者都以区块为单位。区域在后台准备好后，`publish` 把它交给 GPU，随后 `draw` 绘制当前画面。

使用内存世界时，修改方块后调用 `world.commit()` 即可更新画面。如果世界由另一个进程提供，可以将示例中的 `memorySource(world)` 换成 `r2linkSource(url)`，通过 WebSocket 接收区域。关闭页面或切换世界时，调用 `session.dispose()` 释放会话。结束绘制后再调用 `renderer.dispose()`。[R2Link 协议与 Go 数据源](../go-link/README.md)

需要相机操作、地图和拍照工具栏时，可以复用 [common_ui](common_ui/)。完整的页面接入示例见 [demo/index.html](demo/index.html) 和 [demo/main.ts](demo/main.ts)。Go 宿主可以通过 `r2.Files` 提供构建产物，因此应在编译 Go 程序前运行 `npm run build`。

## 按需扩展

### 四档渲染器

预览时，`voxel` 用纯色立方体显示方块分布，`basic` 显示模型形状与贴图，默认的 `shading` 加入阴影、雾和水面反射。静止画面可以使用 `accumulation` 逐帧累积样本，得到软阴影和间接光照。创建渲染器时可用 `tier` 选择预览档，运行中切换前用 `await renderer.compile(tier)` 编译目标档。[绘制与拍照选项](src/render/options.ts)

在设置中展开“镜头与布光”，可调整垂直视场角、镜头朝向和俯仰角。打开“手动放置太阳”可用方位和高度滑条移动光源。侧光便于观察砖缝，阴影的颜色和亮度可用天空补光调整。曝光补偿每提高一档，整幅画面进入色调映射前的亮度增加一倍。预览和拍照共用这些设置。

静止累积与累积拍照还可调整“空气薄雾”。“每百格衰减”表示光在雾中走过 100 格后损失的比例，默认 15%，设为 0% 即关闭。薄雾均匀分布在世界高度 −64 至 128 之间，启用无限海面时只覆盖海面以上。直射强度以地面受光为基准。累积档按太阳到世界高度 0 之间的雾层厚度推算雾顶日光，补偿上限为 3 倍，再沿实际光路计算散射和遮挡。这样在低太阳下开启薄雾时，受光面仍接近光影预览的亮度。

每轮在相机到首个表面之间按透射率抽取一点，检查太阳或月亮能否照到那里。屋顶能挡住光束，天窗下的空气则可把直射光散向相机。镜面反射和透过玻璃看到的后续路段沿用表面渲染。

勾选“方块云投影”后，累积档以世界高度 160 的水平面模拟云层遮光。云的分布由世界坐标决定，同时削弱云下方块和薄雾收到的直射光。画面中能看到云投下的阴影和云隙透出的光带，天空背景沿用原有渐变。可在固定太阳与机位后开关投影，观察云隙下的亮带。把薄雾调为 0% 后仍可单独查看地面上的云影。

### 材质包怎样替换贴图

Go 宿主用 `r2assets.BuildTextures` 将材质包目录或 ZIP 转为 R2 贴图集。Java 材质包可直接提供 labPBR 法线与高光图。基岩材质包按方块纹理名匹配 `textures/blocks` 下的材质定义，支持 PNG 与常量颜色。导入器把基岩高度图的最高点对齐方块面，将黑到白的完整高度范围折算为 1/16 格，并按同一高度尺度生成法线。金属度、自发光与粗糙度转换为高光贴图。浏览器用 `readTextureStream` 从响应流逐个读取贴图和模型表，再用 `session.setTextures` 更新当前世界的贴图和区域数据。估算完整方块的贴图显存时，将各级纹理的像素数之和乘以层数、每像素 4 字节和 3 组纹理（颜色、法线、高光）。复杂模型的图集另计。[材质包与资源工具](../assets-utils/README.md)

光影档和累积档沿视线读取不透明完整方块的 labPBR 高度通道，使砖沿能挡住后方的砖缝。累积档还会沿光源方向检查砖沿投下的阴影。贴图中的粗糙度决定高光怎样散开。观察砖面时可以让阳光从侧面照入，再降低视角并横向移动。远处的砖墙只要在画面上足够大，也能看见起伏。当一块砖方块的贴图在较窄的投影方向从约 24 个像素缩到 8 个像素时，起伏会逐渐淡出。方块的外轮廓和选取位置由原模型决定。

### 区域编码

自定义数据源可以用 `encodeRegion` 将子区块编码成会话接收的区域数据。每个子区块覆盖 16 × 16 × 16 个方块，输入是各位置的方块状态哈希。[浏览器端编码实现](src/source/memory.ts) · [二进制布局与坐标顺序](../go-link/README.md#区域编码)

### 怎样添加 effector 和 block actor

附魔书这类活动对象由两端配合生成。数据源根据方块状态生成对象描述时使用 effector，需要额外读取方块实体数据时使用 block actor。浏览器端用 `ObjectRegistry.register` 为描述中的 `kind` 注册同名外观工厂，由它提供贴图、部件形状和动画。[数据源端的处理器](../go-link/README.md) · [附魔书的外观实现](src/effects/enchanting-book.ts)
