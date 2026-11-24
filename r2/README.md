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

运行 `npm run build`，可在 `dist/` 得到三个独立的浏览器 ES 模块，以及供自建核心选择的两个材质归档。将所需 JS 放到静态站点，HTML 即可按 URL 导入。跨站点提供模块时，静态服务器需要允许页面跨域读取。TypeScript 项目也可以从 `neomega-r2/r2-frontend`、`neomega-r2/r2-core` 和 `neomega-r2/r2-link` 导入，各入口附带类型声明。

### 使用标准前端

标准前端管理渲染、相机、设置与帧循环。构建后，在静态服务器上打开 `dist/standalone.html` 即可运行[完整示例](examples/standalone.html)。也可以只把这个 HTML 和 `r2-frontend.js` 复制到自己的站点。示例在浏览器内生成一块草地，宿主提供的按钮可以把相机移回起点。

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
    source: memorySource(world), camera, actions: home,
    chunks: () => world.chunkIndex(),
  });
  home.onclick = () => view.moveCamera(camera);
</script>
```

`actions` 接收宿主的 DOM 元素。挂载期间元素位于独立的底栏面板内，原有按钮和事件处理器继续使用。前端在容器内用独立文档隔离样式、键盘与控件 ID。可通过 `await view.setScene({ source, camera, name, chunks })` 切换到另一个数据源。离开页面组件时调用 `view.dispose()` 关闭当前源、释放渲染资源并归还按钮。修改同一个内存世界时，使用 `world.commit()` 通知当前会话即可。

前端自带默认材质包和合成信息包。设置面板支持选择 ZIP、选择目录及恢复默认，也可在代码里调用 `await view.setMaterialPack(file)` 或 `await view.setMaterialPack(null)`。

### 自己接线的渲染核心

核心自带渲染代码、着色器和区域准备线程。模型和贴图由调用者显式提供。将[默认材质包](../assets-utils/default-materials.zip)解压到页面旁边，准备好 `<canvas>` 元素后，下面的模块脚本即可绘制石台和玻璃方块。

```js
import { createRenderer, MemoryWorld, memorySource, ObjectRegistry, WorldSession } from "./r2-core.js";

const canvas = document.querySelector("canvas");
const renderer = await createRenderer(canvas, { assets: "./assets/" });

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

示例中的 `WorldSession` 把数据源接到渲染器。每帧先用 `focus` 指定相机周围需要哪些区块，其中 `nearRadius` 控制活动对象的范围，`farRadius` 控制静态方块的范围，两者都以区块为单位。一个区域横跨 8 个区块，因此远景半径向上取 8 的整倍数，传入 1 至 8 的窗口大小相同。区域在后台准备好后，`publish` 把它交给 GPU，随后 `draw` 绘制当前画面。

数据源负责提供完整方块状态的正确哈希。核心直接用哈希查调用者所选版本的模型表。

使用内存世界时，修改方块后调用 `world.commit()` 即可更新画面。如果世界由另一个进程提供，可以将示例中的 `memorySource(world)` 换成 `r2linkSource(url)`，通过 WebSocket 接收区域。关闭页面或切换世界时，调用 `session.dispose()` 释放会话。结束绘制后再调用 `renderer.dispose()`。[R2Link 协议与 Go 数据源](../go-link/README.md)

直接使用 ZIP 时，传入 `readResource: openMaterialPack(bytes)`，其中 `bytes` 为默认材质包的 `Uint8Array`。自带资源也可以通过同一个回调按文件名返回 `Response`。需要导入 Java 或基岩材质包时，使用与当前模型匹配的合成信息包。

```js
import { compileMaterialPack } from "./r2-core.js";

const info = new Uint8Array(await (await fetch("./material-info.zip")).arrayBuffer());
const set = await compileMaterialPack(info, fileInput.files[0], 128);
await session.setTextures(set);
```

### 从远端接入场景

`r2-link.js` 提供 WebSocket 数据源，核心和标准前端都可接收它。握手给出场景名与可选的开场相机。之后的相机消息通过回调交给宿主。下面的片段将已经挂载的 `view` 切换到远端世界。

```js
import { r2linkSource } from "./r2-link.js";

const source = r2linkSource("ws://127.0.0.1:2414/r2link", {
  onCamera: camera => view.moveCamera(camera),
});
const { scene, camera } = await source.welcome;
await view.setScene({ source, name: scene.name, camera, chunks: () => source.chunks() });
```

## 按需扩展

### 四档渲染器

预览时，`voxel` 用纯色立方体显示方块分布，`basic` 显示模型形状与贴图，默认的 `shading` 加入阴影、雾和水面反射。静止画面可以使用 `accumulation` 逐帧累积样本，得到软阴影和间接光照。创建渲染器时可用 `tier` 选择预览档，运行中切换前用 `await renderer.compile(tier)` 编译目标档。[绘制与拍照选项](src/render/options.ts)

设置面板按相机、光照、画面、输出和参数组分页。横屏时它贴在右侧，竖屏时变为底部抽屉；打开期间底栏和方向键暂时收起，方便对着画面调整。“相机”页可调整垂直视场角、镜头朝向和俯仰角。在“光照”页打开“手动放置太阳”后，可用方位和高度滑条移动光源。“太阳光颜色”默认是固定白色，决定太阳圆盘、方块受光和薄雾中日光的颜色。勾选“太阳光颜色随时间变化”后，会在选定的颜色上叠加随太阳高度变化的日照色调，低角度偏橙，高角度较淡。手动放置太阳时也按选定的高度变色。月光有独立的冷色。侧光便于观察砖缝，阴影的颜色和亮度可用天空补光调整。曝光补偿每提高一档，整幅画面进入色调映射前的亮度增加一倍。预览和拍照共用这些设置。

在“参数组”页中可以为当前画面命名并保存。换世界或重开 Viewer 后可从列表加载，也可删除。用“导出当前 JSON”分享这组参数；把文件拖入另一个场景或离线 HTML 即可应用。相机保留当前位置，采用参数组的朝向、俯仰和视场角。光照、时刻、渲染档位、视距、分辨率及拍照设置也一起恢复。

静止累积与累积拍照还可在“光照”页的“累积渲染专属”中调整薄雾。“薄雾每百格衰减”表示光在世界高度 0 以下的空气中走过 100 格后损失的比例，默认 0%，即关闭薄雾。薄雾在高度 0 以下保持相同密度，向上到高度 256 线性变稀至零，启用无限海面时只覆盖海面以上。空气的分布独立于存档的高度范围，因此低处向下看的视线也会连续衰减。直射强度以地面受光为基准。累积档按太阳到世界高度 0 之间的空气密度积分推算雾顶日光，补偿上限为 3 倍，再沿实际光路计算散射和遮挡。这样在低太阳下开启薄雾时，受光面仍接近光影预览的亮度。

每轮在相机到首个表面之间按透射率抽取一点，检查太阳或月亮能否照到那里。屋顶能挡住光束，天窗下的空气则可把直射光散向相机。镜面反射和透过玻璃看到的后续路段沿用表面渲染。

勾选“方块云投影”后，累积档以世界高度 160 的水平面模拟云层遮光。云的分布由世界坐标决定，同时削弱云下方块和薄雾收到的直射光。画面中能看到云投下的阴影和云隙透出的光带，天空背景沿用原有渐变。可在固定太阳与机位后开关投影，观察云隙下的亮带。把薄雾调为 0% 后仍可单独查看地面上的云影。

### 材质包怎样替换贴图

浏览器在 Worker 中读取材质包目录或 ZIP，按配方生成完整方块的纹理层、复杂模型的图集及配套模型表。Java 材质包可直接提供 labPBR 法线与高光图。基岩材质包按方块纹理名匹配 `textures/blocks` 下的材质定义，支持 PNG 与常量颜色。基岩高度图用于生成法线，让表面随光照呈现浅浮雕的凹凸。导入器按相邻纹素的高度差，以 1/16 的强度生成法线。斜看表面时，浅视差让矿粒和砖缝露出窄边。每张高度图的最高点落在方块面上，其他纹素按与最高点的灰度差向内下沉，黑白全量程对应 1/32 格。平坦的高度图没有落差。这两个尺度都是 R2 的转换约定。金属度、自发光与粗糙度转换为高光贴图。会话用 `session.setTextures` 将新贴图与按新透明度重新准备的区域在同一帧发布。估算完整方块的贴图显存时，将各级纹理的像素数之和乘以层数、每像素 4 字节和 3 组纹理（颜色、法线、高光）。复杂模型的图集另计。[材质包与资源工具](../assets-utils/README.md)

光影档和累积档沿视线读取不透明完整方块的 labPBR 高度通道，使砖沿能挡住后方的砖缝。累积档还会沿光源方向检查砖沿投下的阴影。贴图中的粗糙度决定高光怎样散开。观察砖面时可以让阳光从侧面照入，再降低视角并横向移动。远处的砖墙只要在画面上足够大，也能看见起伏。当一块砖方块的贴图在较窄的投影方向从约 24 个像素缩到 8 个像素时，起伏会逐渐淡出。方块的外轮廓和选取位置由原模型决定。

### 区域编码

自定义数据源可以用 `encodeRegion` 将子区块编码成会话接收的区域数据。每个子区块覆盖 16 × 16 × 16 个方块，输入是各位置的方块状态哈希。[浏览器端编码实现](src/source/memory.ts) · [二进制布局与坐标顺序](../go-link/README.md#区域编码)

### 怎样添加 effector 和 block actor

附魔书这类活动对象由两端配合生成。数据源根据方块状态生成对象描述时使用 effector，需要额外读取方块实体数据时使用 block actor。浏览器端用 `ObjectRegistry.register` 为描述中的 `kind` 注册同名外观工厂，由它提供贴图、部件形状和动画。[数据源端的处理器](../go-link/README.md) · [附魔书的外观实现](src/effects/enchanting-book.ts)
