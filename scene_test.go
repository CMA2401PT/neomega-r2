package r2

import (
	"encoding/binary"
	"math"
	"testing"
)

// 一格可以同时拥有自身模型和来自不同方块的预裁片，运行时只保存目标格内的索引。
func TestFragmentsShareCellWithoutOwnerLookup(t *testing.T) {
	catalog := &Catalog{Models: []Model{{}, {Kind: 2, Fragments: []Fragment{{Offset: [3]int{1, 0, 0}, Model: 3}}}, {Kind: 2, Fragments: []Fragment{{Offset: [3]int{-1, 0, 0}, Model: 4}}}, {Kind: 2}, {Kind: 2}, {Kind: 1}}}
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

// 全部生成的通用表面都必须位于单位格内，确保着色器无需检查相邻格子。
func TestGeneratedTrianglesStayInCell(t *testing.T) {
	data, err := Files.ReadFile("assets/triangles.bin")
	if err != nil {
		t.Fatal(err)
	}
	read := func(offset int) float64 {
		return float64(math.Float32frombits(binary.LittleEndian.Uint32(data[offset*4:])))
	}
	for offset := 0; offset < len(data)/4; offset += 32 {
		for axis := range 3 {
			a := read(offset + axis)
			for _, v := range []float64{a, a + read(offset+4+axis), a + read(offset+8+axis)} {
				if math.IsNaN(v) || v < -1e-6 || v > 1+1e-6 {
					t.Fatalf("三角形 %d 越出格子：%g", offset/32, v)
				}
			}
		}
	}
}
