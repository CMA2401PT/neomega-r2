# R2 材质资源 (`neomega-view-utils/r2assets` & `neomega-r2-materials`)

方块数据只携带状态哈希。渲染器需要同版本的状态映射、模型和贴图，才能把每个哈希画成对应的方块。要让用户替换纹理，还需要知道各个面的贴图名、采样方向和原版像素。本目录统一承担服务端/构建期材质生成与浏览器端材质解压编译：

- [default-materials.zip](default-materials.zip)：可以直接绘制方块和附魔书。使用 `r2-core.js` 时，可将 ZIP 字节交给 `r2-materials.js` 的 `openMaterialPack`，也可解压后用 `assets` 指向其中的 `assets/` 目录。Go 宿主通过 `r2assets.Files` 读取同一归档。
- [material-info.zip](material-info.zip)：保存原版图集、贴图配方，以及重算模型分类所用的三张基表。
- [r2-materials.js](scripts/build.mjs)（包名 `neomega-r2-materials`）：浏览器端独立 ESM 入口，提供 `openMaterialPack` 与 `compileMaterialPack`（在 Worker 中编译 Java / 基岩版材质包为 `TextureSet`）。

```js
import { compileMaterialPack } from "./r2-materials.js";

const info = new Uint8Array(await (await fetch("./material-info.zip")).arrayBuffer());
const set = await compileMaterialPack(info, fileInput.files[0], 128);
await session.setTextures(set);
```

基岩高度图按相邻纹素高度差以 1/16 强度生成法线，并按灰度差向内下沉（全量程对应 1/32 格）。

## 重建与测试

[sourceassets](sourceassets/) 是建表所用的几何、原始材质和图集。Go 生成方块状态映射、几何和配方，Node 再运行同目录的 TypeScript 合成算法写出两个归档。分发带默认材质的前端时，请随附[素材来源声明](sourceassets/THIRD_PARTY_NOTICES.txt)。

在 `neomega-r2` 根目录安装依赖后，于本目录运行：

```sh
npm ci --prefix ..
go generate
go test ./...
npm run build
npm run check
npm test
```

Go 测试检查模型与方块状态映射。TS 测试将空覆盖包的合成结果与归档逐字节比较，并检查用户贴图的透明孔、缩小层、动画首帧与基岩材质通道。
