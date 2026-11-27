# Minecraft 世界接口

`r2-mc` 将 Java 方块状态和近景 SNBT 转成渲染核心接受的几何与贴图。它复用宿主创建的渲染器。宿主选择素材、推进世界会话，并决定如何呈现渲染结果。

## 提交世界

数据源沿用核心的 `open`、`want` 和 `close`。收到区域请求时，用 `sink.region(x, z, data)` 提交编码的状态哈希。收到近景请求时，按订阅的区域、圆心和半径提交一次完整快照。

```ts
sink.near(x, z, {
  blockEntities: [[[5, 64, 7], '{Command:"say hi"}']],
  entities: [["画框一", '{id:"minecraft:item_frame",Pos:[5.5d,64.5d,7.5d],Facing:2b}']],
})
```

同一范围的新快照整体替换旧记录，空列表撤下该类全部记录。方块实体由整数格坐标标识。普通实体的字符串 ID 由数据源分配，在同一世界内唯一，位置、外观或快照顺序变化时沿用。SNBT 中的 `id` 指定 Java 实体类型。

## 创建与驱动

以下代码使用同目录下的浏览器模块，以及宿主生成的基础材质目录。默认的特殊方块与物品素材随模块提供，本地图片、图集和字模的布局与对应模型匹配。

```js
import { createRenderer } from "./r2-core.js"
import { createMinecraftWorld, defaultMinecraftAssets, MinecraftMemoryWorld, minecraftMemorySource } from "./r2-mc.js"

const renderer = await createRenderer({ assets: "./assets/" })
const data = new MinecraftMemoryWorld()
data.set(0, 0, 0, "minecraft:stone")
const { session, pick } = createMinecraftWorld(renderer, minecraftMemorySource(data), {
  assets: defaultMinecraftAssets,
})

const camera = { position: [0.5, 0.5, 4], yaw: 0, pitch: 0 }
function frame() {
  session.focus(camera.position, { nearRadius: 2, farRadius: 8 })
  session.publish()
  renderer.render(camera, { width: 320, height: 240, ocean: 0 })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
```

场景就绪后，调用 `await pick(camera, { x: 160, y: 120, width: 320, height: 240 })` 拾取中心像素。命中返回所属格坐标和法线，命中普通实体时还返回输入的 `entityId`。未命中返回 `null`。宿主退出时停止帧循环，调用 `session.dispose()` 和 `renderer.dispose()`。

内存场景可用 `data.setBlockEntity(position, snbt)` 写入方块原文，传 `null` 删除。用 `data.setEntities([sx, sy, sz], [[entityId, snbt]])` 替换一个 16 格子区块的实体，再调用 `data.commit()` 通知活动订阅。

## 方块与展示框的外观

小麦、陶罐和旗帜都有基础模型。核心按 Java 方块状态哈希查本地模型表。资源生成时已算好每个模型面伸进哪些邻格，准备线程据此把面登记到世界里的对应格子。小麦的生长阶段属于方块状态，所以只用这条路径就可以画出整株小麦。

近景里的陶罐和旗帜还可能有一层由 SNBT 决定的外观。r2-mc 读陶片字段，为每个有纹样的罐面选择现成贴图中的一块。对旗帜，r2-mc 把底色和各层图案合成一张旗面。告示牌的文字也会排成贴图。r2-mc 把有纹样或文字的表面拆成静态三角形，准备线程逐面登记到相交的格子。GPU 沿射线检查格子内的基础模型和附加表面，按命中距离处理遮挡。

同图案的旗帜、同版式和文字样式的告示牌分别共享贴图。最后一个使用者退出近景时，核心会释放对应的图集空间。移出近景的方块仍显示基础模型。附魔台的活动书也只在近景出现。只改罐内物品时，陶片外观仍可复用。

具体方块的图案、字模和动画随 [special-blocks](src/special-blocks/) 分发。合成在浏览器主线程完成，准备线程登记部件覆盖的格子，GPU 完成射线求交。告示牌字模取自 Java 默认位图字体和 GNU Unifont 16.0.01，来源和许可见 [素材声明](src/special-blocks/NOTICE.md)。

框体模板、底板和桦木边纹取自 Minecraft Java 26.3 客户端，随 [展示框实现](src/entities/item-frame/) 分发，权利归原权利人。挂载方向参考了 [viewer-core 的实体实现](https://github.com/CMA2401PT/neomega-viewer-core/tree/main/viewer/entity_render)。

框内物品由 `Item.id` 或物品栈的 `minecraft:item_model` 组件选定。图标用两个三角形组成一张双面矩形，透明像素让射线穿过。方块物品使用 Java 模型的固定展示姿态，保留楼梯等模型的立体形状。`ItemRotation` 每增加一档，就将内容绕框面中心转动 45°。框体和物品共用一个拾取标识，点击任一可见部分都会返回同一实例 ID。

固定物品表和贴图随 r2-mc 分发，来源为 Java 26.3。该表覆盖静态模型。动画材质取第一帧，半透明纹素沿用核心的透明裁切。对于没有静态模型的物品（例如指南针），可见框保留框体，完整物品数据仍可查看。[物品实现与素材](src/items/)
