# neomega-r2link：R2 浏览器与世界数据源之间的协议

R2Link 让游戏机器人、服务器插件或存档服务把方块世界交给 [R2 渲染器](../r2-core/README.md)显示。数据源监听 WebSocket，浏览器作为客户端连接它。浏览器的世界会话按相机位置决定需要哪些区域，告诉数据源；数据源回送压缩区域、近景方块实体、普通实体和相机指令。浏览器不保存世界，所以数据源只需要能按区域读取，不必关心浏览器缓存了什么。

[neomega-viewer-r2](../../apps/neomega-viewer-r2/README.md) 自己的存档与内置场景也走这条路：Go 服务在 `/r2link` 上把当前世界作为数据源提供给同源页面。外部数据源在 HUD 的连接按钮里填写地址。

协议中的 `region` 指 r2region，横向覆盖 8×8 个区块（chunk）。每个区块沿高度分成 16×16×16 方块的子区块（subchunk），一个 `region` 消息携带该范围内有数据的子区块。

Go 服务按订阅发送状态哈希及两类近景数据。方块实体按格子定位，普通实体以数据源提供的实例 ID 定位，世界坐标在 Java SNBT 中。SNBT 是保留 NBT 数据类型的文本格式。浏览器一侧是 neomega-r2 的 `r2linkSource`。

## 消息

一条 WebSocket Binary 消息就是一条 R2Link 消息：

```text
uint32LE  JSON 字节数 n
n 字节    UTF-8 JSON 头，必有 "type"
其余      二进制尾部，可以为空
```

只有 `region` 与 `chunks` 的回复带尾部。未知的 `type` 应当忽略。

### 握手

浏览器连上后先发 `hello`，数据源回 `welcome`：

```json
{"type":"hello","protocol":"r2link","version":4}
{"type":"welcome","protocol":"r2link","version":4,"scene":{"name":"生存服"},"camera":{"position":[120.5,86,-31.5],"yaw":1.2,"pitch":-0.25}}
```

版本不符时数据源回复 `{"type":"error","message":"…"}` 并关闭连接，浏览器把 message 显示为连接失败的原因。`scene.name` 显示在界面上。`camera` 可以省略；位置是方块坐标，朝向是弧度，yaw 为 0 时看向 −Z、正值转向 +X，pitch 为正时向上看，省略朝向表示保留浏览器当前朝向。

### 浏览器发送

| type | 字段 | 含义 |
|---|---|---|
| `want` | `center`、`regions`、`blockEntities` | 需要的区域与近景方块实体的变化，见下文。 |
| `chunks` | | 请求区块占用表。 |

```json
{
  "type": "want",
  "center": [1032.5, -220],
  "regions": {"add": [{"x": 8, "z": -2}], "remove": [{"x": 3, "z": 0}]},
  "blockEntities": {"add": [{"x": 8, "z": -2, "center": [64, 4, -14], "radius": 2}], "remove": []}
}
```

区域是 8×8 区块（128×128 方块）的整根柱子，区域 (x, z) 覆盖方块 `x*128 … x*128+127`。`center` 是远景中心的方块坐标 `[x, z]`，数据源应先供给离它近的区域；`regions.add` 已按由近到远排列。`blockEntities.add` 要求区域内、以区块坐标 `center` 为圆心 `radius` 区块以内的方块实体；高度按子区块计算，距 `center[1]` 最多 `min(radius + 1, 12)` 个子区块。已订阅的区域再次出现在 `add` 里，表示圆心或半径变了。

`want` 是增量。每次握手后浏览器先发一条完整快照（`remove` 为空），之后只发变化。取消订阅的区域与方块实体，数据源应停止读取，晚到的结果浏览器会丢弃。

### 数据源发送

| type | 字段 | 尾部 | 含义 |
|---|---|---|---|
| `region` | `x`、`z`、`clippedSections` | 区域编码 | 区域的全部方块。尾部为空表示区域为空。再次发送同一区域即更新。 |
| `blockEntities` | `x`、`z`、`center`、`radius`、`entries`、可选的 `entities` | | 区域内两类近景数据的完整列表，可以为空。每个 `blockEntities.add` 都要有回复。 |
| `failed` | `x`、`z`、`message` | | 区域读取失败，浏览器显示为失败区域。 |
| `chunks` | `message` | 占用表 | 回复 `chunks` 请求，按请求顺序；`message` 非空表示失败。没有占用表时尾部为空。 |
| `camera` | `camera` | | 让浏览器移动相机，格式同 welcome。 |
| `scene` | `scene` | | 更新世界描述。 |
| `error` | `message` | | 致命错误，随后关闭连接。 |

`clippedSections` 是区域内因超出可显示高度而省略的 section 数，可以省略。`center` 和 `radius` 回显所响应的订阅范围，以便浏览器在移动后丢弃过期回复。每条 `entries` 记录包含整数世界坐标 `position` 和完整的 `snbt` 字符串。普通实体放在 `entities` 数组中，每项是 `[实例 ID, 完整 Java SNBT]`。ID 是字符串，在同一世界内唯一，实体移动时沿用。同一区域的新快照整体替换旧快照，省略 `entities` 或发送空数组都会撤下旧的普通实体。

```json
{"type":"blockEntities","x":0,"z":0,"center":[0,4,0],"radius":2,"entries":[{"position":[5,64,7],"snbt":"{Command:\"say hi\"}"}]}
```

### 区域编码

`region` 的尾部是小端 u32 数组，与 neomega-r2 [区域编码](../r2-core/README.md#区域编码与活动对象)相同：

```text
magic 0x34504c54, section 数
每个 section：
  sx, sy, sz          section 坐标（方块坐标除以 16，有符号）
  bits                每个索引的位数，0 表示整块只有调色板第一项
  count               调色板项数
  length              索引字数
  palette[count]      方块状态的 neomega-blocks 哈希
  words[length]       索引，每字容纳 floor(32 / bits) 个，低位在前，不跨字
```

section 内第 i 个索引对应格子 `x = i >> 8, z = (i >> 4) & 15, y = i & 15`。未列出的 section 视为空气，可显示高度为 Y −64～447。方块状态是 Java 写法，哈希为 `{name, states}` 的小端 NBT 的 FNV-1a 32，Go 用 `BlockHash`，浏览器用 `blockHash`。

### 占用表

`chunks` 的尾部是连续的 136 字节记录，每条覆盖 32×32 个区块：前八字节是小端 int32 的分组坐标 gx、gz（区块坐标除以 32），余下 128 字节是位图。区块 (cx, cz) 的位序号为 `i = (cz & 31) * 32 + (cx & 31)`，第 `i >> 3` 字节的第 `i & 7` 位表示存在，低位在前。

### 断线

断线后浏览器保留已显示的内容，每 3 秒重连。重连从 `hello` 开始，握手后浏览器重新发送完整快照，数据源像对待新连接一样发送全部内容；新内容到达前，旧画面继续显示。首次连接失败时不重试，浏览器报告错误。

## Go 数据源

数据源实现 `Source`，可选实现 `BlockEntitySource`、`EntitySource` 与 `ChunkSource`，然后在 HTTP 处理函数里接受连接并交给 `Serve`：

```go
type world struct{ /* … */ }

// Region 可能被并发调用；ctx 在区域不再需要或连接结束时取消。
func (w *world) Region(ctx context.Context, x, z int) (r2link.Region, error) {
	var region r2link.Region
	for /* 每个非空 section */ {
		var blocks [4096]uint32 // 下标 x<<8 | z<<4 | y
		// blocks[i] = r2link.BlockHash(state)
		region.Sections = append(region.Sections, r2link.Pack([3]int{sx, sy, sz}, &blocks))
	}
	return region, nil
}

http.HandleFunc("/r2link", func(w http.ResponseWriter, r *http.Request) {
	conn, err := r2link.Accept(w, r, nil)
	if err != nil {
		return
	}
	r2link.Serve(r.Context(), conn, source, r2link.Options{Scene: r2link.Scene{Name: "生存服"}})
})
```

`Session` 记录浏览器需要什么，按离远景中心由近到远调用 `Region`（默认 4 个并发），移除的区域取消 ctx 并丢弃结果；同一区域的两次读取不会重叠。不实现 `BlockEntitySource` 时，对象请求得到空列表；不实现 `ChunkSource` 时，占用表为空。

世界变化时用 `NewSession` 拿到会话，再调用：

| 方法 | 作用 |
|---|---|
| `Update(x, z)` | 区域方块变了，浏览器仍需要时重读并发送。 |
| `UpdateBlockEntities(x, z)` | 区域的方块实体或普通实体变了。 |
| `Refresh()` | 整个世界换了内容，重发所有仍需要的区域与对象。 |
| `MoveCamera(ctx, camera)` | 移动浏览器的相机。 |
| `SetScene(ctx, scene)` | 更新世界描述。 |

`Accept` 的第三个参数为 nil 时接受任何页面来源，适合只读的世界数据，查看器可以从别的地址连过来；传 `&websocket.AcceptOptions{}` 只接受同源页面。`Dial` 以浏览器的身份连接，供测试与 Go 客户端使用。

其他工具：`Pack` 把 4096 个哈希压成最小位宽的 section，`EncodeRegion` 写出区域编码，`IsAir` 判断三种空气，`ChunkIndex` 生成占用表。

### 近景方块实体和普通实体

实现 `Entities(ctx, x, z, center, radius) ([]r2link.Entity, error)` 可用同一近景订阅交付普通实体。数据源按位置筛选并序列化完整 Java SNBT，前端按实体的 `id` 选择外观。

实现 `BlockEntities(ctx, x, z, center, radius)` 即可提供近景数据。遍历订阅范围内的方块实体，保留其坐标和全部字段。浏览器根据已有区域中的状态哈希识别附魔台、陶罐、旗帜和告示牌。完整 SNBT 也用于点击查看。外观与固定素材见 [前端实现](../r2-mc/src/special-blocks/)。

## 示例与检查

[java-source](../../apps/neomega-viewer-r2/examples/java-source/main.go) 是最小的数据源，把一个 Java 存档按订阅发送。以下命令在包含 `go.work` 的工作区根目录运行。

```sh
go run ./apps/neomega-viewer-r2/examples/java-source -world /path/to/world
```

它监听 `ws://127.0.0.1:2414/r2link`；`-dimension DIM-1` 选择下界，`-camera-every 30s` 定时把相机移回出生点。在查看器的连接面板填写这个地址即可。

```sh
go vet ./neomega-r2/go-link/... && go test ./neomega-r2/go-link/...
```
