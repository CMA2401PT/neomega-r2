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

标准前端管理渲染、相机、设置与帧循环。下面两个单 HTML 示例共用相机和“返回起点”按钮，可以单独把任意一个示例与构建出的 `r2-frontend.js` 放到静态站点。启动上面的演示服务后也可直接打开。

- 世界已经在内存中时，可以用 `MemoryWorld` 按方块坐标填出一块草地，交给前端显示。[运行内存世界示例](http://127.0.0.1:2415/r2/standalone.html) · [示例源码](examples/standalone.html)
- 世界需要按位置生成或加载时，可以自己实现 `DataSource`。示例只生成相机当前请求的区域，每隔 128 格出现一块同样的草地。相机离开后返回，数据源会再次提供该区域。[运行按需数据源示例](http://127.0.0.1:2415/r2/datasource.html) · [示例源码](examples/datasource.html)

内存世界的接入代码如下。

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

坐标右侧的资源管理器图标打开渲染器信息，可查看当前视距、区域加载进度、显存用量与 GPU 耗时。左侧的问号打开通用操作帮助。宿主需要说明自己的按钮时，可在 `mount` 的选项中传入自己编写的 HTML，例如 `helpHTML: "<h3>场景操作</h3><p>点击返回起点可重置相机。</p>"`。这段内容会排在通用说明之后、“关于 neOmega R2”之前。

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

### 从同一帧取得 RGB 图像和深度图

创建渲染器时开启 `depthOutput`，每次交互预览就会同时把颜色画到传入的画布、把深度写到独立纹理。下面的片段等待一帧预览完成，在下一次绘制前把两份结果一起读成像素数组。完整示例只绘制一次海面，点按画面即可核对同一像素的 RGB 和深度。[运行示例](http://127.0.0.1:2415/r2/color-depth.html) · [示例源码](examples/color-depth.html)

```js
const renderer = await createRenderer(canvas, { assets: "./assets/", depthOutput: true });
const { width, height } = canvas;
await renderer.draw(camera, { width, height, ocean: 0, synchronize: true });
const [rgba, depth] = await Promise.all([renderer.pixels(), renderer.depthPixels()]);

// 两份数组都从左下角逐行排列。这里读取从左上角计数的中心像素。
const x = Math.floor(width / 2), y = Math.floor(height / 2);
const i = (height - 1 - y) * width + x;
const rgb = rgba.subarray(4 * i, 4 * i + 3);
const distance = depth[i];
```

`rgba` 是显示颜色，每像素占四个字节，顺序为 R、G、B、A。`depth` 是 `Float32Array`，每像素一个值，表示首个可见表面沿相机正前方的距离，单位为格。天空为 `-1`。玻璃和水面记录自身的深度，贴图完全透明的孔洞继续向后求交。示例使用默认的原始分辨率，因此两份输出共用宽高。开启超分后，颜色使用画布的显示尺寸，深度保留射线采样尺寸。

实时绘制时可直接使用颜色画布和 `renderer.depth`，省去读回像素的开销。后者提供 `{ texture, width, height }`，首次开启深度输出并成功绘制预览后可用。深度纹理由渲染器管理，以单通道 32 位浮点数存储，可在同一渲染设备上采样。尺寸变化后需重新获取。原生纹理在 WebGPU 中从左上角计数，在 WebGL 2 中从左下角计数。静止累积沿用最近一次预览的深度。默认界面的“设置 → 调试 → 求交显示 → 深度伪色图”可以直接查看深度分布。

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

“屏幕尺寸 1×”指当前渲染窗口实际占用的物理像素，等于窗口的 CSS 宽高乘以设备像素比。渲染、拍照和导出使用同一基准。例如窗口实际宽 1000 像素时，选择 0.5× 会用 500 像素绘制。

WebGPU 的“画面”页可开启**超分画质增强**，默认关闭。XS 和 S 都是超轻量 2× 模型，改善有限，适合渲染分辨率低于窗口实际像素数时使用。模型读取合成、降噪后的原图，每个新样本只增强一次。500 像素的原图可直接生成 1000 像素的画面，其他屏幕尺寸从两倍图缩放。模型随程序分发，离线 HTML 也能使用。[WebSR 模型来源](https://github.com/sb2702/websr/blob/fe080eaac058f332be99af615ea8b53b7d5490f8/WEIGHTS.md)

拍照和导出默认按所选尺寸保存 PNG。需要保留模型生成的全部像素时，可在“输出”中勾选“保存 2× 超分原图”。超采样控制每个像素的采样网格，默认关闭（1×1）。

自建前端可在 `renderer.draw` 和 `renderer.photograph` 中设置 `superResolution` 为 `"cnn-xs"`、`"cnn-s"` 或 `"off"`。`width` 和 `height` 指原始渲染宽高。`draw` 的 `displaySize` 指定显示宽高，省略时沿用原始尺寸。`photograph` 的 `saveSuperResolution2x: true` 让 PNG 保留两倍图，屏幕预览和 PNG 可以复用同一次增强。

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
