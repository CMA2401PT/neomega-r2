# assets-utils

这里保存 R2 默认的方块模型、纹理，以及从材质包生成替换资源的工具。Go 导入路径为 `neomega-view-utils/r2assets`，包名为 `r2assets`。

- [sourceassets](sourceassets/) 保存生成时使用的几何、材质和原始图集。可以打开 [atlas.png](sourceassets/atlas.png) 查看源纹理。素材来源见 [第三方声明](sourceassets/THIRD_PARTY_NOTICES.txt)。
- [assets.zip](assets.zip) 保存随程序分发的资源，包括状态到模型的映射、几何表和颜色、法线、高光贴图。演示服务和离线导出工具直接读取归档。部署到普通静态服务器时，解压归档即可得到可挂载的 `assets/` 目录。Go 程序嵌入压缩后的 `assets.zip`，通过 `r2assets.Files` 按原文件名读取内容。Viewer 可直接将归档中的压缩数据作为 gzip 响应发送给浏览器，浏览器解压后再上传给 GPU。
- `r2assets.OpenCatalog` 读取默认模型目录。`r2assets.BuildTextures(path, maxSize)` 从目录或 ZIP 合成材质包，传入空路径时按指定的贴图尺寸合成原版材质。

从本目录运行 `go generate` 可根据源数据重建 `assets.zip`。运行 `go test ./...` 检查模型表、方块状态映射与材质包转换。
