// Package r2 用方块状态索引和预生成模型描述场景，不生成区域网格。
package r2

import (
	"embed"
	"encoding/json"
	"neomega-r2/internal/modeldata"
)

//go:generate go run ./cmd/build-models
//go:embed assets/* web/*
var Files embed.FS

// Fragment 指向模型伸进相邻格子的部分。
type Fragment = modeldata.Fragment

// Model 供场景准备与 GPU 上传共用，材质包可以改变其透明分类。
type Model = modeldata.Model

// Catalog 保存稳定的状态映射和当前材质下的共享模型。
type Catalog = modeldata.Catalog

func OpenCatalog() (*Catalog, error) {
	data, err := Files.ReadFile("assets/catalog.json")
	if err != nil {
		return nil, err
	}
	var catalog Catalog
	err = json.Unmarshal(data, &catalog)
	return &catalog, err
}
