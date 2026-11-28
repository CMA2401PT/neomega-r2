# neOmega R2

R2 在浏览器的 WebGPU 上以射线渲染 Minecraft 方块世界。本仓库按职责拆分为互不越界的独立模块，并与发布的五个浏览器 ES 模块及两份材质归档一一对应。终端启动器、存档选择器、结构转换与离线导出服务由工作区中的 [neOmega Viewer R2](../apps/neomega-viewer-r2/README.md) 提供。

## 模块与产物对照

| 目录 | 职责 | 包 / 模块名 | 对外产物 |
| --- | --- | --- | --- |
| [r2-core](r2-core/README.md) | **渲染核心**（零运行时依赖）：纯离屏 WebGPU 射线渲染器（RGB 纹理、Depth 纹理、`pick`、`createCapture`）、`WorldSession`、`DataSource`、`MemoryWorld`、`ObjectRegistry`。 | `neomega-r2-core` | `r2-core.js` |
| [r2-mc](r2-mc/README.md) | Java 世界的特殊方块、实体和物品外观，以及带实例 ID 的拾取。 | `neomega-r2-mc` | `r2-mc.js` |
| [r2-link](r2-link/README.md) | **浏览器端协议客户端**（零运行时依赖）：通过 WebSocket 连接 `go-link` 数据源，将订阅与区域/对象消息接入 `WorldSession`。 | `neomega-r2-link` | `r2-link.js` |
| [assets-utils](assets-utils/README.md) | **材质资源与编译**：Go 生成方块状态表、几何基表与原始配方；TS 负责制作默认包、解压 ZIP 与浏览器端材质编译。 | `neomega-view-utils/r2assets` / `neomega-r2-materials` | `r2-materials.js`、`default-materials.zip`、`material-info.zip` |
| [r2-frontend](r2-frontend/README.md) | **合成后处理与共享界面**：① `compositor`（单画布降噪、WebSR 2× 超分、基于深度图的图层混合、PNG 导出）；② 共享 HUD/地图/设置与 `mount()`。Go 宿主装配所需网页后自行嵌入。 | `neomega-r2-frontend` | `r2-frontend.js` |
| [go-link](go-link/README.md) | **Go 端协议服务端**：实现 R2Link v4 的区域和近景方块实体订阅。 | `neomega-r2link` | — |
| [fix-utils](fix-utils/README.md) | 按周围方块补全 Java 方块属性，读取宿主提供的六面实心表。 | `neomega-view-utils/fixer` | — |

数据流向自底向上：

```text
DataSource (MemoryWorld / r2linkSource)
  └─▶ r2-mc（解释 Java 近景快照）──▶ WorldSession ──▶ r2-core (离屏 WebGPU：RGB 纹理 + Depth 纹理 + pick)
                         └─▶ r2-frontend/compositor (降噪 → WebSR → 深度混合外部图层 → 单画布上屏 / PNG)
                               └─▶ r2-frontend UI (HUD / 地图 / 设置 / mount())
```

- 只想使用标准界面与内置默认材质：加载 `r2-frontend.js` 调用 `mount()`，见 [r2-frontend 说明](r2-frontend/README.md)。
- 希望自建界面或自组后处理管线：加载 `r2-core.js`，按需搭配 `r2-link.js`、`r2-materials.js`（或解压后的 `assets/`）以及同版本材质包，见 [r2-core 说明](r2-core/README.md)。

## 在 HTML 中加载

如果页面需要完整查看器，从 COS 导入 `r2-frontend.js` 即可。这个入口内含渲染核心、Minecraft 外观、界面和默认材质。下面是一份完整的 HTML，在支持 WebGPU 的浏览器中通过 HTTPS 或 localhost 打开，就能看到一块草地。

```html
<!doctype html>
<meta charset="utf-8">
<title>R2 草地示例</title>
<style>body { margin: 0 } #world { height: 100dvh }</style>
<div id="world"></div>
<script type="module">
  import { MemoryWorld, memorySource, mount } from "https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-frontend.js";

  // 此入口的 MemoryWorld 可以存放 Java 方块、方块实体和普通实体。
  const world = new MemoryWorld();
  world.fill([0, 0, 0], [31, 0, 31], 'minecraft:grass_block ["snowy"="false"]');
  await mount(document.querySelector("#world"), {
    source: memorySource(world),
    camera: { position: [16, 8, 32], yaw: 0, pitch: -0.45 },
  });
</script>
```

### 六个单文件示例

每一行是同一层的两种用法。选择一个 HTML 单独保存，用支持 WebGPU 的 Chrome 打开，页面就会从 COS 加载所需模块和材质。运行本地 `npm run demo` 后，也可以在 `http://127.0.0.1:2415/release/文件名` 预览同一示例。

| 接入层 | 使用这一层的主要能力 | 接入自己的 DataSource |
| --- | --- | --- |
| `r2-core` | [读取颜色与深度](examples/color-depth.html)。移动指针，比较海面和天空的像素。 | [按需生成地板](examples/core-datasource.html)。把数据源交给 `WorldSession`，用 `sink.region()` 交付方块，用 `sink.objects()` 回应近景对象请求。 |
| `r2-mc` | [拾取物品展示框](examples/mc-item-frame.html)。点击钻石剑，读出写入内存世界时指定的实体 ID。 | [按近景订阅交付展示框](examples/mc-datasource.html)。把数据源交给 `createMinecraftWorld()`，用 `sink.near()` 提交订阅范围内的 Java 实体快照。 |
| `r2-frontend` | [用标准查看器打开草地](examples/standalone.html)。用 `mount()` 挂载内存世界，移动相机后可一键回到起点。 | [在查看器里按需生成草地](examples/datasource.html)。把数据源直接传给 `mount()`，切换区域时查看新增与移出的订阅坐标。 |

自定义数据源实现三个方法。`open(sink)` 接收交付数据的入口，`want(change)` 接收相机所需的区域和近景变化，`close()` 在会话结束时释放资源。核心页和 MC 页由宿主推进会话，前端页由查看器随相机移动自动推进。

### 自建画布时选择模块

- **只需要渲染结果**时，用 `createRenderer()` 创建离屏渲染器。用 `openMaterialPack()` 打开默认材质包，把返回的读取函数作为 `readResource` 传给渲染器。[渲染核心](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-core.js) · [材质工具](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-materials.js) · [默认材质包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/default-materials.zip)
- **需要 Minecraft 外观和实体拾取**时，在已有渲染器上调用 `createMinecraftWorld()`。浏览器会从 `r2-mc.js` 同目录加载 `r2-core.js`。展示框等专用素材随 MC 模块分发，基础方块材质仍由渲染器读取。[Minecraft 模块](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-mc.js) · [接入示例](r2-mc/README.md#创建与驱动)

连接远端世界时，`r2linkSource()` 把 WebSocket 连接包装成数据源。自建界面需要在运行时导入用户材质包时，材质工具还需要同版本的合成信息包。[R2Link 客户端](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-link.js) · [合成信息包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/material-info.zip)

COS 地址会随发布更新。要固定版本，可从一次 GitHub Actions 构建下载 `r2-browser`，把所需 JS 和配套材质部署到自己的站点。

## 构建与测试

仓库根目录通过 npm workspaces 管理 `r2-core`、`r2-mc`、`r2-link`、`assets-utils` 与 `r2-frontend`（需要 Node.js 24+ 与 Go 1.25.5+；Go 模块的本地替换路径指向工作区同级的 `neomega-blocks` 和 `neomega-nbt`）：

```sh
npm ci
npm run build
npm run check
python3 assets-utils/resourcegen/generate.py --java 26.3
export R2_GENERATED="$PWD/assets-utils/generated/26.3"
export NEOMEGA_BLOCK_TABLES="$R2_GENERATED/java-blocks"
npm test
go test ./go-link/... ./fix-utils/... ./assets-utils/...
```

[浏览器发布说明](scripts/release-browser/README.md)给出独立播放器、Go 宿主网页及本地演示的装配命令。

主分支构建成功后，GitHub Actions 会将 `r2-browser` 上传至腾讯云 COS。也可以在仓库根目录运行 `npm run publish:cos`，使用当前环境中的 `T_COS_SECRET_ID` 和 `T_COS_SECRET_KEY` 发布本地产物。指定构建目录及 COS 地址的用法见[本地发布说明](scripts/release-browser/README.md#从本地发布到-cos)。
