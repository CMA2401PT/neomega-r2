# 用相邻石头修复栅栏

示例先生成一个 Java 版本的状态、默认属性、属性域和实心面表，再从文件读取它们并创建修复器。中心格子是一段未填写连接属性的橡木栅栏，东边紧邻一块石头。修复器查到石头的西面实心，返回带有 `east="true"` 的栅栏状态。

在本目录运行。需要 Go、Python 和 uv，目录布局与[资源生成说明](../../assets-utils/resourcegen/README.md)一致。

```sh
go generate
go run .
```

示例选择 Java 26.3。要使用自己选择的版本，可直接调用同一个生成器，并让示例读取对应的版本目录。

```sh
python3 ../../assets-utils/resourcegen/generate.py --java 1.21.4 \
  --topic java-blocks --topic solid-faces --out generated
go run . -resources generated/1.21.4
```
