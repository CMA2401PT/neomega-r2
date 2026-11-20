package main

import (
	"math"
	geometry "neomega-view-utils/r2assets/internal/sourcegeometry"
	"neomega-view-utils/r2assets/internal/sourcegeometry/material"
)

type vertex struct {
	Position geometry.Vec3
	UV       geometry.Vec2
}

// snapToCellBoundaries 消除模型旋转后留在整数格面附近的舍入误差。
// 在计算包围盒前对齐，使格子归属、面积裁切和最终平面编码使用同一组顶点。
func snapToCellBoundaries(quads []geometry.Quad) {
	const tolerance = 1e-12 // 单位为格；只对齐靠近整数的坐标分量。
	for i := range quads {
		for j := range quads[i].Positions {
			position := &quads[i].Positions[j]
			for axis, value := range position {
				boundary := math.Round(value)
				if math.Abs(value-boundary) <= tolerance {
					position[axis] = boundary
				}
			}
		}
	}
}

// clipToCell 将表面多边形裁进一个格子，用来判断原表面是否伸进该格。
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

func polygonArea(polygon []vertex) float64 {
	area := 0.0
	for i := 1; i+1 < len(polygon); i++ {
		a, b, c := polygon[0].Position, polygon[i].Position, polygon[i+1].Position
		cross := cross3(sub3(b, a), sub3(c, a))
		area += math.Sqrt(dot3(cross, cross)) / 2
	}
	return area
}

// overlapsCell 判断四边形是否有面积落在格子内；只用于决定登记到哪些格子，表面本身不裁切。
func overlapsCell(q geometry.Quad, cell [3]int) bool {
	polygon := make([]vertex, 4)
	for i := range 4 {
		polygon[i] = vertex{Position: q.Positions[i], UV: q.UV[i]}
	}
	return polygonArea(clipToCell(polygon, cell)) > 1e-10
}

func sub3(a, b geometry.Vec3) geometry.Vec3 {
	return geometry.Vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]}
}
func dot3(a, b geometry.Vec3) float64 { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func cross3(a, b geometry.Vec3) geometry.Vec3 {
	return geometry.Vec3{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}
func scale3(a geometry.Vec3, s float64) geometry.Vec3 {
	return geometry.Vec3{a[0] * s, a[1] * s, a[2] * s}
}

// quadRecord 是着色器命中一个面之后才读取的部分，按内容去重后由多个引用共享。
// 布局（7 个 vec4）：U 与偏移、V 与偏移、UV 原点与 u 方向、v 方向与模式标志、图集区域、色调与不透明度、光照法线。
type quadRecord [28]float32

// quadReference 是逐格遍历时先读取的部分：只靠它就能求出与平面的交点并排除绝大多数面。
// 布局：八面体编码的单位法线（两个 snorm16）、平面常数 d 的位模式、记录编号、双面标志。
type quadReference [4]uint32

// encodeQuad 把四边形平移到目标格子的局部坐标。
// 平行四边形上的点 p = P0 + u·E1 + v·E2，用对偶向量 U、V 可以直接由 p 算出 u、v，
// 因此着色器不需要按格裁切：只接受落在当前格射线区间内的交点即可。
func encodeQuad(q geometry.Quad, cell [3]int) (quadReference, quadRecord) {
	offset := geometry.Vec3{float64(cell[0]), float64(cell[1]), float64(cell[2])}
	p0 := sub3(q.Positions[0], offset)
	e1 := sub3(q.Positions[1], q.Positions[0])
	e2 := sub3(q.Positions[3], q.Positions[0])
	n := cross3(e1, e2)
	length2 := dot3(n, n)
	u := scale3(cross3(e2, n), 1/length2)
	v := scale3(cross3(n, e1), 1/length2)
	unit := scale3(n, 1/math.Sqrt(length2))
	// 背面剔除沿用源数据的面法线方向。
	if dot3(unit, q.Normal) < 0 {
		unit = scale3(unit, -1)
	}
	packed := octahedral(unit)
	decoded := decodeOctahedral(packed)
	shade := q.Normal
	if q.ShadeNormal != (geometry.Vec3{}) {
		shade = q.ShadeNormal
	}
	flags := uint32(0)
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
	uv0, uv1, uv3 := q.UV[0], q.UV[1], q.UV[3]
	reference := quadReference{
		packed,
		// 平面常数用解码后的法线计算，保证 GPU 上的平面仍穿过 P0。
		math.Float32bits(float32(dot3(decoded, p0))),
		0,
		flags & 1,
	}
	record := quadRecord{
		float32(u[0]), float32(u[1]), float32(u[2]), float32(-dot3(u, p0)),
		float32(v[0]), float32(v[1]), float32(v[2]), float32(-dot3(v, p0)),
		float32(uv0[0]), float32(uv0[1]), float32(uv1[0] - uv0[0]), float32(uv1[1] - uv0[1]),
		float32(uv3[0] - uv0[0]), float32(uv3[1] - uv0[1]), float32(mode), float32(flags),
		q.Surface.Region[0], q.Surface.Region[1], q.Surface.Region[2], q.Surface.Region[3] / float32(max(1, q.Surface.Frames)),
		q.Color[0], q.Color[1], q.Color[2], q.Surface.Opacity,
		float32(shade[0]), float32(shade[1]), float32(shade[2]), 0,
	}
	return reference, record
}

// octahedral 把单位向量压成两个 snorm16，与 GLSL 的 unpackSnorm2x16 对应。
func octahedral(n geometry.Vec3) uint32 {
	sum := math.Abs(n[0]) + math.Abs(n[1]) + math.Abs(n[2])
	x, y := n[0]/sum, n[1]/sum
	if n[2] < 0 {
		x, y = (1-math.Abs(y))*sign(x), (1-math.Abs(x))*sign(y)
	}
	encode := func(f float64) uint32 {
		return uint32(uint16(int16(math.Round(math.Max(-1, math.Min(1, f)) * 32767))))
	}
	return encode(x) | encode(y)<<16
}

// decodeOctahedral 与着色器的解码一致，用于让平面常数和 GPU 使用同一条法线。
func decodeOctahedral(packed uint32) geometry.Vec3 {
	decode := func(bits uint32) float64 { return math.Max(-1, float64(int16(uint16(bits)))/32767) }
	n := geometry.Vec3{decode(packed), decode(packed >> 16), 0}
	n[2] = 1 - math.Abs(n[0]) - math.Abs(n[1])
	t := math.Max(-n[2], 0)
	n[0] -= t * sign(n[0])
	n[1] -= t * sign(n[1])
	return scale3(n, 1/math.Sqrt(dot3(n, n)))
}

func sign(f float64) float64 {
	if f < 0 {
		return -1
	}
	return 1
}
