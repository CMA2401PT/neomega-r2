package r2

import (
	"testing"

	"neomega-view-utils/r2assets"
)

// 一格可以同时拥有自身模型和来自不同方块的跨格片段，运行时只保存目标格内的索引。
func TestFragmentsShareCellWithoutOwnerLookup(t *testing.T) {
	catalog := &r2assets.Catalog{Models: []r2assets.Model{{}, {Kind: 2, Fragments: []r2assets.Fragment{{Offset: [3]int{1, 0, 0}, Model: 3}}}, {Kind: 2, Fragments: []r2assets.Fragment{{Offset: [3]int{-1, 0, 0}, Model: 4}}}, {Kind: 2}, {Kind: 2}, {Kind: 1}}}
	grid := NewGrid([3]int{4, 2, 2})
	grid.Set([3]int{0, 0, 0}, 1)
	grid.Set([3]int{2, 0, 0}, 2)
	grid.Set([3]int{1, 0, 0}, 5)
	if count := grid.PlaceFragments(catalog); count != 2 {
		t.Fatal(count)
	}
	index := grid.index([3]int{1, 0, 0})
	if grid.Cells[index] != 5 {
		t.Fatal("片段覆盖了本格模型")
	}
	start := grid.Cells[index+1]
	if grid.Parts[start] != 2 || grid.Parts[start+1] != 3 || grid.Parts[start+2] != 4 {
		t.Fatal(grid.Parts)
	}
}
