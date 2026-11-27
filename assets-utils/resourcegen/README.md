# 生成 Java 渲染与修复资源

生成器接收 Java 版本，从客户端 JAR 提取模型和纹理，再用同版本的 Java 方块状态烘焙几何。一份几何可以同时用于修复、俯视图和浏览器材质。每个主题只构建它需要的前置资源，最终把请求的产物放在 `<输出根>/<Java版本>/<主题>/`。

| 主题 | 输入 | 产物和用途 |
| --- | --- | --- |
| `java-blocks` | neomega-blocks 的 Java 状态、兼容关系、属性域和默认属性生成器 | 提供 fix-utils 构造查询所需的四份文件。 |
| [java-assets](java-assets/README.md) | 客户端 JAR 和特殊方块模板 | 模型定义、渲染规则、图集像素 `block-atlas.png` 及配套坐标。 |
| [block-geometry](block-geometry/tables.go) | 客户端资源和单层方块状态 | `block-geometry.nvtables` 记录每个状态的几何，`static-block-renderers.json` 说明生成的版本、渲染类别和跳过的状态。 |
| [solid-faces](solid-faces/generate.go) | 方块几何 | `solid-faces.nvsolid` 用六个位记录各面是否完全实心，供邻接修复查询。 |
| [top-colors](top-colors/color.go) | 方块几何与图集像素 | `top-colors.nvcolor` 保存俯视颜色，供 full-view 和六面材质生成器使用。 |
| [item-models](item-models/generate.go) | 物品定义、模型与图集 | `static-item-models.json.gz` 保存可放进展示框的静态几何，配套图集来自 java-assets。 |
| [cube-materials](cube-materials/generate.go) | 状态、几何、俯视颜色和图集 | `cube-materials.bin` 保存可按六个完整面绘制的方块材质。 |
| [browser-materials](browser-materials/recipe.go) | 状态映射、几何、六面材质和客户端纹理 | `default-materials.zip` 供直接绘制，`material-info.zip` 供浏览器导入用户材质包。 |

## 从指定版本生成

在 `neomega-r2/assets-utils` 目录执行。生成方块资源需要 Go、Python 3.9 或以上、uv 和同级工作区中的 neomega-blocks 与 neomega-nbt。完整生成还使用 Node.js 24 和仓库锁定的 npm 依赖。

```sh
npm ci --prefix ..
python3 resourcegen/generate.py --java 26.3 --out generated
```

已有同版本的客户端可传 `--jar /路径/client.jar`。特殊方块的默认社区输入位于 [special/templates](java-assets/special/templates/README.md)，可以用 `--templates` 指向另一份含索引的目录。客户端提供的原始像素和模型应与随产物交付的来源声明一同分发。

只生成修复器所需的文件时可以直接运行下面的命令。两个主题共用同一次状态提取；这条路径只用 Go、Python 和 uv。如何把这些文件交给修复器见[完整示例](../../fix-utils/example/README.md)。

```sh
python3 resourcegen/generate.py --java 1.21.4 --out generated \
  --topic java-blocks --topic solid-faces
```

已有几何表的 Go 程序也可以直接调用主题函数。例如，将几何文件交给 `geometry.DecodeTables[uint32](reader)`，再调用 `solidfaces.Generate(tables)` 即得到可查询或编码的实心面表。
