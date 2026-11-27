// Package r2assets 提供 R2 渲染核心使用的资源包：材质归档与模型目录读取。
// 渲染核心只依赖资源包的文件格式，不导入本包；宿主用本包生成或提供资源。
package r2assets

import (
	"encoding/json"

	"neomega-view-utils/r2assets/internal/modeldata"
)

// Fragment 指向模型伸进相邻格子的部分。
type Fragment = modeldata.Fragment

// Model 供场景准备与 GPU 上传共用，材质包可以改变其透明分类。
type Model = modeldata.Model

// Catalog 保存稳定的状态映射和当前材质下的共享模型。
type Catalog = modeldata.Catalog

func (a *Archive) OpenCatalog() (*Catalog, error) {
	data, err := a.ReadFile("assets/catalog.json")
	if err != nil {
		return nil, err
	}
	var catalog Catalog
	err = json.Unmarshal(data, &catalog)
	return &catalog, err
}

// OpenStates 读取方块哈希到模型的表；数据源发送的调色板条目按此表解释，表外的哈希画成空气。
func (a *Archive) OpenStates() (map[uint32]uint32, error) {
	data, err := a.ReadFile("assets/states.bin")
	if err != nil {
		return nil, err
	}
	return modeldata.DecodeStates(data)
}
