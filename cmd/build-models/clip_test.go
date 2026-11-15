package main

import (
	"math"
	geometry "neomega-r2/internal/sourcegeometry"
	"testing"
)

func polygonArea(polygon []vertex) float64 {
	area := 0.0
	for i := 1; i+1 < len(polygon); i++ {
		a, b, c := polygon[0].Position, polygon[i].Position, polygon[i+1].Position
		cross := [3]float64{}
		for j := range 3 {
			cross[j] = (b[(j+1)%3]-a[(j+1)%3])*(c[(j+2)%3]-a[(j+2)%3]) - (b[(j+2)%3]-a[(j+2)%3])*(c[(j+1)%3]-a[(j+1)%3])
		}
		area += math.Sqrt(cross[0]*cross[0]+cross[1]*cross[1]+cross[2]*cross[2]) / 2
	}
	return area
}

// 跨格裁切必须保留面积与 UV，不能为了独立求交把切口补成不属于原模型的面。
func TestClipPreservesSurfaceAndUV(t *testing.T) {
	input := []vertex{{Position: geometry.Vec3{-.5, .25, .1}, UV: geometry.Vec2{0, 0}}, {Position: geometry.Vec3{1.5, .25, .1}, UV: geometry.Vec2{1, 0}}, {Position: geometry.Vec3{1.5, .25, .9}, UV: geometry.Vec2{1, 1}}, {Position: geometry.Vec3{-.5, .25, .9}, UV: geometry.Vec2{0, 1}}}
	sum := 0.0
	for x := -1; x <= 1; x++ {
		polygon := clipToCell(input, [3]int{x, 0, 0})
		sum += polygonArea(polygon)
		for _, v := range polygon {
			if v.Position[0] < float64(x) || v.Position[0] > float64(x+1) || v.Position[1] != .25 {
				t.Fatal("裁片越界或生成了新表面", v)
			}
			want := (v.Position[0] + .5) / 2
			if math.Abs(v.UV[0]-want) > 1e-12 {
				t.Fatal("裁切改变 UV", v, want)
			}
		}
	}
	if math.Abs(sum-polygonArea(input)) > 1e-12 {
		t.Fatal("裁切丢失或重复表面面积", sum)
	}
}
