package main

import (
	"math"
	geometry "neomega-r2/internal/sourcegeometry"
	"neomega-r2/internal/sourcegeometry/material"
)

type vertex struct {
	Position geometry.Vec3
	UV       geometry.Vec2
}

// clipToCell 将表面多边形裁进一个格子，新增交点同时插值 UV，不为切口添加表面。
func clipToCell(polygon []vertex, cell [3]int) []vertex {
	for axis := range 3 {
		for side := range 2 {
			if len(polygon) == 0 {
				return nil
			}
			plane := float64(cell[axis] + side)
			distance := func(p vertex) float64 {
				d := p.Position[axis] - plane
				if side == 1 {
					return -d
				}
				return d
			}
			result := []vertex{}
			before := polygon[len(polygon)-1]
			previous := distance(before)
			for _, current := range polygon {
				next := distance(current)
				if (previous >= 0) != (next >= 0) {
					fraction := previous / (previous - next)
					var hit vertex
					for a := range 3 {
						hit.Position[a] = before.Position[a] + fraction*(current.Position[a]-before.Position[a])
					}
					hit.Position[axis] = plane
					for a := range 2 {
						hit.UV[a] = before.UV[a] + fraction*(current.UV[a]-before.UV[a])
					}
					result = append(result, hit)
				}
				if next >= 0 {
					result = append(result, current)
				}
				before = current
				previous = next
			}
			polygon = result
		}
	}
	return polygon
}

func hasArea(triangle [3]vertex) bool {
	var a, b geometry.Vec3
	for i := range 3 {
		a[i] = triangle[1].Position[i] - triangle[0].Position[i]
		b[i] = triangle[2].Position[i] - triangle[0].Position[i]
	}
	area := 0.0
	for i := range 3 {
		v := a[(i+1)%3]*b[(i+2)%3] - a[(i+2)%3]*b[(i+1)%3]
		area += v * v
	}
	return area > 1e-20
}

// encodeTriangle 用目标格子的局部坐标保存交点、UV 和表面属性，GPU 不需要知道片段来自哪个邻居。
func encodeTriangle(q geometry.Quad, triangle [3]vertex, cell [3]int) []float32 {
	a, b, c := triangle[0].Position, triangle[1].Position, triangle[2].Position
	uv0, uv1, uv2 := triangle[0].UV, triangle[1].UV, triangle[2].UV
	normal := q.Normal
	if q.ShadeNormal != (geometry.Vec3{}) {
		normal = q.ShadeNormal
	}
	flags := 0
	if q.Surface.DoubleSided {
		flags |= 1
	}
	if q.Surface.Unlit {
		flags |= 2
	}
	mode := 0
	switch q.Surface.Mode {
	case material.Cutout:
		mode = 1
	case material.Blend:
		mode = 2
	}
	for i := range 3 {
		a[i] -= float64(cell[i])
		b[i] -= float64(cell[i])
		c[i] -= float64(cell[i])
		if math.Abs(a[i]) < 1e-9 {
			a[i] = 0
		}
		if math.Abs(b[i]) < 1e-9 {
			b[i] = 0
		}
		if math.Abs(c[i]) < 1e-9 {
			c[i] = 0
		}
	}
	return []float32{
		float32(a[0]), float32(a[1]), float32(a[2]), float32(uv0[0]),
		float32(b[0] - a[0]), float32(b[1] - a[1]), float32(b[2] - a[2]), float32(uv0[1]),
		float32(c[0] - a[0]), float32(c[1] - a[1]), float32(c[2] - a[2]), float32(uv1[0]),
		float32(uv1[1]), float32(uv2[0]), float32(uv2[1]), float32(mode),
		float32(normal[0]), float32(normal[1]), float32(normal[2]), float32(flags),
		q.Surface.Region[0], q.Surface.Region[1], q.Surface.Region[2], q.Surface.Region[3] / float32(max(1, q.Surface.Frames)),
		q.Color[0], q.Color[1], q.Color[2], q.Surface.Opacity,
		float32(q.Normal[0]), float32(q.Normal[1]), float32(q.Normal[2]), 0,
	}
}
