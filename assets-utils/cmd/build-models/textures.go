package main

import (
	"encoding/json"
	"math"
	geometry "neomega-view-utils/r2assets/internal/sourcegeometry"
	"neomega-view-utils/r2assets/internal/texturepack"
)

// textureRecipes 用名字参与去重，让像素相同但名字不同的贴图仍能分别替换。
type textureRecipes struct {
	manifest texturepack.Manifest
	ids      map[string]int
}

// registerTexture 将原版首帧区域与名字一起保存，回退时无需依赖外部图集索引。
func (r *textureRecipes) registerTexture(q geometry.Quad) {
	region := q.Surface.Region
	region[3] /= float32(max(1, q.Surface.Frames))
	r.manifest.Textures[q.Surface.Texture] = region
}

// cube 生成六面贴图描述：单层保留原始 UV，多层把方向与染色写进配方供运行时烘焙。
func (r *textureRecipes) cube(m cubeMaterial, quads []geometry.Quad) [6][16]float32 {
	var faces [6][]geometry.Quad
	for _, q := range quads {
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
		faces[side] = append(faces[side], q)
	}
	var result [6][16]float32
	layered := len(quads) > 6
	for face, qs := range faces {
		values, representative := m.Textures[face], m.Faces[face]
		encoded := [16]float32{
			0, 0, 0, 0, 0, 0, -1, values[11],
			linear(values[6]), linear(values[7]), linear(values[8]), values[10],
			float32(representative[0]) / 255,
			float32(representative[1]) / 255,
			float32(representative[2]) / 255,
			float32(representative[3]) / 255,
		}
		var parts []texturepack.Part
		for _, q := range qs {
			r.registerTexture(q)
			axis := face / 2
			// 着色器 across 的二维轴顺序为 yz、zx、xy。
			axes := [3][2]int{{1, 2}, {2, 0}, {0, 1}}[axis]
			var uv [2][2]geometry.Vec2
			for i, p := range q.Positions {
				uv[int(math.Round(p[axes[0]]))][int(math.Round(p[axes[1]]))] = q.UV[i]
			}
			transform := [6]float64{
				uv[0][0][0], uv[0][0][1],
				uv[1][0][0] - uv[0][0][0], uv[1][0][1] - uv[0][0][1],
				uv[0][1][0] - uv[0][0][0], uv[0][1][1] - uv[0][0][1],
			}
			part := texturepack.Part{
				Texture: q.Surface.Texture,
				UV:      [6]float64{0, 0, 1, 0, 0, 1},
				Tint:    [3]float32{1, 1, 1},
			}
			if layered {
				part.UV = transform
				part.Tint = q.Color
				part.Cutout = q.Surface.Mode == "cutout"
			} else {
				for i := range 6 {
					encoded[i] = float32(transform[i])
				}
			}
			parts = append(parts, part)
		}
		if layered {
			copy(encoded[:6], []float32{0, 0, 1, 0, 0, 1})
		}
		key, _ := json.Marshal(parts)
		id, ok := r.ids[string(key)]
		if !ok {
			id = len(r.manifest.Layers)
			r.ids[string(key)] = id
			r.manifest.Layers = append(r.manifest.Layers, parts)
		}
		encoded[6] = float32(id)
		result[face] = encoded
	}
	return result
}

// linear 把旧材质表的 sRGB 染色转为 GPU 与合成配方使用的线性染色。
func linear(c float32) float32 {
	v := float64(c)
	if v <= .04045 {
		return float32(v / 12.92)
	}
	return float32(math.Pow((v+.055)/1.055, 2.4))
}
