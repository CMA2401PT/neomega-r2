# neOmega R2

R2 在浏览器的 WebGPU 上以射线渲染 Minecraft 方块世界。本仓库按职责拆分为互不越界的独立模块，并与发布的四个浏览器 ES 模块及两份材质归档一一对应。终端启动器、存档选择器、结构转换与离线导出服务由工作区中的 [neOmega Viewer R2](../apps/neomega-viewer-r2/README.md) 提供。

## 模块与产物对照

| 目录 | 职责 | 包 / 模块名 | 对外产物 |
| --- | --- | --- | --- |
| [r2-core](r2-core/README.md) | **渲染核心**（零运行时依赖）：纯离屏 WebGPU 射线渲染器（RGB 纹理、Depth 纹理、`pick`、`createCapture`）、`WorldSession`、`DataSource`、`MemoryWorld`、`ObjectRegistry`。 | `neomega-r2-core` | `r2-core.js` |
| [r2-link](r2-link/README.md) | **浏览器端协议客户端**（零运行时依赖）：通过 WebSocket 连接 `go-link` 数据源，将订阅与区域/对象消息接入 `WorldSession`。 | `neomega-r2-link` | `r2-link.js` |
| [assets-utils](assets-utils/README.md) | **材质资源与编译**：Go 生成方块状态表、几何基表与原始配方；TS 负责制作默认包、解压 ZIP 与浏览器端材质编译。 | `neomega-view-utils/r2assets` / `neomega-r2-materials` | `r2-materials.js`、`default-materials.zip`、`material-info.zip` |
| [r2-frontend](r2-frontend/README.md) | **合成后处理与共享界面**：① `compositor`（单画布降噪、WebSR 2× 超分、基于深度图的图层混合、PNG 导出）；② 共享 HUD/地图/设置与 `mount()`。Go 宿主嵌入精简 `dist/web/`。 | `neomega-r2-frontend` | `r2-frontend.js` |
| [go-link](go-link/README.md) | **Go 端协议服务端**：实现 R2Link v2 服务端会话、`effector` 与 `blockactor`。 | `neomega-r2link` | — |
| [fix-utils](fix-utils/README.md) | 按周围方块补全 Java 方块属性，提供邻接规则使用的实心表。 | `neomega-view-utils/fixer` | — |

数据流向自底向上：

```text
DataSource (MemoryWorld / r2linkSource)
  └─▶ WorldSession ──▶ r2-core (离屏 WebGPU：RGB 纹理 + Depth 纹理 + pick)
                         └─▶ r2-frontend/compositor (降噪 → WebSR → 深度混合外部图层 → 单画布上屏 / PNG)
                               └─▶ r2-frontend UI (HUD / 地图 / 设置 / mount())
```

- 只想使用标准界面与内置默认材质：加载 `r2-frontend.js` 调用 `mount()`，见 [r2-frontend 说明](r2-frontend/README.md)。
- 希望自建界面或自组后处理管线：加载 `r2-core.js`，按需搭配 `r2-link.js`、`r2-materials.js`（或解压后的 `assets/`）以及同版本材质包，见 [r2-core 说明](r2-core/README.md)。

## 在 HTML 中加载

发布的四个浏览器 ESM 入口与两个材质归档可直接在静态页面导入：

```html
<script type="module">
  import { mount, MemoryWorld, memorySource } from "https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-frontend.js";
</script>
```

自建前端可使用[渲染核心](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-core.js)，订阅远端数据源可加载 [R2Link 客户端](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-link.js)，解压或运行时编译材质包可加载 [材质工具](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-materials.js)。[默认材质包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/default-materials.zip)提供绘制所需的模型和贴图，[合成信息包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/material-info.zip)用于运行时导入自选材质包。

这些固定地址随主分支的成功构建更新。需要锁定版本时，可从 GitHub Actions 的“构建浏览器入口与材质包”工作流下载 `r2-browser`，把其中的 JS 和材质包一同部署在自己的站点。

## 构建与测试

仓库根目录通过 npm workspaces 管理 `r2-core`、`r2-link`、`assets-utils` 与 `r2-frontend`（需要 Node.js 24+ 与 Go 1.25.5+；Go 模块的本地替换路径指向工作区同级的 `neomega-blocks` 和 `neomega-nbt`）：

```sh
npm ci
(cd assets-utils && go generate)
npm run build
npm run check
npm test
go test ./r2-frontend/... ./go-link/... ./fix-utils/... ./assets-utils/...
```

启动本地演示服务：

```sh
npm run demo
```

构建 Go 宿主前需先执行 `npm run build`，它会生成 `r2-frontend/dist/web/`（由 Go 包 `neomega-r2-frontend` 嵌入）。

主分支构建成功后，GitHub Actions 会调用 [scripts/publish-cos.py](scripts/publish-cos.py) 将 `r2-browser` 上传至腾讯云 COS（需要 secrets `T_COS_SECRET_ID` 与 `T_COS_SECRET_KEY`，可选覆盖 `T_COS_SERVICE_URL` 和 `T_COS_ACCESS_URL`）。
