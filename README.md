# neOmega R2

R2 把方块世界绘制到浏览器的 WebGL 2 画布。这个仓库包含渲染引擎、Go 数据源协议实现，以及准备方块状态和材质的工具。画布上的工具栏、地图、坐标编辑和设置由 [r2/common_ui](r2/common_ui/) 提供，静态 demo 和 Viewer 共用。终端启动器、文件选择器和存档连接由工作区中的 [Viewer 应用](../apps/neomega-viewer-r2/README.md) 提供。

| 目录 | 负责什么 | Go 模块名 |
| --- | --- | --- |
| [r2](r2/README.md) | 浏览器端世界会话、R2Link 客户端、模型准备、WebGL 绘制与共享查看界面。Go 宿主可嵌入构建产物。 | `neomega-r2` |
| [go-link](go-link/README.md) | 实现 R2Link 的 Go 端。数据源通过 WebSocket 接收订阅，发送区域、特殊对象和相机消息。 | `neomega-r2link` |
| [fix-utils](fix-utils/README.md) | 按周围方块补全 Java 方块属性，提供邻接规则使用的实心表。 | `neomega-view-utils/fixer` |
| [assets-utils](assets-utils/README.md) | 提供默认方块模型和贴图，将自定义材质包转换为渲染器读取的资源。 | `neomega-view-utils/r2assets` |

其中有两条数据通路。宿主通过 HTTP 提供引擎和默认资源，浏览器从中取得方块的外观。打开世界后，浏览器通过 R2Link 订阅相机周围的区域，从数据源取得各位置的方块。

## 构建与测试

在本仓库根目录运行以下命令。渲染引擎使用 Node.js 22.18 或以上版本，Go 模块使用 Go 1.25.5。Go 模块的本地替换路径指向工作区同级的 `neomega-blocks` 和 `neomega-nbt`。

```sh
npm --prefix r2 ci
npm --prefix r2 run build
npm --prefix r2 run check
npm --prefix r2 test
go test ./r2/... ./go-link/... ./fix-utils/... ./assets-utils/...
```

最后一条命令使用上一级工作区的 `go.work`。单独使用某个 Go 模块时，可以在对应子目录运行 `go test ./...`。构建 Go 宿主前先构建 `r2/dist/`，该目录由引擎的 Go 包嵌入。
