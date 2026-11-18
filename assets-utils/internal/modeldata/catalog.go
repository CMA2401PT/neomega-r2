// Package modeldata 定义资源生成、材质合成与公开目录共用的模型格式。
package modeldata

import (
	"encoding/binary"
	"fmt"
	"maps"
	"slices"
)

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

// Catalog 是与贴图配套的模型表；材质包只改变模型的透明分类，不改变编号。
// Water 是静止水源的模型，渲染器用它的消面组识别水体。
// 方块状态到模型的映射单独保存在 states.bin，换材质包时不变。
type Catalog struct {
	Models      []Model        `json:"models"`
	Water       uint32         `json:"water"`
	Statistics  map[string]int `json:"statistics"`
	Unsupported []string       `json:"unsupported"`
}

// EncodeStates 把方块哈希到模型的表写成按哈希升序的 [hash, model] 小端 uint32 对，查询方可直接二分。
func EncodeStates(table map[uint32]uint32) []byte {
	data := make([]byte, 0, len(table)*8)
	for _, hash := range slices.Sorted(maps.Keys(table)) {
		data = binary.LittleEndian.AppendUint32(data, hash)
		data = binary.LittleEndian.AppendUint32(data, table[hash])
	}
	return data
}

// DecodeStates 读取 EncodeStates 的结果。
func DecodeStates(data []byte) (map[uint32]uint32, error) {
	if len(data)%8 != 0 {
		return nil, fmt.Errorf("状态表长度 %d 不是 8 的倍数", len(data))
	}
	table := make(map[uint32]uint32, len(data)/8)
	for i := 0; i < len(data); i += 8 {
		table[binary.LittleEndian.Uint32(data[i:])] = binary.LittleEndian.Uint32(data[i+4:])
	}
	return table, nil
}
