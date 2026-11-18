// 从旧资源读取器复制的输入格式，仅供离线生成模型表使用。
package geometry

import "neomega-view-utils/r2assets/internal/sourcegeometry/material"

type Vec3 [3]float64
type Vec2 [2]float64

type CullFace uint8

const (
	// 零值表示不可剔除，六方向编号与 Shape.Boundary 对齐。
	NoCullFace CullFace = iota
	West
	East
	Down
	Up
	North
	South
)

type Quad struct {
	Positions [4]Vec3
	Normal    Vec3
	// ShadeNormal 仅替换光照法线；零值表示使用几何法线。
	ShadeNormal Vec3
	UV          [4]Vec2
	Color       [3]float32
	Surface     material.Surface
	// 保留旧资源字段以解码输入；R2 不执行按区块剔面。
	CullFace CullFace
}
