# fix-utils

转换器在得到 Java 方块状态后，可以用这里的规则结合邻居补全属性，例如栅栏连接、楼梯形状和门的上下半。Go 模块名为 `neomega-view-utils/fixer`。

- [java-postprocess](java-postprocess/README.md) 提供修复入口和使用示例。[规则说明](java-postprocess/FIXER.md) 记录各项修复的顺序及限制。
- [solidtable](solidtable/) 提供方块六个面的实心查询。[preset](solidtable/preset/) 内嵌默认表，供修复规则判断相邻方块能否连接。

在本目录运行 `go test ./...`。需要更新默认实心表时，在工作区的 `neomega-viewer-core` 目录运行 `go generate ./viewer/resources`，建表器会把结果写入 `solidtable/preset/geometry.nvsolid`。
