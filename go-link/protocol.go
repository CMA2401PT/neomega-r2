// Package r2link 是 R2 浏览器与世界数据源之间的协议：浏览器作为客户端连接数据源的 WebSocket，
// 按世界会话的需要订阅区域和近景方块实体，数据源回送压缩区域、原始 SNBT和控制消息。
// 消息格式见 README；Go 数据源用 Session 实现订阅、排队、取消与重发。
package r2link

// Version 是当前协议版本，hello 与 welcome 都要带上。
const Version = 3

// Scene 描述数据源提供的世界，显示在界面上。
type Scene struct {
	Name string `json:"name"`
}

// Camera 是相机位置（方块坐标）与朝向（弧度）；朝向省略时保留浏览器当前朝向。
// yaw 为 0 时看向 -Z，正 yaw 转向 +X；pitch 为正时向上看。
type Camera struct {
	Position [3]float64 `json:"position"`
	Yaw      *float64   `json:"yaw,omitempty"`
	Pitch    *float64   `json:"pitch,omitempty"`
}

// RegionPos 是 r2region 的水平坐标，每格横跨 8×8 个区块（128×128 方块）。
type RegionPos struct {
	X int `json:"x"`
	Z int `json:"z"`
}

// BlockEntityWant 要求区域内、以区块坐标 Center 为圆心 Radius 区块以内的方块实体。
type BlockEntityWant struct {
	X      int    `json:"x"`
	Z      int    `json:"z"`
	Center [3]int `json:"center"`
	Radius int    `json:"radius"`
}

// Hello 是浏览器连接后的第一条消息。
type Hello struct {
	Type     string `json:"type"`
	Protocol string `json:"protocol"`
	Version  int    `json:"version"`
}

// Welcome 回复 hello，描述世界和开场相机。
type Welcome struct {
	Type     string  `json:"type"`
	Protocol string  `json:"protocol"`
	Version  int     `json:"version"`
	Scene    Scene   `json:"scene"`
	Camera   *Camera `json:"camera,omitempty"`
}

// Want 是浏览器需要的区域与近景方块实体的增减；数据源据此维护需要的集合。
// BlockEntities.Add 里已经需要的区域再次出现，表示圆心或半径变了，需要重新提供。
type Want struct {
	Type    string     `json:"type"`
	Center  [2]float64 `json:"center"`
	Regions struct {
		Add    []RegionPos `json:"add"`
		Remove []RegionPos `json:"remove"`
	} `json:"regions"`
	BlockEntities struct {
		Add    []BlockEntityWant `json:"add"`
		Remove []RegionPos       `json:"remove"`
	} `json:"blockEntities"`
}

// RegionData 提交一个区域的方块，压缩数据在消息尾部；尾部为空表示区域没有方块。
// ClippedSections 是因超出可显示高度而省略的子区块数，用于诊断。
type RegionData struct {
	Type            string `json:"type"`
	X               int    `json:"x"`
	Z               int    `json:"z"`
	ClippedSections int    `json:"clippedSections,omitempty"`
}

// BlockEntity 保留方块实体的位置和完整 SNBT。
type BlockEntity struct {
	Position [3]int `json:"position"`
	SNBT     string `json:"snbt"`
}

// BlockEntities 同时发布同一近景内的两份快照。普通实体保留完整 Java SNBT，包括 Pos 和 UUID。
type BlockEntities struct {
	Type     string        `json:"type"`
	X        int           `json:"x"`
	Z        int           `json:"z"`
	Center   [3]int        `json:"center"`
	Radius   int           `json:"radius"`
	Entries  []BlockEntity `json:"entries"`
	Entities []string      `json:"entities,omitempty"`
}

// Failed 表示区域无法提供；浏览器把它标为失败，直到再次需要或收到新数据。
type Failed struct {
	Type    string `json:"type"`
	X       int    `json:"x"`
	Z       int    `json:"z"`
	Message string `json:"message"`
}

// Chunks 是区块占用表的请求与回复；回复的尾部是 ChunkIndex 的编码，Message 非空表示失败。
type Chunks struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}

// CameraMove 让浏览器把相机移到指定位置。
type CameraMove struct {
	Type   string `json:"type"`
	Camera Camera `json:"camera"`
}

// SceneChange 更新世界描述。
type SceneChange struct {
	Type  string `json:"type"`
	Scene Scene  `json:"scene"`
}

// Error 说明连接为什么结束，发送方随后关闭连接。
type Error struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}
