package main

import (
	"math"
	geometry "neomega-view-utils/r2assets/internal/sourcegeometry"
	"testing"
)

// 跨格登记依赖裁切面积判断归属，裁切必须保留面积与 UV。
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

// 着色器由平面与对偶向量求 u、v，四个角必须分别落在 (0,0)、(1,0)、(1,1)、(0,1)。
func TestEncodeQuadRecoversCorners(t *testing.T) {
	q := geometry.Quad{
		Positions: [4]geometry.Vec3{{1.2, 0.1, 0.3}, {1.9, 0.6, 0.3}, {1.9, 0.6, 0.8}, {1.2, 0.1, 0.8}},
		Normal:    geometry.Vec3{-0.5, 0.7, 0},
	}
	reference, record := encodeQuad(q, [3]int{1, 0, 0})
	normal := decodeOctahedral(reference[0])
	d := float64(math.Float32frombits(reference[1]))
	want := [][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}}
	for i, p := range q.Positions {
		local := geometry.Vec3{p[0] - 1, p[1], p[2]}
		if plane := dot3(normal, local) - d; math.Abs(plane) > 1e-4 {
			t.Fatal("角点不在平面上", i, plane)
		}
		u := float64(record[0])*local[0] + float64(record[1])*local[1] + float64(record[2])*local[2] + float64(record[3])
		v := float64(record[4])*local[0] + float64(record[5])*local[1] + float64(record[6])*local[2] + float64(record[7])
		if math.Abs(u-want[i][0]) > 1e-5 || math.Abs(v-want[i][1]) > 1e-5 {
			t.Fatal("角点参数错误", i, u, v)
		}
	}
	if dot3(normal, q.Normal) <= 0 {
		t.Fatal("法线方向与源数据相反")
	}
}
