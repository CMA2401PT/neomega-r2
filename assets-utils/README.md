# assets-utils

这里保存 R2 默认的方块模型、纹理，以及从材质包生成替换资源的工具。Go 导入路径为 `neomega-view-utils/r2assets`，包名为 `r2assets`。

- [sourceassets](sourceassets/) 保存生成时使用的几何、材质和原始图集。可以打开 [atlas.png](sourceassets/atlas.png) 查看源纹理。素材来源见 [第三方声明](sourceassets/THIRD_PARTY_NOTICES.txt)。
- [assets](assets/) 保存随程序分发的资源，包括状态到模型的映射、几何表和颜色、法线、高光贴图。宿主通过 `r2assets.Files` 提供这些文件，渲染器再通过 HTTP 加载它们。
- `r2assets.OpenCatalog` 读取默认模型目录。`r2assets.BuildTextures(path, maxSize)` 从目录或 ZIP 合成材质包，传入空路径使用默认材质。

从本目录运行 `go generate` 可根据源数据重建 `assets/`。运行 `go test ./...` 检查模型表、方块状态映射与材质包转换。
