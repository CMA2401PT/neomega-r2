# Java 存档邻接修复

转换器得到 Java 状态后，可以用这个库结合相邻方块补全属性，例如栅栏连接、楼梯形状和门的上下半。宿主读取选定版本的六面实心表、状态表、属性域和默认属性，构造查询对象后交给 `fixer.New`。这些对象可以在多个区块之间复用。

[可运行的栅栏示例](example/README.md)展示从生成资源到写回变化的完整流程。[规则说明](java-postprocess/FIXER.md)记录各项修复的顺序和限制。

真实状态的测试读取环境变量 `NEOMEGA_BLOCK_TABLES` 指向的方块表目录。可指向示例生成的 `generated/26.3/java-blocks`。要运行门的 Java → Bedrock → Java 往返用例，还需要该目录中的双向方块转换表，例如工作区 converter 应用生成的完整方块表。
