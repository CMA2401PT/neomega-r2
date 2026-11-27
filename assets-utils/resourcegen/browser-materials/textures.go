package browsermaterials

import (
	"encoding/json"
	"math"
	geometry "neomega-view-utils/r2assets/geometry"
	cubematerials "neomega-view-utils/r2assets/resourcegen/cube-materials"
)

// Part 保留配方中的名字和采样方向，覆盖层换图时才能连同染色一起重建。
type Part struct {
	Texture string     `json:"texture"`
	UV      [6]float64 `json:"uv"`
	Tint    [3]float32 `json:"tint"`
	Cutout  bool       `json:"cutout,omitempty"`
}

// Manifest 保留原版回退区域、立方体合成配方和四边形记录对应的贴图名字。
type Manifest struct {
	Textures map[string][4]float32 `json:"textures"`
	Layers   [][]Part              `json:"layers"`
	Quads    []string              `json:"quads"`
}

// textureRecipes 用名字参与去重，让像素相同但名字不同的贴图仍能分别替换。
type textureRecipes struct {
	manifest Manifest
	ids      map[string]int
}

// registerTexture 将原版首帧区域与名字一起保存，回退时无需依赖外部图集索引。
func (r *textureRecipes) registerTexture(q geometry.Quad) {
	region := q.Surface.Region
	region[3] /= float32(max(1, q.Surface.Frames))
	r.manifest.Textures[q.Surface.Texture] = region
}

// cube 生成六面贴图描述：单层保留原始 UV，多层把方向与染色写进配方供运行时烘焙。
func (r *textureRecipes) cube(m cubematerials.Material, quads []geometry.Quad) [6][16]float32 {
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
		values := m.Faces[face]
		representative := values.Color
		encoded := [16]float32{
			0, 0, 0, 0, 0, 0, -1, float32(values.Flags),
			linear(values.Tint[0]), linear(values.Tint[1]), linear(values.Tint[2]), values.Opacity,
			float32(representative[0]) / 255,
			float32(representative[1]) / 255,
			float32(representative[2]) / 255,
			float32(representative[3]) / 255,
		}
		var parts []Part
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
			part := Part{
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
