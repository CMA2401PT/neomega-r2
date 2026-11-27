// Package solidfaces 从方块几何中提取邻接修复需要的六面实心位。
package solidfaces

import (
	"neomega-view-utils/fixer/solidtable"
	"neomega-view-utils/r2assets/geometry"
)

// Generate 将同一状态的所有部件合并，再判断它们能否共同覆盖整个边界面。
func Generate(tables *geometry.Tables[uint32]) solidtable.Table {
	result := make(solidtable.Table, len(tables.Index))
	for hash, ids := range tables.Index {
		var quads []geometry.Quad
		for _, id := range ids {
			quads = append(quads, tables.Shapes[id].Quads...)
		}
		var faces uint8
		for side, name := range [...]string{"west", "east", "down", "up", "north", "south"} {
			if geometry.OpaqueBoundary(quads, name) {
				faces |= 1 << side
			}
		}
		result[hash] = faces
	}
	return result
}
