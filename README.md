# neOmega R2

R2 把方块世界绘制到浏览器的 WebGPU 或 WebGL 2 画布。这个仓库包含渲染引擎、Go 数据源协议实现，以及准备方块状态和材质的工具。画布上的工具栏、地图、坐标编辑和设置由 [r2/common_ui](r2/common_ui/) 提供，静态 demo 和 Viewer 共用。终端启动器、文件选择器和存档连接由工作区中的 [Viewer 应用](../apps/neomega-viewer-r2/README.md) 提供。

| 目录 | 负责什么 | Go 模块名 |
| --- | --- | --- |
| [r2](r2/README.md) | 浏览器端世界会话、R2Link 客户端、模型准备、WebGL 绘制与共享查看界面。Go 宿主可嵌入构建产物。 | `neomega-r2` |
| [go-link](go-link/README.md) | 实现 R2Link 的 Go 端。数据源通过 WebSocket 接收订阅，发送区域、特殊对象和相机消息。 | `neomega-r2link` |
| [fix-utils](fix-utils/README.md) | 按周围方块补全 Java 方块属性，提供邻接规则使用的实心表。 | `neomega-view-utils/fixer` |
| [assets-utils](assets-utils/README.md) | 生成默认材质包和合成信息包。 | `neomega-view-utils/r2assets` |

单 HTML 页面可直接加载 `r2-frontend.js` 使用标准界面和默认材质。自建界面使用 `r2-core.js`，并指定同版本的模型和贴图。世界数据可以在浏览器内提供，也可用 `r2-link.js` 通过 WebSocket 订阅远端区域。[页面接入与示例](r2/README.md#接入自己的页面)

## 在 HTML 中加载

三个 JS 都可以按 ES 模块单独加载。例如标准前端包含默认材质和材质导入界面，页面可以直接导入它的接口。

```html
<script type="module">
  import { mount, MemoryWorld, memorySource } from "https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-frontend.js";
</script>
```

自建界面可使用[渲染核心](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-core.js)。需要订阅远端数据源时可加载 [R2Link 客户端](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/r2-link.js)。[默认材质包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/default-materials.zip)提供绘制所需的模型和贴图，[合成信息包](https://omega-1259160345.cos.accelerate.myqcloud.com/r2/material-info.zip)用于导入自选材质。

这些地址跟随主分支更新。需要固定依赖时，在 `/r2/` 后加入一次已发布构建的完整 Git 提交号；JS 和材质包应使用同一个提交号。

## 构建与测试

从 GitHub Actions 的“构建浏览器入口与材质包”工作流下载 `r2-browser`，可取得三个独立 JS 和两个材质 ZIP。推送、拉取请求和手动运行都会从源模型与贴图重建资源，再将同一版本的资源嵌入前端。

主分支构建成功后，工作流把同一份产物上传到腾讯云 COS。发布任务从 GitHub Actions 的 Repository secrets 读取 `T_COS_SECRET_ID` 和 `T_COS_SECRET_KEY`。`T_COS_SERVICE_URL` 和 `T_COS_ACCESS_URL` 可以通过同名 secrets 或 variables 覆盖。跨站页面加载 ES 模块和材质需要 COS 允许匿名读取这些对象，并允许来源跨域 GET。

在本仓库根目录运行以下命令。渲染引擎使用 Node.js 22.18 或以上版本，Go 模块使用 Go 1.25.5。Go 模块的本地替换路径指向工作区同级的 `neomega-blocks` 和 `neomega-nbt`。

```sh
npm --prefix r2 ci
(cd assets-utils && go generate)
npm --prefix r2 run build
npm --prefix r2 run check
npm --prefix r2 test
go test ./r2/... ./go-link/... ./fix-utils/... ./assets-utils/...
```

最后一条命令使用上一级工作区的 `go.work`。单独使用某个 Go 模块时，可以在对应子目录运行 `go test ./...`。构建 Go 宿主前先构建 `r2/dist/`，该目录由引擎的 Go 包嵌入。
