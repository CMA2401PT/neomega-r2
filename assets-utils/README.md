# R2 材质资源

方块数据只携带状态哈希。渲染器需要同版本的状态映射、模型和贴图，才能把每个哈希画成对应的方块。要让用户替换纹理，还需要知道各个面的贴图名、采样方向和原版像素。这两种输入分别发布为 ZIP。

- [默认材质包](default-materials.zip) 可以直接绘制方块和附魔书。使用 `r2-core.js` 时，可将 ZIP 字节交给 `openMaterialPack`，也可解压后用 `assets` 指向其中的 `assets/` 目录。Go 宿主通过 `r2assets.Files` 读取同一归档。
- [合成信息包](material-info.zip) 保存原版图集、贴图配方，以及重算模型分类所用的三张基表。核心调用者用 `compileMaterialPack` 传入该归档与用户选择的材质。标准前端已内嵌两个匹配的归档。

## 重建材质

[sourceassets](sourceassets/) 是建表所用的几何、原始材质和图集。Go 生成方块状态映射、几何和配方，Node 再运行浏览器使用的 TypeScript 合成算法，写出两个归档。分发带默认材质的前端时，请随附[素材来源声明](sourceassets/THIRD_PARTY_NOTICES.txt)。

在本目录运行以下命令。

```sh
npm ci --prefix ../r2
go generate
go test ./...
npm --prefix ../r2 test
```

Go 测试检查模型与方块状态映射。TS 测试将空覆盖包的合成结果与归档逐字节比较，并检查用户贴图的透明孔、缩小层、动画首帧与基岩材质通道。
