// Package cubematerials 从目标 Java 状态、几何、图集和俯视颜色中提取 R2 的完整立方体材质。
package cubematerials

import (
	"fmt"
	"image"
	"image/color"
	"iter"
	"math"
	"neomega-blocks/ir"
	"neomega-view-utils/r2assets/geometry"
	"neomega-view-utils/r2assets/geometry/material"
	"neomega-view-utils/r2assets/topcolor"
)

type materialExtractor struct {
	tables *geometry.Tables[uint32]
	atlas  image.Image
	colors topcolor.Table
}

// Generate 只登记可用六面纹理表示的完整立方体，其他状态由 R2 走通用模型路径。
func Generate(states iter.Seq[ir.IRBlock], tables *geometry.Tables[uint32], atlas image.Image, colors topcolor.Table) (map[uint32]Material, error) {
	source := materialExtractor{tables: tables, atlas: atlas, colors: colors}
	result := make(map[uint32]Material)
	for state := range states {
		if m, ok := source.material(state); ok {
			hash := state.Hash()
			if _, exists := result[hash]; exists {
				return nil, fmt.Errorf("重复的立方体状态哈希 %d：%s", hash, state)
			}
			result[hash] = m
		}
	}
	return result, nil
}

// Material 将已有模型压成完整立方体；镂空贴图按实心颜色处理，仅 Blend 材质保留整体透明度。
func (s *materialExtractor) material(block ir.IRBlock) (Material, bool) {
	var result Material
	rgb, known := s.colors[block.Hash()]
	if !known {
		rgb = 0x808080
	}
	for i := range 6 {
		result.Faces[i].Color = [4]byte{byte(rgb >> 16), byte(rgb >> 8), byte(rgb), 255}
	}
	ids, exists := s.tables.Index[block.Hash()]
	if !exists {
		return result, false
	}
	var sums [6][4]float64
	var weights [6]float64
	var opaque [6]bool
	for _, id := range ids {
		shape := s.tables.Shapes[id]
		if shape.CullGroup != 0 {
			result.Group = shape.CullGroup
		}
		for _, q := range shape.Quads {
			axis := 0
			for a := 1; a < 3; a++ {
				if math.Abs(q.Normal[a]) > math.Abs(q.Normal[axis]) {
					axis = a
				}
			}
			side := axis * 2
			if q.Normal[axis] > 0 {
				side++
			}
			// 投影面积是完整方块某一面的颜色权重，旋转后的模型自然使用世界面方向。
			a, b := (axis+1)%3, (axis+2)%3
			area := 0.0
			for i, p := range q.Positions {
				next := q.Positions[(i+1)%4]
				area += p[a]*next[b] - next[a]*p[b]
			}
			area = math.Abs(area) / 2
			if area < 1e-8 {
				continue
			}
			sample, ok := s.sample(q)
			if !ok {
				continue
			}
			for c := range 4 {
				sums[side][c] += sample[c] * area
			}
			weights[side] += area
			if q.Surface.Mode != material.Blend {
				opaque[side] = true
			}
		}
	}
	for side := range 6 {
		if weights[side] == 0 {
			continue
		}
		for c := range 4 {
			result.Faces[side].Color[c] = byte(math.Round(sums[side][c] / weights[side]))
		}
		if opaque[side] {
			result.Faces[side].Color[3] = 255
		}
	}
	// 只有六个完整边界面的模型才采用贴图，避免给花、栅栏等简化体素套错表面。

	var quads []geometry.Quad
	for _, id := range ids {
		// 流体用资源表中已有的满高度模型，仍只改变表面，不改变液面几何。
		if full, ok := s.tables.FullHeight[id]; ok {
			id = full
		}
		quads = append(quads, s.tables.Shapes[id].Quads...)
	}
	if len(quads) == 6 {
		var present [6]bool
		valid := true
		for _, q := range quads {
			r, ok := geometry.InspectRectangle(q.Positions)
			if !ok || r.Side() < 0 || !geometry.Close(r.Min[0], 0) || !geometry.Close(r.Min[1], 0) || !geometry.Close(r.Max[0], 1) || !geometry.Close(r.Max[1], 1) || present[r.Side()] {
				valid = false
				break
			}
			side := r.Side()
			present[side] = true
			face := &result.Faces[side]
			for c, tint := range q.Color {
				if tint <= 0.0031308 {
					face.Tint[c] = tint * 12.92
				} else {
					face.Tint[c] = float32(1.055*math.Pow(float64(tint), 1/2.4) - 0.055)
				}
			}
			face.Opacity = q.Surface.Opacity
			if q.Surface.Mode == material.Blend {
				face.Flags = 1
			}
			if q.Surface.Unlit {
				face.Flags += 2
			}
		}
		if valid {
			return result, true
		}
	}
	// 多层完整面由 R2 按四边形重建纹理，染色已经包含在各层配方里。
	if s.layeredCube(ids) {
		for i := range result.Faces {
			result.Faces[i].Tint = [3]float32{1, 1, 1}
			result.Faces[i].Opacity = 1
			result.Faces[i].Flags = 0
		}
		return result, true
	}
	return Material{}, false
}

func (s *materialExtractor) sample(q geometry.Quad) ([4]float64, bool) {
	lo, hi := q.UV[0], q.UV[0]
	for _, uv := range q.UV {
		for a := range 2 {
			lo[a] = min(lo[a], uv[a])
			hi[a] = max(hi[a], uv[a])
		}
	}
	bounds := s.atlas.Bounds()
	w, h := float64(bounds.Dx()), float64(bounds.Dy())
	region := q.Surface.Region
	frameH := float64(region[3]) / float64(max(1, q.Surface.Frames))
	rect := image.Rect(int(math.Floor((float64(region[0])+lo[0]*float64(region[2]))*w)), int(math.Floor((float64(region[1])+lo[1]*frameH)*h)), int(math.Ceil((float64(region[0])+hi[0]*float64(region[2]))*w)), int(math.Ceil((float64(region[1])+hi[1]*frameH)*h))).Intersect(bounds)
	var sum [3]float64
	alpha := 0.0
	count := 0
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			pixel := color.NRGBAModel.Convert(s.atlas.At(x, y)).(color.NRGBA)
			alpha += float64(pixel.A)
			count++
			for c, value := range [3]byte{pixel.R, pixel.G, pixel.B} {
				sum[c] += float64(value) * float64(pixel.A)
			}
		}
	}
	if count == 0 || alpha == 0 {
		return [4]float64{}, false
	}
	var result [4]float64
	for c := range 3 {
		tint := float64(q.Color[c])
		if tint <= 0.0031308 {
			tint *= 12.92
		} else {
			tint = 1.055*math.Pow(tint, 1/2.4) - 0.055
		}
		result[c] = max(0, min(255, sum[c]/alpha*tint))
	}
	result[3] = 255
	if q.Surface.Mode == material.Blend {
		result[3] = max(0, min(255, alpha/float64(count)*float64(q.Surface.Opacity)))
	}
	return result, true
}

func (s *materialExtractor) layeredCube(ids []geometry.ModelID) bool {
	var layers [6][]geometry.Quad
	count := 0
	for _, id := range ids {
		for _, q := range s.tables.Shapes[id].Quads {
			// 模型旋转会留下约 1e-16 的误差，边界范围与平面检查使用同一几何容差。
			r, ok := geometry.InspectRectangle(q.Positions)
			if !ok || r.Side() < 0 || !geometry.Close(r.Min[0], 0) || !geometry.Close(r.Min[1], 0) || !geometry.Close(r.Max[0], 1) || !geometry.Close(r.Max[1], 1) || q.Surface.Mode == material.Blend {
				return false
			}
			layers[r.Side()] = append(layers[r.Side()], q)
			count++
		}
	}
	if count <= 6 {
		return false
	}
	for _, quads := range layers {
		if len(quads) == 0 || !material.FullyOpaque(quads[0].Surface) {
			return false
		}
	}
	return true
}
