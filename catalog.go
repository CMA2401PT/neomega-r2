// Package r2 用方块状态索引和预生成模型描述场景，不生成区域网格。
package r2

import (
	"embed"
	"encoding/json"
)

//go:generate go run ./cmd/build-models
//go:embed assets/* web/*
var Files embed.FS

// Fragment 指向已裁切并平移到目标格内的模型，运行时无需回查原来的格子。
type Fragment struct {
	Offset [3]int `json:"offset"`
	Model  uint32 `json:"model"`
}

// Model 保存本格内的共享模型；Fragments 供加载器把越界片段放进目标格子。
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
	FarStates   map[string]uint32 `json:"farStates"`
	Models      []Model           `json:"models"`
	Statistics  map[string]int    `json:"statistics"`
	Unsupported []string          `json:"unsupported"`
}

func OpenCatalog() (*Catalog, error) {
	data, err := Files.ReadFile("assets/catalog.json")
	if err != nil {
		return nil, err
	}
	var catalog Catalog
	err = json.Unmarshal(data, &catalog)
	return &catalog, err
}
