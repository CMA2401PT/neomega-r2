package r2

import (
	"encoding/binary"
	"math"
	"testing"
)

// 一格可以同时拥有自身模型和来自不同方块的跨格片段，运行时只保存目标格内的索引。
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

// 每个格子登记的表面都必须与该格相交，否则射线在这一格永远命中不到它，说明登记表错位。
func TestGeneratedQuadsTouchTheirCell(t *testing.T) {
	references, err := Files.ReadFile("assets/quad-references.bin")
	if err != nil {
		t.Fatal(err)
	}
	records, err := Files.ReadFile("assets/quad-records.bin")
	if err != nil {
		t.Fatal(err)
	}
	word := func(data []byte, index int) uint32 { return binary.LittleEndian.Uint32(data[index*4:]) }
	float := func(index int) float64 { return float64(math.Float32frombits(word(records, index))) }
	for i := 0; i < len(references)/16; i++ {
		record := int(word(references, i*4+2)) * 28
		if record+28 > len(records)/4 {
			t.Fatalf("引用 %d 指向不存在的记录", i)
		}
		// 格子中心到平面的距离不超过半条对角线，平面才可能穿过格子。
		d := float64(math.Float32frombits(word(references, i*4+1)))
		packed := word(references, i*4)
		n := [3]float64{float64(int16(uint16(packed))) / 32767, float64(int16(uint16(packed>>16))) / 32767, 0}
		n[2] = 1 - math.Abs(n[0]) - math.Abs(n[1])
		if n[2] < 0 {
			x, y := n[0], n[1]
			n[0] = x - math.Copysign(-n[2], x)
			n[1] = y - math.Copysign(-n[2], y)
		}
		length := math.Sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2])
		center := (n[0]*.5 + n[1]*.5 + n[2]*.5) / length
		if math.IsNaN(d) || math.Abs(center-d) > math.Sqrt(3)/2+1e-4 || math.IsNaN(float(record)) {
			t.Fatalf("引用 %d 的平面没有穿过格子：d=%g", i, d)
		}
	}
}
