# 普通静态物品

`item_render` 把物品资源编译成可以独立摆放的静态网格。物品 ID 先通过客户端 `items/*.json` 找到真实模型，再与方块共用模型解析器和公共图集。物品名称不决定模型路径，例如一个物品可以直接引用 `block/` 模型。

生成器将模型继承、纹理和 `fixed` 展示变换编译进 `Catalog`。`fixed` 是 Java 资源中用于展示框的缩放、旋转和平移。运行时的 `Renderer.Render` 只按物品 ID 返回几何副本，调用方再把它放进展示框或自己的场景。

## 几何与资源边界

带 `elements` 的模型复用 `java_block_model.Bake`，保留实际元素几何。继承 `builtin/generated` 的模型按各层纹理的透明轮廓生成侧壁，并保留带透明裁剪的正反面。侧壁厚度为一个方块的 1/16，位于模型深度 7.5/16 至 8.5/16。编译后以展示中心为原点，并应用一次继承后的 `fixed`。

物品目录与方块几何表 使用同一次构建的图集。纹理的动画条带和帧时保留在材质中，静态网格也可以播放纹理动画。`Render` 返回的四边形可以修改，共享目录在整个使用期间保持只读。

接受没有 tint 或仅含常量 tint 的普通 `minecraft:model` 定义，并在建表时解析固定展示可确定的选择树：`display_context=fixed`，未使用的弓、弩、刷子、钓竿、三叉戟、望远镜，以及未装填、无纹饰和无额外方块属性的缺省模型。未知属性、时间和指南针方向等依赖场景的分支、特殊模型、动态 tint 和地图内容仍返回不支持诊断。模型或纹理引用损坏会使生成失败，不会当作正常空物品交付。

## 取得一个物品网格

[物品模型生成器](../resourcegen/item-models/generate.go) 使用 Java 模型和图集，把客户端物品定义编译成目录，并写出 `static-item-models.json.gz`。目录和同一次生成的 `block-atlas.png` 配套使用。

拿到物品目录后即可查询指定物品的静态几何。例如，建表器可以用以下代码检查钻石剑模型。

```go
bundle, err := java_block_model.Load(assetsDir)
if err != nil {
    return err
}
catalog, err := itemmodels.Generate(assetsDir, bundle)
if err != nil {
    return err
}
mesh, err := item_render.New(catalog).Render("minecraft:diamond_sword")
if err != nil {
    return err
}
fmt.Println(len(mesh.Quads))
```

常量 tint 由物品定义按索引保存，在烘焙时应用于对应面；生成式物品的正反面与侧面都使用所属纹理层的 tint 索引。没有对应 tint 源的面保持原色，因此樱花树叶、苍白橡树树叶和切石机不会仅因模型含 tintindex 被拒绝。草地色图、皮革染色和药水等动态 tint 暂不支持。
