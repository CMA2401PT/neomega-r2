# R2 材质资源 (`neomega-view-utils/r2assets` & `neomega-r2-materials`)

方块数据只携带状态哈希。渲染器需要同版本的状态映射、模型和贴图，才能把每个哈希画成对应的方块。要让用户替换纹理，还需要知道各个面的贴图名、采样方向和原版像素。本目录统一承担服务端/构建期材质生成与浏览器端材质解压编译：

- `default-materials.zip`：可以直接绘制方块和附魔书。使用 `r2-core.js` 时，可将 ZIP 字节交给 `r2-materials.js` 的 `openMaterialPack`，也可解压后用 `assets` 指向其中的 `assets/` 目录。Go 宿主将自己的 ZIP 字节交给 `r2assets.OpenArchive`，通过返回对象读取条目。
- `material-info.zip`：保存原版图集、贴图配方，以及重算模型分类所用的三张基表。
- [r2-materials.js](scripts/build.mjs)（包名 `neomega-r2-materials`）：浏览器端独立 ESM 入口，提供 `openMaterialPack` 与 `compileMaterialPack`（在 Worker 中编译 Java / 基岩版材质包为 `TextureSet`）。

```js
import { compileMaterialPack } from "./r2-materials.js";

const info = new Uint8Array(await (await fetch("./material-info.zip")).arrayBuffer());
const set = await compileMaterialPack(info, fileInput.files[0], 128);
await session.setTextures(set);
```

基岩高度图按相邻纹素高度差以 1/16 强度生成法线，并按灰度差向内下沉（全量程对应 1/32 格）。

## 生成资源

在本目录执行 `python3 resourcegen/generate.py --java 26.3` 即可取得该版本的全部资源。生成结果按版本和主题写进 `generated/`。只想查某个方块的俯视颜色时，可加 `--topic top-colors`。各主题的输入、使用者、工具依赖及完整命令见[资源生成说明](resourcegen/README.md)。

Go 宿主从应用自选的字节构造 `r2assets.OpenArchive`，按文件读取模型和纹理。材质包与前端的组合由[浏览器发布脚本](../scripts/release-browser/README.md)负责。客户端模型、纹理及社区模板的署名与许可见[来源说明](resourcegen/java-assets/NOTICE.md)。
