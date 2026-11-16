// Package modeldata 定义资源生成、材质合成与公开目录共用的模型格式。
package modeldata

// Fragment 指向已平移到目标格局部坐标的模型，运行时无需回查原来的格子。
type Fragment struct {
	Offset [3]int `json:"offset"`
	Model  uint32 `json:"model"`
}

// Model 保存本格内的共享模型；Fragments 供加载器把越界片段放进目标格子。
// Kind：1 为完整立方体，2 为四边形模型，3 为贴图带洞的完整立方体（树叶、格栅）。
// 镂空立方体的每个面都可能透光，因此不能和相邻同类方块合并成均匀节点。
type Model struct {
	Kind      uint32     `json:"kind"`
	Offset    uint32     `json:"offset"`
	Count     uint32     `json:"count"`
	Group     uint32     `json:"group"`
	Fragments []Fragment `json:"fragments,omitempty"`
}

// Catalog 在进程启动时读取一次，区域构建只查询 States 和 Fragments。
type Catalog struct {
	States      map[string]uint32 `json:"states"`
	Models      []Model           `json:"models"`
	Statistics  map[string]int    `json:"statistics"`
	Unsupported []string          `json:"unsupported"`
}
